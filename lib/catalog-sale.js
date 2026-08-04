/**
 * Config vente Deciplus — sans Playwright (safe Vercel serverless).
 */
const { loadJson } = require('./utils');
const {
  normalizeText,
  inferSaleType,
  buildDeciplusProductSearch,
} = require('./catalog-text');

function isTrialOrder(order) {
  const name = normalizeText(order.product_name || order.offer);
  return order.payment.amount === 0 || name.includes('essai');
}

function buildProductConfig(order, matchedProduct = null) {
  const defaults = loadJson('config/sale-defaults.json');

  if (isTrialOrder(order)) {
    return {
      key: 'essai',
      label: order.product_name || 'Séance essai',
      sale_type: 'none',
      ...defaults.none,
    };
  }

  if (!matchedProduct) {
    throw new Error(
      `Produit introuvable dans Deciplus: "${order.product_name || order.offer}"`
    );
  }

  const saleType = inferSaleType(matchedProduct);
  const typeDefaults = defaults[saleType] || defaults.abonnement;
  const comptant = /comptant/i.test(matchedProduct.title);

  return {
    key: String(matchedProduct.id),
    label: matchedProduct.title,
    deciplus_product_name: matchedProduct.title,
    deciplus_product_search:
      order.deciplus_product_search ||
      buildDeciplusProductSearch(matchedProduct.title, matchedProduct.id),
    deciplus_product_id: matchedProduct.id,
    deciplus_reference: matchedProduct.reference || null,
    amount: order.payment.amount || matchedProduct.price,
    ...typeDefaults,
    sale_type: saleType,
    paiement_comptant: comptant,
    auto_badge: saleType === 'abonnement',
  };
}

module.exports = {
  isTrialOrder,
  buildProductConfig,
};
