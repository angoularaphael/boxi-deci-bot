'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('toute résiliation → neverVoid (jamais Annuler la vente)', () => {
  const src = fs.readFileSync(path.join(__dirname, '../bot/cancel-sale.js'), 'utf8');
  assert.match(src, /function resolveCancelNeverVoid\([\s\S]*?\{\s*return true;\s*\}/);
  assert.doesNotMatch(src, /voidPendingSaleIfPossible|confirmAnnulationModal|clickAnnulationRefundMode|shouldVoidSale/);
});

test('cancel-sale.js ne clique plus Annuler la vente', () => {
  const src = fs.readFileSync(path.join(__dirname, '../bot/cancel-sale.js'), 'utf8');
  assert.doesNotMatch(src, /clickActionTile\(page, \[\s*\/\^Annuler la vente/);
  assert.doesNotMatch(src, /logInfo\('Clic Annuler la vente'/);
  assert.doesNotMatch(src, /vente annulée/);
  assert.match(src, /Clic Annuler la vente interdit — Résilier uniquement/);
  assert.match(src, /if \(\/annuler la vente\/i\.test\(t\)\) continue/);
  assert.doesNotMatch(src, /forceVoid/);
  assert.doesNotMatch(src, /voidPendingSaleIfPossible|confirmAnnulationModal|clickAnnulationRefundMode|shouldVoidSale/);
  assert.match(src, /clickActionTile\(page, \[\/\^Résilier\$\/i/);
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
