/**
 * Campagne Balma → Boxing Center.
 * Auto-migration sur toutes les ventes : désactivée par défaut
 * (BALMA_AUTOMIGRATE_ON_SALE=0). Uniquement la page Aventure.
 */

const BALMA_SOURCE = 'balma_retour';
const AVENTURE_HOST = 'aventure.boxingcenter.fr';
const AVENTURE_PATH = '/aventure';
const CLUB_CONTACT = 'boxingcenter31@gmail.com';
const COUR_DES_MIRACLES_EMAIL = 'contactgotatoulouse@gmail.com';

function isBalmaRetourSource(value) {
  const raw = String(value || '')
    .trim()
    .toLowerCase();
  return raw === BALMA_SOURCE || raw === 'balma' || raw.includes('balma_retour');
}

function isBalmaRetourOrder(order = {}) {
  return (
    isBalmaRetourSource(order.source) ||
    isBalmaRetourSource(order.utm?.source) ||
    isBalmaRetourSource(order.utm?.campaign)
  );
}

function isOffre29Product(product = {}, order = {}) {
  const ids = [product.id, product.product_id, product.legacy_id, order.product_id]
    .filter(Boolean)
    .map((v) => String(v).toLowerCase());
  if (ids.some((id) => id === 'offre-duo' || id === 'offre_29' || id === 'dp-104')) return true;
  const name = String(product.name || product.display_name || order.product_name || '');
  return /29[,.]?99|offre\s*duo|offre\s*a\s*29/i.test(name);
}

function isOffre259Product(product = {}, order = {}) {
  const ids = [product.id, product.product_id, product.legacy_id, order.product_id]
    .filter(Boolean)
    .map((v) => String(v).toLowerCase());
  if (ids.some((id) => id === 'offre-saison' || id === 'offre_259' || id === 'dp-100')) return true;
  const name = String(product.name || product.display_name || order.product_name || '');
  return /offre\s*saison|259\s*€|OFFRE\s*PROMO\s*12\s*MOIS/i.test(name);
}

/** Badge 34,99 € en comptant uniquement si source Balma + offre 29. */
function shouldGiftBadgeComptant(order = {}, product = {}) {
  return isBalmaRetourOrder(order) && isOffre29Product(product, order);
}

function balmaBadgePaymentFields(order = {}, product = {}) {
  if (!shouldGiftBadgeComptant(order, product)) return null;
  return {
    badge_timing: 'immediate',
    badge_method: 'comptant',
    badge_paiement_comptant: true,
  };
}

function isBalmaAutomigrateOnSaleEnabled() {
  return String(process.env.BALMA_AUTOMIGRATE_ON_SALE || '0') === '1';
}

function isAventureHost(req) {
  const host = String(req?.headers?.host || req?.get?.('host') || '')
    .split(':')[0]
    .toLowerCase();
  return host === AVENTURE_HOST || host.startsWith('aventure.');
}

function isLocalStorefrontHost(req) {
  const host = String(req?.headers?.host || req?.get?.('host') || '')
    .split(':')[0]
    .toLowerCase();
  return host === 'localhost' || host === '127.0.0.1';
}

/** Email PSP uniquement — jamais copié sur la fiche Minimes. */
function aventurePspEmail(order = {}) {
  const id = String(order.order_id || 'aventure')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '')
    .slice(0, 32);
  return `aventure.${id || 'test'}@boxplus-test.local`;
}

/** Page Aventure de preview : `npm run dev` (localhost) ou session studio. */
function shouldServeAventurePreview(req, { studio = false } = {}) {
  return isLocalStorefrontHost(req) || Boolean(studio);
}

function isNoneOffer(offer) {
  const raw = String(offer || '')
    .trim()
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/\s+/g, '-');
  return [
    'none',
    'aucune',
    'no_offer',
    'no-offer',
    'pas-doffre',
    'pas-d-offre',
    'sans',
    'sans-offre',
  ].includes(raw);
}

function offerToProductId(offer) {
  const raw = String(offer || '')
    .trim()
    .toLowerCase();
  if (!raw) return '';
  if (isNoneOffer(raw)) return 'none';
  if (raw === '29' || raw === 'offre_29' || raw === 'duo' || raw === 'offre-duo') return 'offre-duo';
  if (raw === '259' || raw === 'offre_259' || raw === 'saison' || raw === 'offre-saison') {
    return 'offre-saison';
  }
  return String(offer || '').trim();
}

function findAventureOffer(offerId) {
  const id = offerToProductId(offerId);
  if (id === 'none') return null;
  if (id === 'offre-duo' || id === 'offre-saison') {
    try {
      const { findEnrichedProduct } = require('../storefront/lib/merch');
      const product = findEnrichedProduct(id);
      if (product) return product;
    } catch {
      /* catalogue indispo en test isolé */
    }
    return { id, legacy_id: id, product_id: id };
  }
  return findBalmaPrelevementOffer(id);
}

function isBalmaPrelevementProduct(product = {}) {
  if (!product || !product.id) return false;
  const { isComptantStyleProduct, productSupportsBillingChoice } = require('./billing-plan');
  if (isComptantStyleProduct(product)) return false;
  if (!productSupportsBillingChoice(product)) return false;
  const id = String(product.id || '');
  const legacy = String(product.legacy_id || '');
  const name = String(product.name || product.display_name || '');
  if (id === 'badge' || legacy === 'badge') return false;
  if (id === 'association' || /association/i.test(name)) return false;
  if (id === 'offre-ete' || /OFFRE\s*ETE/i.test(name)) return false;
  const tab = String(product.tab || product.category || '').toLowerCase();
  if (tab && !/abonnement/i.test(tab)) return false;
  return true;
}

function listBalmaPrelevementOffers() {
  const { getEnrichedProducts } = require('../storefront/lib/merch');
  return (getEnrichedProducts({ tab: 'abonnements', activeOnly: true }) || [])
    .filter(isBalmaPrelevementProduct)
    .map((p) => ({
      id: p.legacy_id || p.id,
      product_id: p.id,
      name: p.display_name || p.name,
      tagline: p.tagline || p.installments_note || p.duration_label || 'Prélèvement sans engagement',
      price_label: p.marketing_price_label || p.price_label || '',
      price_cents: p.price_cents || 0,
    }));
}

function findBalmaPrelevementOffer(offerId) {
  const id = offerToProductId(offerId);
  if (!id) return null;
  try {
    const { findEnrichedProduct } = require('../storefront/lib/merch');
    const product = findEnrichedProduct(id);
    if (product && isBalmaPrelevementProduct(product)) return product;
  } catch {
    /* catalogue indispo en test isolé */
  }
  return listBalmaPrelevementOffers().find((p) => p.id === id || p.product_id === id) || null;
}

function inscriptionUrl({
  productId,
  firstName,
  lastName,
  birthdate,
  boutiqueBase,
  orderId,
  token,
}) {
  const base = String(boutiqueBase || 'https://boutique.boxingcenter.fr').replace(/\/$/, '');
  const params = new URLSearchParams({
    source: BALMA_SOURCE,
    aventure: '1',
    step: '4',
  });
  if (productId) params.set('product', productId);
  if (orderId) params.set('order', orderId);
  if (token) params.set('token', token);
  if (firstName) params.set('prenom', firstName);
  if (lastName) params.set('nom', lastName);
  if (birthdate) params.set('birthdate', birthdate);
  return `${base}/inscription?${params.toString()}`;
}

function normalizeBirthdate(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const fr = raw.match(/^(\d{1,2})[\/.](\d{1,2})[\/.](\d{4})$/);
  if (fr) {
    const d = fr[1].padStart(2, '0');
    const m = fr[2].padStart(2, '0');
    return `${fr[3]}-${m}-${d}`;
  }
  return raw;
}

function validateBirthdate(value) {
  const raw = normalizeBirthdate(value);
  if (!raw) return 'Date de naissance requise';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return 'Date de naissance invalide';
  const [y, m, d] = raw.split('-').map(Number);
  if (y < 1900 || y > new Date().getFullYear()) return 'Année de naissance invalide';
  const dt = new Date(y, m - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) {
    return 'Date de naissance invalide';
  }
  if (dt > new Date()) return 'Date de naissance invalide';
  return null;
}

function validateBalmaSwitchPayload(body = {}) {
  const errors = [];
  const first_name = String(body.first_name || body.prenom || '').trim();
  const last_name = String(body.last_name || body.nom || '').trim();
  const birthdate = normalizeBirthdate(body.birthdate || body.naissance || body.date_naissance);
  const prelevement =
    body.prelevement === true ||
    body.prelevement === '1' ||
    body.prelevement === 'on' ||
    body.prelevement === 'true';
  const offer = offerToProductId(body.offer || body.offre || body.product);
  const none = isNoneOffer(offer);
  const product = none ? null : findAventureOffer(offer);
  const offerMissing = 'Choisis l’offre 29 € ou 259 €';

  if (!first_name) errors.push('Prénom requis');
  if (!last_name) errors.push('Nom requis');
  const emailRaw = String(body.email || '').trim().toLowerCase();
  const birthErr = validateBirthdate(birthdate);
  if (birthErr) errors.push(birthErr);
  let email = '';
  if (emailRaw) {
    if (!emailRaw.includes('@')) errors.push('Email invalide');
    else email = emailRaw;
  }
  if (!offer) errors.push(offerMissing);
  if (!prelevement) {
    errors.push(
      `Cette page est réservée aux adhérents en prélèvement. Si tu es en paiement comptant, contacte le club : ${CLUB_CONTACT}`
    );
  }
  if (offer && !none && !product) {
    errors.push(offerMissing);
  }
  return {
    errors,
    first_name,
    last_name,
    email,
    birthdate,
    prelevement,
    offer: none
      ? 'none'
      : (product && (product.legacy_id || product.product_id || product.id)) || offer,
    product,
    skip_restore: true,
  };
}

function buildBalmaSwitchOrder({ first_name, last_name, birthdate, email, offer, skip_restore }) {
  const stamp = Date.now();
  const none = isNoneOffer(offer);
  return {
    order_id: `BALMA-${stamp}`,
    action: 'balma_switch',
    gym: 'minimes',
    source: BALMA_SOURCE,
    offer: none ? 'none' : offer,
    product_id: none ? null : offer,
    skip_restore: skip_restore !== false,
    snapshots: [],
    customer: {
      first_name,
      last_name,
      birthdate: birthdate || '',
      email: email || '',
      phone: '',
    },
    payment: { status: 'pending', amount: 0 },
  };
}

module.exports = {
  BALMA_SOURCE,
  AVENTURE_HOST,
  AVENTURE_PATH,
  CLUB_CONTACT,
  COUR_DES_MIRACLES_EMAIL,
  isBalmaRetourSource,
  isBalmaRetourOrder,
  isOffre29Product,
  isOffre259Product,
  shouldGiftBadgeComptant,
  balmaBadgePaymentFields,
  isBalmaAutomigrateOnSaleEnabled,
  isAventureHost,
  isLocalStorefrontHost,
  aventurePspEmail,
  shouldServeAventurePreview,
  isNoneOffer,
  offerToProductId,
  isBalmaPrelevementProduct,
  listBalmaPrelevementOffers,
  findBalmaPrelevementOffer,
  inscriptionUrl,
  validateBalmaSwitchPayload,
  buildBalmaSwitchOrder,
};
