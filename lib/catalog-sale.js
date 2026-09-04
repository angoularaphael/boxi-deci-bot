/**
 * Config vente Deciplus — sans Playwright (safe Vercel serverless).
 */
const { loadJson } = require('./utils');
const {
  normalizeText,
  inferSaleType,
  buildDeciplusProductSearch,
} = require('./catalog-text');

/** Produits boutique vendus en Deciplus via « Achat Carte » (pas Badge, pas abo). */
const CARTE_PRODUCT_IDS = new Set([
  'seance-essai',
  'coaching-1',
  'coaching-5',
  'coaching-10',
]);

const PRESTATION_CATALOG = {
  'seance-essai': {
    label: "SEANCE D'ESSAI",
    search: 'essai',
    searches: ["SEANCE D'ESSAI", 'essai', 'seance essai'],
    amount: 10,
  },
  'coaching-1': {
    label: 'COACHING PRIVE 1 SEANCE',
    search: 'COACHING PRIVE 1',
    searches: ['COACHING PRIVE 1', 'Coaching privé 1', 'coaching 1 seance', 'coaching'],
    amount: 55,
  },
  'coaching-5': {
    label: 'COACHING PRIVE 5 SEANCES',
    search: 'COACHING PRIVE 5',
    searches: ['COACHING PRIVE 5', 'Coaching privé 5', 'coaching 5 seances', 'coaching'],
    amount: 250,
  },
  'coaching-10': {
    label: 'COACHING PRIVE 10 SEANCES',
    search: 'COACHING PRIVE 10',
    searches: ['COACHING PRIVE 10', 'Coaching privé 10', 'coaching 10 seances', 'coaching'],
    amount: 450,
  },
};

function haystackOf(obj = {}) {
  return normalizeText(
    [
      obj.product_id,
      obj.product_reference,
      obj.key,
      obj.product_name,
      obj.label,
      obj.deciplus_product_name,
      obj.offer,
      obj.deciplus_product_search,
    ]
      .filter(Boolean)
      .join(' ')
  );
}

function resolvePrestationHint(orderOrConfig = {}) {
  const id = String(
    orderOrConfig.product_id || orderOrConfig.product_reference || orderOrConfig.key || ''
  ).toLowerCase();
  if (PRESTATION_CATALOG[id]) return { id, ...PRESTATION_CATALOG[id] };
  if (id.startsWith('coaching-10') || id === 'coaching-10') {
    return { id: 'coaching-10', ...PRESTATION_CATALOG['coaching-10'] };
  }
  if (id === 'coaching-5') return { id: 'coaching-5', ...PRESTATION_CATALOG['coaching-5'] };
  if (id.startsWith('coaching-')) return { id: 'coaching-1', ...PRESTATION_CATALOG['coaching-1'] };

  const hay = haystackOf(orderOrConfig);
  if (hay.includes('essai') || id.includes('seance-essai')) {
    return { id: 'seance-essai', ...PRESTATION_CATALOG['seance-essai'] };
  }
  if (hay.includes('coaching')) {
    if (/\b10\b/.test(hay) || hay.includes('coaching-10')) {
      return { id: 'coaching-10', ...PRESTATION_CATALOG['coaching-10'] };
    }
    if (/\b5\b/.test(hay) || hay.includes('coaching-5')) {
      return { id: 'coaching-5', ...PRESTATION_CATALOG['coaching-5'] };
    }
    return { id: 'coaching-1', ...PRESTATION_CATALOG['coaching-1'] };
  }
  return null;
}

function isCartePrestationOrder(order = {}) {
  return Boolean(resolvePrestationHint(order));
}

function isCartePrestationConfig(productConfig = {}) {
  return Boolean(resolvePrestationHint(productConfig));
}

function isBadgeCatalogTitle(title) {
  return /\bbadge\b/i.test(String(title || '')) && !/essai|coaching/i.test(String(title || ''));
}

/** Contrat / tuile Deciplus = le produit Badge, pas « Achat Carte » / essai / coaching. */
function isDeciplusBadgeLabel(label) {
  return isBadgeCatalogTitle(label);
}

function isBadgeProductConfig(productConfig = {}) {
  if (isCartePrestationConfig(productConfig)) return false;
  return isBadgeCatalogTitle(
    productConfig.label || productConfig.deciplus_product_name || productConfig.key || ''
  );
}

function isTrialOrder(order) {
  const amount = Number(order.payment?.amount ?? 0);
  if (amount > 0) return false;
  const name = normalizeText(order.product_name || order.offer);
  return name.includes('essai') || order.sale_type === 'none';
}

function isCarteMerchOrder(order) {
  if (isCartePrestationOrder(order)) return true;
  const productId = String(order.product_id || order.product_reference || '').toLowerCase();
  if (order.sale_type === 'carte' || order.sale_type === 'materiel') return true;
  const name = normalizeText(order.product_name || order.offer || productId);
  const amount = Number(order.payment?.amount ?? 0);
  if (amount > 0 && (name.includes('essai') || productId.includes('seance-essai'))) return true;
  if (amount > 0 && name.includes('coaching')) return true;
  return false;
}

function buildCarteFallbackConfig(order, defaults) {
  const typeDefaults = defaults.carte || defaults.abonnement;
  const hint = resolvePrestationHint(order) || {
    id: String(order.product_id || 'carte').toLowerCase() || 'carte',
    label: order.product_name || order.deciplus_product_name || 'Carte',
    search: order.deciplus_product_search || 'coaching',
    amount: Number(order.payment?.amount || 0) || null,
  };
  return {
    key: hint.id,
    product_id: hint.id,
    label: hint.label,
    deciplus_product_name: hint.label,
    deciplus_product_search: order.deciplus_product_search || hint.search,
    amount: order.payment?.amount || hint.amount || null,
    ...typeDefaults,
    sale_type: 'carte',
    paiement_comptant: true,
    requires_iban: false,
    skip_rib_prompt: true,
    create_sale: true,
    auto_badge: false,
  };
}

/** Essai / coaching : jamais de Badge (pas d’accès club). */
function prestationForbidsBadge(configOrOrder = {}) {
  return Boolean(resolvePrestationHint(configOrOrder));
}

function buildProductConfig(order, matchedProduct = null) {
  const defaults = loadJson('config/sale-defaults.json');
  const prestation = resolvePrestationHint(order);

  if (isTrialOrder(order)) {
    return {
      key: 'essai',
      label: order.product_name || 'Séance essai',
      sale_type: 'none',
      ...defaults.none,
    };
  }

  const matchedLooksLikeBadge = matchedProduct && isBadgeCatalogTitle(matchedProduct.title);
  const matchedFitsPrestation =
    matchedProduct &&
    prestation &&
    /essai|coaching/i.test(String(matchedProduct.title || ''));

  if (prestation && (!matchedProduct || matchedLooksLikeBadge || !matchedFitsPrestation)) {
    return buildCarteFallbackConfig(order, defaults);
  }

  if (!matchedProduct) {
    if (isCarteMerchOrder(order)) {
      return buildCarteFallbackConfig(order, defaults);
    }
    throw new Error(
      `Produit introuvable dans Deciplus: "${order.product_name || order.offer}"`
    );
  }

  let saleType = inferSaleType(matchedProduct);
  if (isCarteMerchOrder(order) || prestation) {
    saleType = 'carte';
  }

  const typeDefaults = defaults[saleType] || defaults.abonnement;
  const paymentPlan = String(order.payment?.payment_plan || order.payment_plan || '').toLowerCase();
  const billingPlan = String(order.payment?.billing_plan || order.billing_plan || '').toLowerCase();
  const {
    isPayplug4xPrelevementOrder,
    resolvePayplug4xPrelevementDeciplus,
  } = require('./billing-plan');
  const payplug4xPrelev = isPayplug4xPrelevementOrder(order);
  const payplug4xDeciplus = payplug4xPrelev
    ? resolvePayplug4xPrelevementDeciplus(
        {
          id: order.product_id,
          legacy_id: order.product_reference,
          name: matchedProduct.title,
          price_cents: matchedProduct.price ? Math.round(Number(matchedProduct.price) * 100) : null,
        },
        order
      )
    : null;
  const orderHint = [
    order.product_name,
    order.offer,
    order.payment?.billing_plan,
    paymentPlan,
    String(order.payment?.method || order.payment_method || '').toLowerCase(),
  ]
    .filter(Boolean)
    .join(' ');
  const forceCarteComptant = Boolean(prestation);
  const comptant =
    !payplug4xPrelev &&
    (forceCarteComptant ||
    /comptant/i.test(matchedProduct.title) ||
    paymentPlan === 'once' ||
    (paymentPlan === '4x' && !payplug4xPrelev) ||
    /4\s*[x×]\s*sans\s*frais|1\s*[x×]\s*ou\s*4/i.test(orderHint) ||
    order.paiement_comptant === true);

  const deciplusLabel = payplug4xDeciplus
    ? payplug4xDeciplus.deciplus_product_name
    : prestation
      ? prestation.label
      : matchedProduct.title;

  return {
    key: String(matchedProduct.id),
    product_id: String(order.product_id || prestation?.id || matchedProduct.id),
    label: deciplusLabel,
    deciplus_product_name: deciplusLabel,
    deciplus_product_search:
      payplug4xDeciplus?.deciplus_product_search ||
      order.deciplus_product_search ||
      prestation?.search ||
      buildDeciplusProductSearch(matchedProduct.title, matchedProduct.id),
    deciplus_product_id: matchedProduct.id,
    deciplus_reference: matchedProduct.reference || null,
    amount:
      payplug4xDeciplus?.amount ||
      order.payment?.amount ||
      prestation?.amount ||
      matchedProduct.price,
    ...typeDefaults,
    sale_type: saleType,
    paiement_comptant: comptant,
    requires_iban: payplug4xPrelev ? true : comptant ? false : typeDefaults.requires_iban,
    skip_rib_prompt: payplug4xPrelev ? false : comptant ? true : typeDefaults.skip_rib_prompt,
    payplug_4x_prelevement: payplug4xPrelev || undefined,
    create_sale: true,
    auto_badge: payplug4xPrelev ? true : saleType === 'abonnement' && !comptant,
  };
}

/**
 * Score une tuile du catalogue Deciplus « Cartes prépayées »
 * (SEANCE D'ESSAI 10 €, Coaching 55/250/450 €, Badge 34,99 €).
 * Le prix départage les titres tronqués (« Coaching privé 1... » = 55 € ou 450 €).
 */
function scoreCatalogTile(text, productConfig = {}) {
  const raw = String(text || '');
  const normalized = normalizeText(raw);
  if (!normalized) return 0;

  const hint = resolvePrestationHint(productConfig);
  if (hint && isDeciplusBadgeLabel(raw)) return -1000;

  const name = productConfig.deciplus_product_name || productConfig.label || hint?.label || '';
  const targetName = normalizeText(name);
  let score = 0;

  if (targetName && normalized === targetName) score += 200;
  else if (targetName && (normalized.includes(targetName) || targetName.includes(normalized))) {
    score += 100;
  }

  const amount = Number(productConfig.amount || hint?.amount);
  if (Number.isFinite(amount) && amount > 0) {
    const priceNeedles = [
      amount.toFixed(2).replace('.', ','),
      amount.toFixed(2),
      String(Math.round(amount)),
    ];
    if (priceNeedles.some((pv) => raw.includes(pv) || normalized.includes(normalizeText(pv)))) {
      score += 180;
    }
  }

  if (hint?.id === 'seance-essai') {
    if (/essai/.test(normalized)) score += 220;
    if (/coaching/.test(normalized) || /badge/.test(normalized)) score -= 200;
  }
  if (hint && String(hint.id).startsWith('coaching')) {
    if (/coaching/.test(normalized)) score += 80;
    if (/essai/.test(normalized) || /badge/.test(normalized)) score -= 200;
    if (hint.id === 'coaching-1') {
      if (/\b10\b/.test(normalized) || /450/.test(raw)) score -= 160;
      if (/\b5\b/.test(normalized) || /250/.test(raw)) score -= 160;
      if (/55/.test(raw)) score += 80;
    }
    if (hint.id === 'coaching-5') {
      if (/250/.test(raw) || /\b5\b/.test(normalized)) score += 80;
      if (/450/.test(raw) || /55[,.]00/.test(raw)) score -= 80;
    }
    if (hint.id === 'coaching-10') {
      if (/450/.test(raw) || /\b10\b/.test(normalized)) score += 80;
      if (/55[,.]00/.test(raw) || /250/.test(raw)) score -= 80;
    }
  }

  const targetTokens = targetName.split(' ').filter((t) => t.length > 3);
  const textTokens = new Set(normalized.split(' '));
  score += targetTokens.filter((t) => textTokens.has(t)).length * 15;

  if (productConfig.paiement_comptant === true) {
    if (/4\s*[x×]|4 fois|prelevement|pr[eé]l[eè]vement|64[,.]75/i.test(raw)) score -= 250;
    if (/259/.test(raw) && !/4\s*[x×]|4 fois|64[,.]75/i.test(raw)) score += 80;
  }
  if (productConfig.payplug_4x_prelevement === true) {
    const targetName = normalizeText(productConfig.deciplus_product_name || '');
    const amount = Number(productConfig.amount);
    if (targetName) {
      if (normalized === targetName) score += 320;
      else if (normalized.includes(targetName) || targetName.includes(normalized)) score += 180;
    }
    if (Number.isFinite(amount) && amount > 0) {
      const amountStr = String(Math.round(amount));
      if (/4\s*[x×]|4 fois|sans\s*frais|prelevement|pr[eé]l[eè]vement/i.test(raw) && raw.includes(amountStr)) {
        score += 200;
      }
      if (raw.includes(amountStr) && !/4\s*[x×]|4 fois|sans\s*frais|prelevement|pr[eé]l[eè]vement/i.test(raw)) {
        score -= 150;
      }
    }
  }
  if (/offre\s*(a|duo)\s*29|\b29[,.]?0{0,2}\s*€/.test(targetName) && /44,?99|4 semaines/.test(normalized)) {
    score -= 200;
  }

  return score;
}

function pickBestCatalogTile(tileTexts, productConfig) {
  let best = null;
  let bestScore = -Infinity;
  for (const text of tileTexts || []) {
    if (isCartePrestationConfig(productConfig) && isDeciplusBadgeLabel(text)) continue;
    const score = scoreCatalogTile(text, productConfig);
    if (score > bestScore) {
      bestScore = score;
      best = text;
    }
  }
  return { text: best, score: bestScore };
}

module.exports = {
  isTrialOrder,
  isCarteMerchOrder,
  isCartePrestationOrder,
  isCartePrestationConfig,
  isBadgeProductConfig,
  isBadgeCatalogTitle,
  isDeciplusBadgeLabel,
  resolvePrestationHint,
  prestationForbidsBadge,
  scoreCatalogTile,
  pickBestCatalogTile,
  buildProductConfig,
  CARTE_PRODUCT_IDS,
  PRESTATION_CATALOG,
};
