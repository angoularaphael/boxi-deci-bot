'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const sale = fs.readFileSync(path.join(__dirname, '../bot/sale.js'), 'utf8');
const wallet = fs.readFileSync(path.join(__dirname, '../bot/wallet.js'), 'utf8');

describe('enregistrement RIB a la vente', () => {
  it('ne clique plus Ignorer quand le prelevement demande un RIB', () => {
    assert.match(sale, /async function registerSaleRibIfAsked/);
    assert.match(sale, /await registerSaleRibIfAsked\(page, productConfig\)/);
    assert.match(sale, /Enregistrer le RIB/);
    assert.doesNotMatch(sale, /étape RIB ignorée/);
  });

  it('ne considere pas un IBAN seulement affiche comme un mandat enregistre', () => {
    assert.match(wallet, /async function ribMandateNeedsSave/);
    assert.match(wallet, /RIB visible mais mandat non enregistré/);
    assert.match(wallet, /existingMeta\.rum && ibanAlready && isLikelyBic\(existingMeta\.bic\) && !needsSave/);
    assert.match(wallet, /hasIban && !hasBic\) return true/);
    assert.match(wallet, /Mandat sans BIC — RIB considéré incomplet/);
    assert.match(wallet, /memberAsksToRegisterRib/);
    assert.match(wallet, /BIC mandat introuvable après saisie IBAN/);
    assert.doesNotMatch(wallet, /!afterNeed \|\| posted\?\.ok/);
  });

  it('la carte nextgen se facture sans jeter Cloturer la note', () => {
    assert.doesNotMatch(sale, /throw new Error\('Badge — « Clôturer la note » introuvable'\)/);
    assert.match(sale, /Facturer/);
    assert.match(sale, /Clôturer la note » introuvable, tentative Terminer/);
  });

  it('n ignore pas un dialogue qui demande d enregistrer le RIB', () => {
    assert.match(sale, /async function pageAsksToRegisterRib/);
    assert.match(sale, /if \(!ribAsked\)/);
  });
});
