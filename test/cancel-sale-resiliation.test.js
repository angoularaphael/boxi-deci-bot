'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  resolveCancelNeverVoid,
  isResilierTileLabel,
  motifValueChosen,
  resiliationCountsAsDone,
  isAppliquerQuitterLabel,
} = require('../bot/cancel-sale');

test('toute résiliation → neverVoid (jamais Annuler la vente)', () => {
  assert.equal(resolveCancelNeverVoid({}, 'resiliation_web'), true);
  assert.equal(resolveCancelNeverVoid({}, ''), true);
  assert.equal(resolveCancelNeverVoid({ pendingOnly: true }, 'resiliation_web'), true);
  assert.equal(resolveCancelNeverVoid({ forceVoid: true }, 'resiliation_web'), true);
  assert.equal(resolveCancelNeverVoid({ forceVoid: true }, 'change_badge_policy'), true);
  assert.equal(resolveCancelNeverVoid({}, 'change_replace_existing'), true);
  assert.equal(resolveCancelNeverVoid({}, 'echeancier_impaye'), true);
});

test('cancel-sale.js ne clique plus Annuler la vente', () => {
  const src = fs.readFileSync(path.join(__dirname, '../bot/cancel-sale.js'), 'utf8');
  assert.doesNotMatch(src, /clickActionTile\(page, \[\s*\/\^Annuler la vente/);
  assert.doesNotMatch(src, /logInfo\('Clic Annuler la vente'/);
  assert.doesNotMatch(src, /vente annulée/);
  assert.match(src, /Clic Annuler la vente interdit — Résilier uniquement/);
  assert.match(src, /if \(\/annuler la vente\/i\.test\(t\) \|\| \/annuler la vente\/i\.test\(aria\)\) continue/);
  assert.doesNotMatch(src, /forceVoid/);
  assert.doesNotMatch(src, /voidPendingSaleIfPossible|confirmAnnulationModal|clickAnnulationRefundMode|shouldVoidSale/);
  assert.match(src, /clickActionTile\(page, \[\/\^Résilier\$\/i/);
});

test('tuile Résilier : libellé contrat accepté, mail et annulation refusés', () => {
  assert.equal(isResilierTileLabel('Résilier'), true);
  assert.equal(isResilierTileLabel('Résilier le contrat'), true);
  assert.equal(isResilierTileLabel('Résilier\nÀ la date choisie'), true);
  assert.equal(isResilierTileLabel('Annuler la vente'), false);
  assert.equal(isResilierTileLabel('Résilier le contrat et envoyer le mail'), false);
  assert.equal(isResilierTileLabel('Envoyer un e-mail'), false);
});

test('motif « Choisir » ne compte pas comme sélectionné', () => {
  assert.equal(motifValueChosen(''), false);
  assert.equal(motifValueChosen('Choisir'), false);
  assert.equal(motifValueChosen('Ne souhaite pas reconduire'), true);
});

test('bouton Appliquer désactivé + mail absent = pas résilié', () => {
  assert.equal(resiliationCountsAsDone({ applyEnabled: false, confirmSeen: false }), false);
  assert.equal(resiliationCountsAsDone({ applyEnabled: true, confirmSeen: false }), false);
  assert.equal(resiliationCountsAsDone({ applyEnabled: false, confirmSeen: true }), false);
  assert.equal(resiliationCountsAsDone({ applyEnabled: true, confirmSeen: true }), true);
  assert.equal(isAppliquerQuitterLabel('Appliquer et Quitter'), true);
});

test('le clic Appliquer ne retire plus l’attribut disabled', () => {
  const src = fs.readFileSync(path.join(__dirname, '../bot/cancel-sale.js'), 'utf8');
  assert.doesNotMatch(src, /hit\.disabled = false/);
  assert.doesNotMatch(src, /removeAttribute\('disabled'\)/);
  assert.match(src, /reason: 'appliquer_disabled'/);
});

test('processCancelJob boutique → neverVoid: true', () => {
  const src = fs.readFileSync(path.join(__dirname, '../bot/index.js'), 'utf8');
  assert.match(src, /cancelSale\(page, memberId, \{[\s\S]*neverVoid:\s*true/);
});

test('une nouvelle vente résilie l’ancien abo, elle ne l’annule pas', () => {
  const sale = fs.readFileSync(path.join(__dirname, '../bot/sale.js'), 'utf8');
  assert.match(sale, /Ancien abo à résilier avant nouvelle vente/);
  assert.match(sale, /change_replace_existing[\s\S]{0,80}neverVoid:\s*true/);
  assert.match(sale, /change_badge_policy[\s\S]{0,80}neverVoid:\s*true/);
  assert.match(sale, /Badges en trop à résilier — aucune vente annulée/);
  assert.doesNotMatch(sale, /forceVoid:\s*true/);
  assert.doesNotMatch(sale, /Annuler la vente/);
});
