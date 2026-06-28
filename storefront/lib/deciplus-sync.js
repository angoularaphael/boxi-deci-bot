/**
 * Sync catalogue Deciplus → boutique storefront (noms + prix live).
 */
const fs = require('fs');
const path = require('path');
const { ROOT, ensureDir, loadJson } = require('../../lib/utils');
const { logInfo, logWarn } = require('../../lib/logger');
const { normalizeText, inferSaleType, buildDeciplusProductSearch } = require('../../bot/catalog');
const { getBadgeFeeNotice, isStorefrontProduct } = require('./storefront-copy');

const SYNC_FILE = path.join(ROOT, 'data', 'storefront', 'catalog-live.json');
const OVERRIDES_FILE = path.join(ROOT, 'storefront', 'products-overrides.json');
const STATIC_FILE = path.join(ROOT, 'storefront', 'products.json');

function loadStaticProducts() {
  try {
    return require('../products.json');
  } catch {
    return loadJson('storefront/products.json', { optional: true }) || [];
  }
}

/** Produits Deciplus visibles sur capture coach — contrôle sync */
const REQUIRED_DECIPLUS_TITLES = [
  'OFFRE A 29€',
  'OFFRE PROMO 9€',
  'OFFRE PROMO 12 MOIS',
  'OFFRE ETE 2026 - 3 MOIS ILLIMITÉS',
  'COMPTANT 3 MOIS',
];

function slugify(title) {
  return normalizeText(title).replace(/\s+/g, '-').slice(0, 48) || 'produit';
}

function extractRateFromTitle(title) {
  const m = String(title).match(/(\d+[,.]?\d*)\s*€/i);
  if (!m) return null;
  const v = parseFloat(m[1].replace(',', '.'));
  return Number.isFinite(v) ? v : null;
}

function inferStripeEuros(item) {
  const title = item.title || '';
  const apiPrice = Number(item.price || 0);

  if (/coach staff/i.test(title)) return 0;
  if (/comptant/i.test(title)) return apiPrice;

  const fromTitle = extractRateFromTitle(title);
  if (fromTitle != null && fromTitle > 0 && fromTitle <= 300) return fromTitle;

  if (apiPrice > 0 && apiPrice <= 300) return apiPrice;
  return apiPrice;
}

function formatEuros(amount) {
  return `${amount.toFixed(2).replace('.', ',')} €`;
}

function mapDeciplusItem(item) {
  const stripeEuros = inferStripeEuros(item);
  const comptant = /comptant/i.test(item.title);
  const saleType = inferSaleType(item);
  const requiresIban = saleType !== 'none' && stripeEuros > 0 && !comptant && !/coach staff/i.test(item.title);
  const deciplusDisplayEuros = Number(item.price || 0);

  const product = {
    id: `dp-${item.id}`,
    deciplus_id: item.id,
    category: item.categoryTitle || item.categoryId,
    name: item.title,
    price_cents: Math.round(stripeEuros * 100),
    price_label: deciplusDisplayEuros > 0 ? formatEuros(deciplusDisplayEuros) : 'Gratuit',
    stripe_price_label: stripeEuros === 0 ? 'Gratuit' : formatEuros(stripeEuros),
    deciplus_price: deciplusDisplayEuros,
    sale_type: saleType,
    requires_iban: requiresIban,
    requires_payment: stripeEuros > 0,
    deciplus_product_search: buildDeciplusProductSearch(item.title, item.id),
    synced: true,
    reference: item.reference,
    type: item.type,
  };
  const badgeNotice = getBadgeFeeNotice(product);
  if (badgeNotice) product.badge_fee_notice = badgeNotice;
  return product;
}

function apiPriceDiffers(item, stripeEuros) {
  const p = Number(item.price || 0);
  return p > stripeEuros + 0.5;
}

function loadOverrides() {
  try {
    if (fs.existsSync(OVERRIDES_FILE)) {
      return loadJson('storefront/products-overrides.json');
    }
  } catch {
    /* ignore */
  }
  return [];
}

function attachLegacyIds(products) {
  let staticProducts = [];
  try {
    staticProducts = loadJson('storefront/products.json');
  } catch {
    return products;
  }
  const byName = new Map(staticProducts.map((p) => [normalizeText(p.name), p.id]));
  for (const product of products) {
    const legacy = byName.get(normalizeText(product.name));
    if (legacy && legacy !== product.id) {
      product.legacy_id = legacy;
    }
  }
  return products;
}

function applyOverrides(products, overrides) {
  const allowedKeys = new Set(['deciplus_product_search', 'legacy_id', 'deciplus_id']);
  const byName = new Map(products.map((p) => [normalizeText(p.name), p]));
  for (const ov of overrides) {
    const key = normalizeText(ov.name || ov.match);
    const existing = byName.get(key);
    if (!existing) continue;
    for (const [k, v] of Object.entries(ov)) {
      if (allowedKeys.has(k)) existing[k] = v;
    }
  }
  return products;
}

function deciplusToStorefront(deciplusProducts, { includeCategories = ['abo'] } = {}) {
  const filtered = deciplusProducts.filter((p) => {
    if (/coach staff/i.test(p.title)) return false;
    const cat = p.categoryId || p.type;
    if (cat === 'decipass' || /^badge$/i.test(String(p.title || '').trim())) return false;
    if (includeCategories.includes('abo') && (cat === 'abo' || p.categoryId === 'abo')) return true;
    return includeCategories.length === 0;
  });

  let products = filtered.map(mapDeciplusItem).filter(isStorefrontProduct);
  products = applyOverrides(products, loadOverrides());
  products = attachLegacyIds(products);

  products.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
  return products;
}

function saveSyncedCatalog(products, meta = {}) {
  ensureDir(path.dirname(SYNC_FILE));
  const payload = {
    synced_at: new Date().toISOString(),
    count: products.length,
    ...meta,
    products,
  };
  fs.writeFileSync(SYNC_FILE, JSON.stringify(payload, null, 2), 'utf8');
  logInfo('Catalogue boutique synchronisé Deciplus', { count: products.length, file: SYNC_FILE });
  return payload;
}

function loadSyncedCatalog() {
  if (!fs.existsSync(SYNC_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(SYNC_FILE, 'utf8'));
  } catch (err) {
    logWarn('Catalogue live illisible', { error: err.message, file: SYNC_FILE });
    return null;
  }
}

let runtimeCatalog = null;

function setRuntimeCatalog(payload) {
  runtimeCatalog = payload;
  return payload;
}

function ingestCatalogPayload(payload) {
  if (!payload?.products?.length) {
    throw new Error('Payload catalogue invalide');
  }
  const normalized = {
    synced_at: payload.synced_at || new Date().toISOString(),
    count: payload.products.length,
    products: payload.products,
    source: payload.source || 'ingest',
    validation: payload.validation || null,
  };
  if (process.env.VERCEL !== '1') {
    saveSyncedCatalog(normalized.products, {
      deciplus_count: payload.deciplus_count,
      validation: payload.validation,
      synced_by: payload.synced_by || 'ingest',
    });
  }
  setRuntimeCatalog(normalized);
  logInfo('Catalogue ingéré', { count: normalized.products.length, source: normalized.source });
  return normalized;
}

function enrichStorefrontProducts(products) {
  return products
    .filter(isStorefrontProduct)
    .map((product) => {
      const badgeNotice = getBadgeFeeNotice(product);
      if (!badgeNotice) return product;
      return { ...product, badge_fee_notice: badgeNotice };
    });
}

function getStoreProducts({ preferLive = true } = {}) {
  const wrap = (catalog) => {
    const products = enrichStorefrontProducts(catalog.products || []);
    return { ...catalog, products, count: products.length };
  };

  if (preferLive && runtimeCatalog?.products?.length) {
    return wrap(runtimeCatalog);
  }
  if (preferLive) {
    const live = loadSyncedCatalog();
    if (live?.products?.length) return wrap(live);
  }
  const staticProducts = enrichStorefrontProducts(loadStaticProducts());
  if (!staticProducts.length && process.env.VERCEL) {
    logWarn('Catalogue statique indisponible sur Vercel — ingest bot requis');
  }
  return {
    synced_at: null,
    products: staticProducts,
    count: staticProducts.length,
    source: 'static',
  };
}

function validateSync(products) {
  const titles = new Set(products.map((p) => normalizeText(p.name)));
  const missing = REQUIRED_DECIPLUS_TITLES.filter(
    (t) => !titles.has(normalizeText(t)) && !products.some((p) => normalizeText(p.name).includes(normalizeText(t)))
  );
  return { ok: missing.length === 0, missing, count: products.length };
}

function compareWithStatic(liveProducts) {
  const staticProducts = loadJson('storefront/products.json');
  const liveNames = new Set(liveProducts.map((p) => normalizeText(p.name)));
  const staticNames = new Set(staticProducts.map((p) => normalizeText(p.name)));
  const onlyLive = liveProducts.filter((p) => !staticNames.has(normalizeText(p.name))).map((p) => p.name);
  const onlyStatic = staticProducts.filter((p) => !liveNames.has(normalizeText(p.name))).map((p) => p.name);
  return { onlyLive, onlyStatic };
}

module.exports = {
  deciplusToStorefront,
  saveSyncedCatalog,
  loadSyncedCatalog,
  setRuntimeCatalog,
  ingestCatalogPayload,
  getStoreProducts,
  validateSync,
  compareWithStatic,
  inferStripeEuros,
  mapDeciplusItem,
  REQUIRED_DECIPLUS_TITLES,
  SYNC_FILE,
};
