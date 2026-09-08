'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { orderNeedsAutoBadge } = require('../lib/billing-plan');
const { isTrialPrestationConfig } = require('../bot/sale');
const { uniqueDeciplusSearchConfigs } = require('../lib/deciplus-sites');

const recurring = {
  id: 'dp-104',
  name: 'OFFRE A 29€',
  sale_type: 'abonnement',
  requires_iban: true,
};

test('prélèvement mensuel = exactement un Badge autorisé', () => {
  assert.equal(
    orderNeedsAutoBadge(
      { payment: { billing_plan: 'rib', iban: 'FR761234' } },
      recurring
    ),
    true
  );
});

test('comptant et 4x avec RIB = aucun Badge', () => {
  assert.equal(
    orderNeedsAutoBadge(
      { paiement_comptant: true, payment: { billing_plan: 'cb' } },
      { ...recurring, paiement_comptant: true }
    ),
    false
  );
  assert.equal(
    orderNeedsAutoBadge(
      { payment: { payment_plan: '4x', billing_plan: 'rib', iban: 'FR761234' } },
      recurring
    ),
    false
  );
});

test('une séance d’essai existante est reconnue avant toute nouvelle création', () => {
  assert.equal(
    isTrialPrestationConfig({
      sale_type: 'carte',
      deciplus_product_name: "SEANCE D'ESSAI GRATUITE WEB",
    }),
    true
  );
  assert.equal(isTrialPrestationConfig({ sale_type: 'carte', name: 'COACHING PRIVE 10 SEANCES' }), false);
});

test('la recherche membre vérifie Balma avant de créer une nouvelle fiche', () => {
  const sites = uniqueDeciplusSearchConfigs('st-cyprien');
  assert.ok(sites.some((site) => /balma/i.test(String(site.deciplus_label || site.label || site.key))));
});

test('une reprise après vente conserve le sale_id du checkpoint', () => {
  const source = fs.readFileSync(path.join(__dirname, '../bot/index.js'), 'utf8');
  assert.match(
    source,
    /order\.deciplus_sale_id\s*=\s*checkpoint\.deciplus_sale_id/
  );
  assert.match(source, /Migration Balma → Minimes obligatoire avant vente/);
});

