/**
 * Catalogue Deciplus — récupéré automatiquement via l'API interne (pas de JSON manuel).
 */
const fs = require('fs');
const path = require('path');
const { ROOT, loadJson } = require('../lib/utils');
const { logInfo, logWarn } = require('../lib/logger');

const API_BASE = 'https://api.deciplus.pro/staff/v1';
const CATALOG_CACHE_MS = Number(process.env.BOT_CATALOG_CACHE_MS || 300000);
const CATALOG_FALLBACK_FILE = path.join(ROOT, 'data', 'storefront', 'catalog-live.json');

let catalogCache = { at: 0, products: [] };

async function getAccessToken(page) {
  return page.evaluate(() => {
    try {
      const raw = localStorage.getItem('auth');
      if (!raw) return null;
      return JSON.parse(raw).token || null;
    } catch {
      return null;
    }
  });
}

async function ensureDeciplusAuth(page) {
  const base = process.env.DECIPLUS_URL || 'https://boxingcenter.deciplus.pro/';
  let token = await getAccessToken(page);

  const warmPaths = token
    ? ['nextgen/home']
    : ['nextgen/home', 'select.php', 'check.php?idj=1'];

  for (const pathPart of warmPaths) {
    if (token && page.url().includes('deciplus.pro') && page.url().includes(pathPart.split('?')[0])) {
      break;
    }
    await page.goto(new URL(pathPart, base).href, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    }).catch(() => {});
    await page.waitForTimeout(1200);
    token = token || (await getAccessToken(page));
    if (token) break;
  }

  return token;
}

function loadCatalogFallback() {
  if (!fs.existsSync(CATALOG_FALLBACK_FILE)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(CATALOG_FALLBACK_FILE, 'utf8'));
    if (!data.products?.length) return null;
    logWarn('Catalogue Deciplus — repli sur catalog-live.json', { count: data.products.length });
    return data.products.map((p) => ({
      id: p.deciplus_id,
      title: p.name,
      type: p.type || 'abo',
      categoryId: p.type || 'abo',
      categoryTitle: p.category,
      price: Number(p.deciplus_price || p.price_cents / 100 || 0),
      reference: p.reference,
    }));
  } catch {
    return null;
  }
}

async function fetchCatalogFromApi(page, token) {
  const base = process.env.DECIPLUS_URL || 'https://boxingcenter.deciplus.pro/';
  const url = `${API_BASE}/product/getAvailableProducts?all=true`;
  const referer = new URL('nextgen/home', base).href;
  const clientTypes = ['manager', 'manager_legacy'];

  let lastError = null;
  for (const clientType of clientTypes) {
    try {
      const response = await page.context().request.get(url, {
        headers: {
          Accept: 'application/json, text/plain, */*',
          'x-access-token': token,
          'Deciplus-Client-Type': clientType,
          Referer: referer,
        },
      });
      if (!response.ok()) {
        lastError = new Error(`Catalogue HTTP ${response.status()}`);
        continue;
      }
      const json = await response.json();
      return json.response || json;
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error('Catalogue Deciplus inaccessible');
}

function flattenCatalog(response) {
  const products = [];
  for (const group of response || []) {
    const categoryId = group.id;
    const categoryTitle = group.title;
    for (const item of group.items || []) {
      if (item.enabled === 'N' || item.isArchived) continue;
      products.push({
        id: item.id,
        title: item.title,
        type: item.type || categoryId,
        categoryId,
        categoryTitle,
        price: Number(item.price || 0),
        reference: item.reference,
      });
    }
  }
  return products;
}

async function fetchDeciplusCatalog(page, { force = false } = {}) {
  const now = Date.now();
  if (!force && catalogCache.products.length && now - catalogCache.at < CATALOG_CACHE_MS) {
    return catalogCache.products;
  }

  const token = await ensureDeciplusAuth(page);
  if (!token) {
    const fallback = loadCatalogFallback();
    if (fallback) {
      catalogCache = { at: now, products: fallback };
      return fallback;
    }
    throw new Error('Token Deciplus introuvable — relancer login (session expirée)');
  }

  let data;
  try {
    data = await fetchCatalogFromApi(page, token);
  } catch (err) {
    logWarn('API catalogue Deciplus en échec', { error: err.message });
    const fallback = loadCatalogFallback();
    if (fallback) {
      catalogCache = { at: now, products: fallback };
      return fallback;
    }
    throw err;
  }

  const products = flattenCatalog(data);
  catalogCache = { at: now, products };
  logInfo('Catalogue Deciplus chargé', { count: products.length });
  return products;
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/€/g, 'e')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function scoreMatch(query, product) {
  const q = normalizeText(query);
  const title = normalizeText(product.title);
  if (!q || !title) return 0;
  if (q === title) return 100;
  if (title.includes(q) || q.includes(title)) return 80;
  const qTokens = q.split(' ').filter(Boolean);
  const tTokens = new Set(title.split(' ').filter(Boolean));
  const overlap = qTokens.filter((t) => tTokens.has(t)).length;
  if (overlap >= 2) return 50 + overlap * 5;
  if (overlap === 1 && qTokens.length === 1) return 40;
  return 0;
}

function findProductInCatalog(catalog, order) {
  const candidates = [
    order.product_reference,
    order.product_name,
    order.deciplus_product_name,
    order.offer,
  ].filter(Boolean);

  let best = null;
  let bestScore = 0;

  for (const query of candidates) {
    for (const product of catalog) {
      let score = scoreMatch(query, product);
      if (String(query).startsWith('dp-') && String(product.id) === String(query).replace(/^dp-/, '')) {
        score = Math.max(score, 100);
      }
      if (String(query).match(/^\d+$/) && String(product.id) === String(query)) {
        score = Math.max(score, 100);
      }
      if (order.payment?.amount > 0 && product.price > 0) {
        const diff = Math.abs(product.price - order.payment.amount);
        if (diff < 1) score += 15;
        else if (diff < 5) score += 5;
      }
      if (score > bestScore) {
        bestScore = score;
        best = product;
      }
    }
  }

  const query = candidates[0] || '';
  if (!best || bestScore < 40) {
    logWarn('Produit Deciplus non trouvé dans le catalogue', { query, bestScore });
    return null;
  }

  logInfo('Produit Deciplus résolu', {
    query,
    matched: best.title,
    score: bestScore,
  });
  return best;
}

function inferSaleType(product) {
  const type = product.type || product.categoryId || '';
  if (type === 'decipass' || /badge/i.test(product.title)) return 'carte';
  if (['seances', 'seance'].includes(type)) return 'carte';
  if (type === 'abo' || product.categoryId === 'abo') return 'abonnement';
  return 'abonnement';
}

function isTrialOrder(order) {
  const name = normalizeText(order.product_name || order.offer);
  return order.payment.amount === 0 || name.includes('essai');
}

function buildDeciplusProductSearch(title, productId = null) {
  const name = String(title || '').replace(/\s+/g, ' ').trim();
  if (!name) return productId ? String(productId) : '';

  if (/training camp/i.test(name)) return 'Training camp';
  if (/cours illimit/i.test(name)) return 'Cours illimités';

  const price = name.match(/(\d+[,.]\d{2})/);
  if (price) return price[1].replace(',', '.');

  const segments = name.split(/\s*-\s*/).map((s) => s.trim()).filter(Boolean);
  const shortestUseful = segments.find((s) => s.length >= 4 && s.length <= 35 && !/^offre/i.test(s));
  if (shortestUseful) return shortestUseful.replace(/\s*€.*$/i, '').trim();

  const stripped = name.replace(/\s*€.*$/i, '').trim();
  if (stripped.length <= 35) return stripped;
  return stripped.slice(0, 30);
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
    amount: order.payment.amount || matchedProduct.price,
    ...typeDefaults,
    sale_type: saleType,
    paiement_comptant: comptant,
    auto_badge: saleType === 'abonnement',
  };
}

function findBadgeProduct(catalog) {
  if (!catalog?.length) return null;

  const exact = catalog.find((p) => normalizeText(p.title) === 'badge');
  if (exact) return exact;

  return (
    catalog.find(
      (p) =>
        /badge/i.test(p.title || '') &&
        (p.type === 'decipass' || p.categoryId === 'decipass' || p.type === 'seances')
    ) || catalog.find((p) => /^badge$/i.test(String(p.title || '').trim())) || null
  );
}

function resolveBadgeProductConfig(catalog) {
  const matched = findBadgeProduct(catalog);
  if (!matched) {
    throw new Error('Produit Badge introuvable dans le catalogue Deciplus');
  }

  const defaults = loadJson('config/sale-defaults.json').carte;
  return {
    key: String(matched.id),
    label: matched.title,
    deciplus_product_name: matched.title,
    deciplus_product_search: 'Badge',
    deciplus_product_id: matched.id,
    amount: Number(matched.price) || 34.99,
    ...defaults,
    sale_type: 'carte',
    paiement_comptant: false,
    auto_badge: false,
  };
}

function resolveProductConfig(order, catalog) {
  if (isTrialOrder(order)) return buildProductConfig(order, null);
  if (order.deciplus_id) {
    const byId = catalog.find((p) => String(p.id) === String(order.deciplus_id));
    if (byId) return buildProductConfig(order, byId);
  }
  const matched = findProductInCatalog(catalog, order);
  return buildProductConfig(order, matched);
}

module.exports = {
  fetchDeciplusCatalog,
  findProductInCatalog,
  findBadgeProduct,
  resolveProductConfig,
  resolveBadgeProductConfig,
  buildProductConfig,
  normalizeText,
  inferSaleType,
  isTrialOrder,
  buildDeciplusProductSearch,
};
