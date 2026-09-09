'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  classifyMemberContracts,
  leftoverBlocksNewSale,
  isStaleOrInactiveAbo,
  pickKeepSaleId,
  parisDay,
} = require('../lib/replace-existing-abo');

const offre29 = {
  id: 'dp-104',
  name: 'OFFRE A 29€',
  deciplus_product_search: 'OFFRE A 29',
};
const opts = { isPendingOrFuture: (label) => /en attente/i.test(String(label || '')) };

test('contrat expiré / résilié ne bloque pas une nouvelle vente', () => {
  const expired = {
    idc: '40919',
    isBadge: false,
    label: 'BOXE EDUCATIVE Contrat n°C2026-040919 vendu le 28/01/2026 28/01/2026 27/06/2026 Expiré',
  };
  const live = {
    idc: '1',
    isBadge: false,
    label: '44,99€/4 SEMAINES SANS ENGAGEMENT CONTRAT N°C2026-040925 132 jours restants',
  };
  assert.equal(isStaleOrInactiveAbo(expired.label), true);
  assert.equal(leftoverBlocksNewSale(expired), false);
  assert.equal(leftoverBlocksNewSale(live), true);
});

test('vente du jour du même produit : on ne résilie pas', () => {
  const [y, m, d] = parisDay().split('-');
  const sold = `${d}/${m}/${y}`;
  const contracts = [
    {
      idc: '43892',
      isBadge: false,
      label: `OFFRE DUO 29€ CONTRAT N°C2026-043892 vendu le ${sold} ${sold} 330 jours restants`,
    },
  ];
  const c = classifyMemberContracts(contracts, offre29, { ...opts, replaceExisting: true });
  assert.equal(c.needsNewSale, false);
  assert.deepEqual(c.toCancel.map((x) => x.idc), []);
  assert.equal(pickKeepSaleId(c, null), '43892');
});

test('le bot ventes garde la vente du jour', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../bot/sale.js'), 'utf8');
  assert.match(src, /pickKeepSaleId/);
  assert.match(src, /vérification du contrat requise/);
});
