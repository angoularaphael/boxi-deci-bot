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
    assert.match(wallet, /existingMeta\.rum && ibanAlready && !needsSave/);
    assert.match(wallet, /if \(await ribMandateNeedsSave\(ribCtx\)\) return false/);
  });
});
