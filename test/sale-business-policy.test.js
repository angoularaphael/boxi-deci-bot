'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { orderNeedsAutoBadge } = require('../lib/billing-plan');
const { isTrialPrestationConfig } = require('../bot/sale');
const { safeMemberCreationGymConfig } = require('../bot/member');
const { getGymConfig } = require('../lib/normalize');
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

test('une demande de création Balma est forcée vers Minimes', () => {
  const safe = safeMemberCreationGymConfig(getGymConfig('balma'));
  assert.equal(safe.key, 'minimes');
  assert.equal(String(safe.deciplus_zone_id), '2');
  const source = fs.readFileSync(path.join(__dirname, '../bot/member.js'), 'utf8');
  assert.match(source, /aucune nouvelle fiche ne peut être créée sur Balma/);
});

test('une reprise après vente conserve le sale_id du checkpoint', () => {
  const source = fs.readFileSync(path.join(__dirname, '../bot/index.js'), 'utf8');
  assert.match(
    source,
    /order\.deciplus_sale_id\s*=\s*checkpoint\.deciplus_sale_id/
  );
  assert.match(source, /Migration Balma → Minimes obligatoire avant vente/);
  assert.match(source, /vente forcée Minimes/);
  assert.doesNotMatch(source, /BALMA_SALE_ERROR/);
});

test('Balma n’est plus une destination de vente ni un choix boutique', () => {
  const { resolveSaleGymConfig, remapBalmaGymSlug } = require('../lib/gym-slugs');
  const { normalizeOrder } = require('../lib/normalize');
  const dest = resolveSaleGymConfig(getGymConfig('balma'), { gym: 'balma' });
  assert.equal(dest.key, 'minimes');
  assert.equal(String(dest.deciplus_zone_id), '2');
  assert.equal(remapBalmaGymSlug('balma'), 'minimes');
  assert.equal(normalizeOrder({ order_id: 'BC-1', gym: 'balma', customer: { first_name: 'A', last_name: 'B' } }).gym, 'minimes');

  const migrate = fs.readFileSync(path.join(__dirname, '../bot/migrate-gym.js'), 'utf8');
  assert.match(migrate, /Migration vers Balma interdite/);
  const checkout = fs.readFileSync(path.join(__dirname, '../storefront/public/checkout.html'), 'utf8');
  assert.doesNotMatch(checkout, /option value="balma"/);
  const admin = fs.readFileSync(path.join(__dirname, '../storefront/public/admin/index.html'), 'utf8');
  assert.doesNotMatch(admin, /id="co_gym"[\s\S]*value="balma"/);
});

