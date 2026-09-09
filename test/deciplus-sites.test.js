'use strict';

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const {
  saleMemberSearchConfigs,
  uniqueDeciplusSearchConfigs,
} = require('../lib/deciplus-sites');

const SAVED = { DECIPLUS_SEARCH_ALL_GYMS: process.env.DECIPLUS_SEARCH_ALL_GYMS };

after(() => {
  if (SAVED.DECIPLUS_SEARCH_ALL_GYMS == null) delete process.env.DECIPLUS_SEARCH_ALL_GYMS;
  else process.env.DECIPLUS_SEARCH_ALL_GYMS = SAVED.DECIPLUS_SEARCH_ALL_GYMS;
});

function labels(configs) {
  return configs.map((c) => c.deciplus_label || c.label);
}

describe('saleMemberSearchConfigs', () => {
  it('Minimes : salle commande + legacy États-Unis seulement (pas 5 clubs)', () => {
    delete process.env.DECIPLUS_SEARCH_ALL_GYMS;
    const fast = saleMemberSearchConfigs('minimes');
    const full = uniqueDeciplusSearchConfigs('minimes');
    assert.ok(fast.length < full.length, 'fast path must scan fewer sites');
    assert.ok(fast.length <= 3, `expected <=3 sites, got ${fast.length}: ${labels(fast)}`);
    assert.ok(labels(fast).some((l) => /minimes/i.test(l)));
    assert.ok(labels(fast).some((l) => /etats/i.test(l)));
  });

  it('DECIPLUS_SEARCH_ALL_GYMS=1 restaure le parcours complet', () => {
    process.env.DECIPLUS_SEARCH_ALL_GYMS = '1';
    const fast = saleMemberSearchConfigs('portet');
    const full = uniqueDeciplusSearchConfigs('portet');
    assert.equal(fast.length, full.length);
  });
});
