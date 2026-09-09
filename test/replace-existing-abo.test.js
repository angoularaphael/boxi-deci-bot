'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  classifyMemberContracts,
  leftoverBlocksNewSale,
  isStaleOrInactiveAbo,
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
  const expiredCaps = {
    idc: '35598',
    isBadge: false,
    label: 'OFFRE A 29€ CONTRAT N°C2025-035598 01/01/2025 31/12/2025 EXPIRÉ',
  };
  const cancelled = {
    idc: '9',
    isBadge: false,
    label: '44,99€/4 SEMAINES CONTRAT N°C2025-011111 Résilié',
  };
  const live = {
    idc: '1',
    isBadge: false,
    label: '44,99€/4 SEMAINES SANS ENGAGEMENT CONTRAT N°C2026-040925 132 jours restants',
  };
  assert.equal(isStaleOrInactiveAbo(expired.label), true);
  assert.equal(isStaleOrInactiveAbo(expiredCaps.label), true);
  assert.equal(isStaleOrInactiveAbo(cancelled.label), true);
  assert.equal(isStaleOrInactiveAbo(live.label), false);
  assert.equal(leftoverBlocksNewSale(expired), false);
  assert.equal(leftoverBlocksNewSale(expiredCaps), false);
  assert.equal(leftoverBlocksNewSale(cancelled), false);
  assert.equal(leftoverBlocksNewSale(live), true);
  const c = classifyMemberContracts([expired, cancelled, live], offre29, opts);
  assert.deepEqual(
    c.toCancel.map((x) => x.idc),
    ['1']
  );
});

test('le bot ventes ignore un leftover expiré', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../bot/sale.js'), 'utf8');
  assert.match(src, /leftoverBlocksNewSale/);
  assert.match(src, /Ancien abo clos \/ expiré/);
});
