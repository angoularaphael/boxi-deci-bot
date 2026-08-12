/**
 * Essai 10€ + packs coaching → vente Deciplus « Achat carte » (pas abonnement / pas trial_only).
 */
const assert = require('assert');
const {
  isTrialOrder,
  isCarteMerchOrder,
  buildProductConfig,
} = require('../lib/catalog-sale');

const essaiMatched = {
  id: 77,
  title: "SEANCE D'ESSAI",
  price: 10,
  type: 'abo',
  categoryId: 'abo',
};

function paidEssaiOrder(overrides = {}) {
  return {
    product_id: 'seance-essai',
    product_name: "SEANCE D'ESSAI",
    sale_type: 'carte',
    deciplus_product_search: 'essai',
    payment: { amount: 10, method: 'payplug', status: 'paid' },
    ...overrides,
  };
}

function run() {
  const paid = paidEssaiOrder();
  assert.strictEqual(isTrialOrder(paid), false, 'paid essai must NOT be free trial');
  assert.strictEqual(isCarteMerchOrder(paid), true, 'paid essai is carte merch');

  const free = {
    product_name: "SEANCE D'ESSAI",
    sale_type: 'none',
    payment: { amount: 0, status: 'paid' },
  };
  assert.strictEqual(isTrialOrder(free), true, '0€ essai is free trial');

  const cfgNoMatch = buildProductConfig(paid, null);
  assert.strictEqual(cfgNoMatch.sale_type, 'carte', 'unmatched paid essai → carte');
  assert.strictEqual(cfgNoMatch.create_sale, true);
  assert.strictEqual(cfgNoMatch.paiement_comptant, true);
  assert.strictEqual(cfgNoMatch.requires_iban, false);

  // Even if Deciplus catalog types the product as abo, keep Achat carte.
  const cfgMatched = buildProductConfig(paid, essaiMatched);
  assert.strictEqual(cfgMatched.sale_type, 'carte', 'matched essai typed abo → still carte');
  assert.strictEqual(cfgMatched.paiement_comptant, true);
  assert.strictEqual(cfgMatched.auto_badge, false);

  for (const id of ['coaching-1', 'coaching-5', 'coaching-10']) {
    const order = {
      product_id: id,
      product_name: `Coaching ${id}`,
      sale_type: 'carte',
      deciplus_product_search: 'coaching',
      payment: { amount: 55, method: 'payplug', status: 'paid' },
    };
    assert.strictEqual(isTrialOrder(order), false, `${id} not trial`);
    const cfg = buildProductConfig(order, {
      id: 99,
      title: 'COACHING',
      price: 55,
      type: 'abo',
      categoryId: 'abo',
    });
    assert.strictEqual(cfg.sale_type, 'carte', `${id} → carte`);
    assert.strictEqual(cfg.paiement_comptant, true, `${id} comptant`);
  }

  // Regression: offre duo PayPlug rib stays abonnement (not forced carte).
  const duo = buildProductConfig(
    {
      product_id: 'offre-duo',
      product_name: 'Offre Duo 29',
      sale_type: 'abonnement',
      payment: { amount: 29, method: 'payplug', billing_plan: 'rib' },
    },
    { id: 104, title: 'OFFRE DUO', price: 29 }
  );
  assert.strictEqual(duo.sale_type, 'abonnement', 'duo stays abonnement');
  assert.strictEqual(duo.paiement_comptant, false, 'duo not comptant');

  console.log('ok — essai/coaching carte sale_type');
}

run();
