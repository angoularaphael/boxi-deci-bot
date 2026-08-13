/**
 * Essai 10€ + packs coaching → vente Deciplus « Achat Carte » comptant (pas Badge).
 */
const assert = require('assert');
const {
  isTrialOrder,
  isCarteMerchOrder,
  isCartePrestationOrder,
  isCartePrestationConfig,
  isBadgeProductConfig,
  isDeciplusBadgeLabel,
  resolvePrestationHint,
  prestationForbidsBadge,
  pickBestCatalogTile,
  buildProductConfig,
} = require('../lib/catalog-sale');
const { isBadgeSale } = require('../bot/sale');
const { resolveProductConfig, findProductInCatalog } = require('../bot/catalog');
const { productNeedsAutoBadge } = require('../lib/billing-plan');

const essaiMatched = {
  id: 77,
  title: "SEANCE D'ESSAI",
  price: 10,
  type: 'abo',
  categoryId: 'abo',
};

const catalogWithTrap = [
  { id: 12, title: 'Badge', price: 34.99, type: 'decipass' },
  { id: 88, title: '44,99€/4 semaines Sans Engagement', price: 44.99, type: 'abo' },
  { id: 77, title: "SEANCE D'ESSAI", price: 10, type: 'abo' },
  { id: 201, title: 'COACHING PRIVE 1 SEANCE', price: 55, type: 'abo' },
  { id: 205, title: 'COACHING PRIVE 5 SEANCES', price: 250, type: 'abo' },
  { id: 210, title: 'COACHING PRIVE 10 SEANCES', price: 450, type: 'abo' },
];

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
  assert.strictEqual(isCartePrestationOrder(paid), true, 'paid essai is prestation carte');
  assert.strictEqual(isDeciplusBadgeLabel('Badge'), true);
  assert.strictEqual(isDeciplusBadgeLabel("Achat Carte — SEANCE D'ESSAI"), false);
  assert.strictEqual(isDeciplusBadgeLabel('COACHING PRIVE 1 SEANCE'), false);

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
  assert.strictEqual(cfgNoMatch.auto_badge, false);
  assert.match(String(cfgNoMatch.deciplus_product_search), /essai/i);
  assert.match(String(cfgNoMatch.label), /essai/i);
  assert.strictEqual(isBadgeSale(cfgNoMatch), false, 'essai n’est pas une vente Badge');
  assert.strictEqual(isCartePrestationConfig(cfgNoMatch), true);
  assert.strictEqual(prestationForbidsBadge(cfgNoMatch), true);
  assert.equal(productNeedsAutoBadge(cfgNoMatch), false);

  const cfgMatched = buildProductConfig(paid, essaiMatched);
  assert.strictEqual(cfgMatched.sale_type, 'carte', 'matched essai typed abo → still carte');
  assert.strictEqual(isBadgeSale(cfgMatched), false);

  const cfgNotBadge = buildProductConfig(paid, {
    id: 12,
    title: 'Badge',
    price: 34.99,
    type: 'decipass',
    categoryId: 'decipass',
  });
  assert.match(String(cfgNotBadge.label), /essai/i, 'ne pas garder le titre Badge');
  assert.strictEqual(isBadgeSale(cfgNotBadge), false);
  assert.strictEqual(isBadgeProductConfig({ ...cfgNotBadge, label: 'Badge', product_id: 'seance-essai' }), false);

  for (const [id, amount, title, search] of [
    ['coaching-1', 55, 'COACHING PRIVE 1 SEANCE', /COACHING PRIVE 1/i],
    ['coaching-5', 250, 'COACHING PRIVE 5 SEANCES', /COACHING PRIVE 5/i],
    ['coaching-10', 450, 'COACHING PRIVE 10 SEANCES', /COACHING PRIVE 10/i],
  ]) {
    const order = {
      product_id: id,
      product_name: title,
      sale_type: 'carte',
      deciplus_product_search: resolvePrestationHint({ product_id: id }).search,
      payment: { amount, method: 'payplug', status: 'paid' },
    };
    const cfg = buildProductConfig(order, { id: 12, title: 'Badge', price: 34.99, type: 'decipass' });
    assert.strictEqual(isBadgeSale(cfg), false, `${id} pas modale Badge`);
    assert.strictEqual(cfg.auto_badge, false, `${id} no auto_badge`);
    assert.match(String(cfg.label), /coaching/i, `${id} label coaching`);
    assert.match(String(cfg.deciplus_product_search), search, `${id} search spécifique`);
  }

  assert.strictEqual(
    isBadgeSale({ label: 'Badge', sale_type: 'carte', deciplus_product_name: 'Badge' }),
    true,
    'produit Badge reste isBadgeSale'
  );

  const matched = findProductInCatalog(catalogWithTrap, paid);
  assert.ok(matched);
  assert.match(String(matched.title), /essai/i);
  const resolved = resolveProductConfig(paid, catalogWithTrap);
  assert.strictEqual(isBadgeSale(resolved), false);
  assert.strictEqual(resolved.sale_type, 'carte');

  const cartesPrepayeesGrid = [
    "SEANCE D'ESSAI\n10,00€",
    'Coaching privé 1...\n55,00€',
    'Coaching privé 5...\n250,00€',
    'Coaching privé 1...\n450,00€',
    'Badge\n34,99€',
  ];
  const essaiPick = pickBestCatalogTile(cartesPrepayeesGrid, cfgMatched);
  assert.match(String(essaiPick.text), /essai/i);
  assert.ok(!/badge/i.test(String(essaiPick.text)));

  for (const [id, price] of [
    ['coaching-1', /55,00/],
    ['coaching-5', /250,00/],
    ['coaching-10', /450,00/],
  ]) {
    const hint = resolvePrestationHint({ product_id: id });
    const cfg = buildProductConfig(
      {
        product_id: id,
        product_name: hint.label,
        sale_type: 'carte',
        deciplus_product_search: hint.search,
        payment: { amount: hint.amount, method: 'payplug', status: 'paid' },
      },
      null
    );
    const pick = pickBestCatalogTile(cartesPrepayeesGrid, cfg);
    assert.match(String(pick.text), /coaching/i, `${id} clique coaching`);
    assert.match(String(pick.text), price, `${id} départagé par le prix`);
    assert.ok(!/badge/i.test(String(pick.text)), `${id} ne clique pas Badge`);
  }

  console.log('ok — essai/coaching Achat Carte (pas Badge), grille Cartes prépayées');
}

run();
