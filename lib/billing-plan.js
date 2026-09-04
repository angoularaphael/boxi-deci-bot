'use strict';

/**
 * Paiement : RIB (1ère CB/PayPal puis SEPA) ou PayPal à la première échéance.
 * Comptant : carte / PayPal, pas d'IBAN, pas de badge auto.
 */

const VALID_PLANS = new Set(['rib', 'paypal', 'cb']);

/** Libellé Deciplus par défaut (offre 259 €). */
const PAYPLUG_4X_DECIPLUS_LABEL = '259€ EN 4X PRELEVEMENT';
const PAYPLUG_4X_DECIPLUS_SEARCH = '259 4x prelevement';

function productKeyHints(product = {}, order = {}) {
  const id = String(product.id || order.product_id || '').toLowerCase();
  const legacy = String(product.legacy_id || '').toLowerCase();
  const name = String(
    product.name || product.display_name || order.product_name || order.offer || ''
  ).toUpperCase();
  const priceCents = Number(product.price_cents || 0);
  const euros =
    priceCents > 0
      ? Math.round(priceCents / 100)
      : Number(order.payment?.amount || product.deciplus_price || 0) || null;
  return { id, legacy, name, euros };
}

/** Tuile Deciplus « 4× prélèvement » selon le produit boutique (259 €, enfants 250/295 €, …). */
function resolvePayplug4xPrelevementDeciplus(product = {}, order = {}) {
  const { id, legacy, name, euros } = productKeyHints(product, order);

  if (
    id === 'baby-boxe' ||
    legacy === 'baby-boxe' ||
    id === 'dp-93' ||
    /BABY\s*BOXE/.test(name) ||
    euros === 250
  ) {
    return {
      deciplus_product_name: 'BABY BOXE 250€ 4X SANS FRAIS',
      deciplus_product_search: 'baby boxe 250 4x',
      amount: 250,
    };
  }

  if (
    id === 'boxe-educative' ||
    legacy === 'boxe-educative' ||
    id === 'dp-45' ||
    /BOXE\s*EDUCATIVE/.test(name) ||
    euros === 295
  ) {
    return {
      deciplus_product_name: 'ENFANTS 295€ 4x SANS FRAIS',
      deciplus_product_search: 'enfants 295 4x',
      amount: 295,
    };
  }

  if (
    id === 'offre-saison' ||
    legacy === 'offre-saison' ||
    id === 'dp-100' ||
    /OFFRE\s*PROMO\s*12\s*MOIS|PROMO\s*12\s*MOIS/.test(name) ||
    euros === 259
  ) {
    return {
      deciplus_product_name: PAYPLUG_4X_DECIPLUS_LABEL,
      deciplus_product_search: PAYPLUG_4X_DECIPLUS_SEARCH,
      amount: 259,
    };
  }

  if (euros && euros > 0) {
    return {
      deciplus_product_name: `${euros}€ EN 4X PRELEVEMENT`,
      deciplus_product_search: `${euros} 4x prelevement`,
      amount: euros,
    };
  }

  return {
    deciplus_product_name: PAYPLUG_4X_DECIPLUS_LABEL,
    deciplus_product_search: PAYPLUG_4X_DECIPLUS_SEARCH,
    amount: 259,
  };
}

/** 4× PayPlug sans Oney : 25 % CB maintenant, puis RIB et vente Deciplus en prélèvement. */
function isPayplug4xPrelevement(paymentPlan, billingPlan) {
  return (
    String(paymentPlan || '').toLowerCase() === '4x' &&
    String(billingPlan || '').toLowerCase() === 'rib'
  );
}

function isPayplug4xPrelevementOrder(order = {}) {
  const payment = order.payment || {};
  const paymentPlan = String(order.payment_plan || payment.payment_plan || '').toLowerCase();
  const billingPlan = String(order.billing_plan || payment.billing_plan || '').toLowerCase();
  if (isPayplug4xPrelevement(paymentPlan, billingPlan)) return true;

  const meta = payment.metadata || order.metadata || {};
  if (
    meta.payplug_4x_prelevement === '1' ||
    meta.payplug_4x_prelevement === true ||
    payment.payplug_4x_prelevement === true ||
    order.payplug_4x_prelevement === true
  ) {
    return true;
  }

  const method = String(payment.method || order.payment_method || '').toLowerCase();
  if (method !== 'payplug') return false;

  const paid = Number(payment.amount);
  const priceCents = Number(
    order.product_snapshot?.price_cents || order.price_cents || payment.product_price_cents
  );
  if (Number.isFinite(paid) && priceCents >= 20000) {
    const quarter = Math.round(priceCents / 4) / 100;
    const full = priceCents / 100;
    const isQuarter = Math.abs(paid - quarter) < 0.02 && Math.abs(paid - full) > 0.02;
    if (isQuarter && (paymentPlan === '4x' || billingPlan === 'rib' || order.requires_iban === true)) {
      return true;
    }
  }

  return paymentPlan === '4x' && billingPlan === 'rib';
}

function productText(product = {}) {
  return [
    product.name,
    product.tagline,
    product.description,
    product.duration_label,
    product.display_name,
  ]
    .filter(Boolean)
    .join(' ');
}

function isComptantStyleProduct(product = {}) {
  const text = productText(product);
  if (/comptant/i.test(product.name || '') || product.subsection === 'comptant') return true;
  if (product.supports_installment_choice) return true;
  if (/OFFRE\s*PROMO\s*12\s*MOIS/i.test(text)) return true;
  if (/4\s*[x×]\s*sans\s*frais/i.test(text) || /sans\s*frais/i.test(product.badge || '')) return true;
  if (/1\s*[x×]\s*ou\s*4\s*[x×]/i.test(product.badge || '')) return true;
  // id live dp-100 / legacy offre-saison
  if (productSupportsInstallmentChoice(product)) return true;
  return false;
}

const ADULT_MIN_AGE = 15;
const ADULT_OFFER_AGE_MESSAGE =
  'Cette offre est réservée aux adultes (15 ans et plus). Pour un enfant, choisissez Baby Boxe ou Boxe éducative.';

function isChildOfferProduct(product = {}) {
  if (!product) return false;
  if (product.subsection === 'enfants') return true;
  const id = String(product.id || '');
  const legacy = String(product.legacy_id || '');
  if (id === 'baby-boxe' || legacy === 'baby-boxe' || id === 'dp-93') return true;
  if (id === 'boxe-educative' || legacy === 'boxe-educative' || id === 'dp-45') return true;
  const title = String(product.name || product.display_name || '');
  return /BABY\s*BOXE/i.test(title) || /BOXE\s*[EÉ]DUCATIVE/i.test(title);
}

function ageFromBirthdate(value, at = new Date()) {
  const raw = String(value || '').trim();
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const birth = new Date(y, mo - 1, d);
  if (birth.getFullYear() !== y || birth.getMonth() !== mo - 1 || birth.getDate() !== d) return null;
  let age = at.getFullYear() - y;
  if (at.getMonth() < mo - 1 || (at.getMonth() === mo - 1 && at.getDate() < d)) age -= 1;
  return age;
}

function adultOfferAgeError(birthdate, product) {
  if (isChildOfferProduct(product)) return null;
  const age = ageFromBirthdate(birthdate);
  if (age == null) return 'Date de naissance requise';
  if (age < ADULT_MIN_AGE) return ADULT_OFFER_AGE_MESSAGE;
  return null;
}

/** Offres comptant 1× / 4× : 259 €, Baby Boxe, Boxe éducative (Deciplus reste paiement comptant). */
function productSupportsInstallmentChoice(product = {}) {
  if (!product) return false;
  if (product.supports_installment_choice === true) return true;
  const id = String(product.id || '');
  const legacy = String(product.legacy_id || '');
  // Catalogue live = dp-100 + legacy_id offre-saison
  if (id === 'offre-saison' || legacy === 'offre-saison') return true;
  // dp-93 / dp-45 — enfants, paiement comptant (pas prélèvement)
  if (id === 'baby-boxe' || legacy === 'baby-boxe' || id === 'dp-93') return true;
  if (id === 'boxe-educative' || legacy === 'boxe-educative' || id === 'dp-45') return true;
  const title = String(product.name || product.display_name || '');
  if (/OFFRE\s*PROMO\s*12\s*MOIS/i.test(title)) return true;
  if (/BABY\s*BOXE/i.test(title) || /BOXE\s*EDUCATIVE/i.test(title)) return true;
  return /1\s*[x×]\s*ou\s*4\s*[x×]/i.test(String(product.badge || ''));
}

function normalizePaymentPlan(raw, product) {
  const plan = String(raw || '').trim().toLowerCase();
  if (!productSupportsInstallmentChoice(product)) return null;
  if (plan === '4x' || plan === 'payplug_4x' || plan === 'payplug-4x') return '4x';
  if (plan === 'once' || plan === '1x' || plan === 'une_fois' || plan === 'une-fois') return 'once';
  return null;
}

/** Affiche le choix Prélèvement vs PayPal (plus de CB récurrente). */
function productSupportsBillingChoice(product) {
  if (!product || product.requires_iban === false) return false;
  if (isComptantStyleProduct(product)) return false;
  if (product.subsection === 'prelevement') return true;
  return /4\s*semaines/i.test(productText(product)) || Boolean(product.requires_iban);
}

function normalizeBillingPlan(raw, product) {
  const plan = String(raw || '').trim().toLowerCase();
  if (isComptantStyleProduct(product)) return null;
  if (VALID_PLANS.has(plan)) return plan;
  if (productSupportsBillingChoice(product)) return 'rib';
  if (product?.requires_iban) return 'rib';
  return null;
}

/** Badge auto uniquement pour abonnements à échéances (pas comptant). */
function productNeedsAutoBadge(product = {}) {
  if (!product) return false;
  const { isCartePrestationOrder } = require('./catalog-sale');
  if (
    isCartePrestationOrder({
      product_id: product.id || product.product_id,
      product_name: product.name || product.display_name || product.product_name,
      sale_type: product.sale_type,
    })
  ) {
    return false;
  }
  if (isComptantStyleProduct(product)) return false;
  if (product.auto_badge === false) return false;
  if (product.auto_badge === true) return true;
  if (product.sale_type === 'abonnement') return true;
  if (product.requires_iban) return true;
  const cat = String(product.category || '');
  return /abonnement/i.test(cat) && product.requires_payment !== false;
}

function requiresIbanForPlan(product, billingPlan, paymentPlan) {
  if (isPayplug4xPrelevement(paymentPlan, billingPlan)) return true;
  if (isComptantStyleProduct(product)) return false;
  if (product?.requires_iban === false) return false;
  const plan = normalizeBillingPlan(billingPlan, product);
  if (plan === 'rib' || plan === 'paypal') return true;
  if (product?.requires_iban) return true;
  return productNeedsAutoBadge(product);
}

function paymentPeriodLabel(product = {}) {
  const text = productText(product);
  if (/4\s*semaines/i.test(text)) return '4 semaines';
  const m = String(product.duration_label || product.name || '').match(/(\d+)\s*mois/i);
  if (m) return `${m[1]} mois`;
  if (product.duration_label) return String(product.duration_label).replace(/^\/\s*/, '');
  return 'période';
}

function firstPaymentAmountLabel(product = {}) {
  const amount = product.stripe_price_label || product.price_label || '—';
  if (isComptantStyleProduct(product)) {
    return `Paiement de : ${amount}`;
  }
  if (product.requires_iban || productSupportsBillingChoice(product)) {
    return `Paiement de la première échéance de : ${amount}/(${paymentPeriodLabel(product)})`;
  }
  return `Paiement de : ${amount}`;
}

function paymentModeLabel(product, billingPlan, paymentPlan) {
  const installment = normalizePaymentPlan(paymentPlan, product);
  if (installment === '4x' && isPayplug4xPrelevement(installment, billingPlan)) {
    return '4× sans frais PayPlug — 25 % par carte, puis prélèvement';
  }
  if (installment === '4x') {
    return 'Paiement en 4× sans frais';
  }
  if (installment === 'once' || productSupportsInstallmentChoice(product)) {
    return 'Paiement en une fois — carte ou PayPal';
  }
  const plan = normalizeBillingPlan(billingPlan, product);
  if (isComptantStyleProduct(product)) {
    return 'Paiement en une fois — carte ou PayPal';
  }
  if (plan === 'paypal') {
    // « 1ere » sans exposants Unicode : Helvetica/PDFKit ne rend pas ʳᵉ
    return '1ere échéance PayPal, puis prélèvement sans engagement';
  }
  if (plan === 'rib' || product?.requires_iban) {
    return '1ere échéance par carte, puis prélèvement sans engagement';
  }
  if (productSupportsBillingChoice(product)) {
    return 'Sans engagement — carte, PayPal ou prélèvement';
  }
  return 'Paiement sécurisé par carte ou PayPal';
}

function paymentTodayVsNextLabel(product, billingPlan, paymentPlan) {
  const installment = normalizePaymentPlan(paymentPlan, product);
  if (!product?.requires_payment) return { today: 'Gratuit', next: null };
  if (installment === '4x') {
    return { today: 'Réglé en 4× sans frais', next: null };
  }
  if (installment === 'once' || productSupportsInstallmentChoice(product)) {
    return { today: 'Réglé en une seule fois', next: null };
  }
  const plan = normalizeBillingPlan(billingPlan, product);
  if (isComptantStyleProduct(product)) {
    return { today: 'Paiement en une fois (carte ou PayPal)', next: null };
  }
  if (plan === 'paypal') {
    return {
      today: '1ere échéance PayPal aujourd\'hui',
      next: 'Prochaines échéances par prélèvement sans engagement',
    };
  }
  if (plan === 'rib' || product?.requires_iban || productSupportsBillingChoice(product)) {
    return {
      today: '1ere échéance par carte aujourd\'hui',
      next: 'Prochaines échéances par prélèvement sans engagement',
    };
  }
  return { today: 'Paiement sécurisé par carte ou PayPal', next: null };
}

function applyBillingPlanToProductConfig(config, order) {
  const plan = normalizeBillingPlan(
    order?.payment?.billing_plan || order?.billing_plan,
    { requires_iban: order?.requires_iban !== false, name: order?.product_name }
  );
  if (plan !== 'cb') return config;

  return {
    ...config,
    requires_iban: false,
    skip_rib_prompt: true,
    payment_mode: 'card',
    billing_plan: 'cb',
  };
}

function invoiceTypeLabel(product, billingPlan) {
  const { documentTypeLabel } = require('./offer-document-copy');
  return documentTypeLabel(product, { billingPlan });
}

module.exports = {
  VALID_PLANS,
  PAYPLUG_4X_DECIPLUS_LABEL,
  PAYPLUG_4X_DECIPLUS_SEARCH,
  resolvePayplug4xPrelevementDeciplus,
  isPayplug4xPrelevement,
  isPayplug4xPrelevementOrder,
  ADULT_MIN_AGE,
  ADULT_OFFER_AGE_MESSAGE,
  isChildOfferProduct,
  ageFromBirthdate,
  adultOfferAgeError,
  productSupportsBillingChoice,
  productSupportsInstallmentChoice,
  isComptantStyleProduct,
  productNeedsAutoBadge,
  normalizeBillingPlan,
  normalizePaymentPlan,
  requiresIbanForPlan,
  paymentModeLabel,
  paymentTodayVsNextLabel,
  paymentPeriodLabel,
  firstPaymentAmountLabel,
  invoiceTypeLabel,
  applyBillingPlanToProductConfig,
};
