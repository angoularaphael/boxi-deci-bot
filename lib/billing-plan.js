'use strict';

/**
 * Paiement : RIB (1ère CB/PayPal puis SEPA) ou PayPal à la première échéance.
 * Comptant : carte / PayPal, pas d'IBAN, pas de badge auto.
 */

const VALID_PLANS = new Set(['rib', 'paypal', 'cb']);

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
  if (/4\s*[x×]\s*sans\s*frais/i.test(text) || /sans\s*frais/i.test(product.badge || '')) return true;
  if (/1\s*[x×]\s*ou\s*4\s*[x×]/i.test(product.badge || '')) return true;
  return false;
}

/** Offre 259 € : le client choisit 1× Stripe ou 4× PayPlug (Deciplus reste comptant). */
function productSupportsInstallmentChoice(product = {}) {
  if (!product) return false;
  if (product.supports_installment_choice === true) return true;
  if (String(product.id || '') === 'offre-saison') return true;
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
  if (isComptantStyleProduct(product)) return false;
  if (product.auto_badge === false) return false;
  if (product.auto_badge === true) return true;
  if (product.sale_type === 'abonnement') return true;
  if (product.requires_iban) return true;
  const cat = String(product.category || '');
  return /abonnement/i.test(cat) && product.requires_payment !== false;
}

function requiresIbanForPlan(product, billingPlan) {
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
  if (installment === '4x') {
    return '4× sans frais — PayPlug (Oney)';
  }
  if (installment === 'once' || productSupportsInstallmentChoice(product)) {
    return 'Paiement en une fois — Stripe (carte ou PayPal)';
  }
  const plan = normalizeBillingPlan(billingPlan, product);
  if (isComptantStyleProduct(product)) {
    return 'Paiement comptant — carte ou PayPal';
  }
  if (plan === 'paypal') {
    return 'Échéances — 1ère PayPal, puis prélèvement SEPA';
  }
  if (plan === 'rib' || product?.requires_iban) {
    return 'Échéances — 1ère CB, puis prélèvement SEPA';
  }
  if (productSupportsBillingChoice(product)) {
    return 'Échéances — prélèvement (RIB) ou PayPal';
  }
  return 'Paiement par carte ou PayPal';
}

function paymentTodayVsNextLabel(product, billingPlan, paymentPlan) {
  const installment = normalizePaymentPlan(paymentPlan, product);
  if (!product?.requires_payment) return { today: 'Gratuit', next: null };
  if (installment === '4x') {
    return { today: '4× sans frais via PayPlug', next: 'Vente Deciplus enregistrée en comptant' };
  }
  if (installment === 'once' || productSupportsInstallmentChoice(product)) {
    return { today: 'Paiement en une fois via Stripe', next: 'Vente Deciplus enregistrée en comptant' };
  }
  const plan = normalizeBillingPlan(billingPlan, product);
  if (isComptantStyleProduct(product)) {
    return { today: 'Paiement comptant (carte ou PayPal)', next: null };
  }
  if (plan === 'paypal') {
    return {
      today: '1ère échéance PayPal aujourd\'hui',
      next: 'Échéances suivantes par prélèvement (IBAN) · badge ~72h',
    };
  }
  if (plan === 'rib' || product?.requires_iban || productSupportsBillingChoice(product)) {
    return {
      today: '1ère échéance par carte aujourd\'hui',
      next: 'Échéances suivantes par prélèvement (IBAN) · badge ~72h',
    };
  }
  return { today: 'Paiement par carte ou PayPal aujourd\'hui', next: null };
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
  if (isComptantStyleProduct(product)) return 'Paiement comptant';
  if (product?.requires_iban || normalizeBillingPlan(billingPlan, product) === 'rib' || normalizeBillingPlan(billingPlan, product) === 'paypal') {
    return 'Abonnement Prélèvement';
  }
  return 'Abonnement';
}

module.exports = {
  VALID_PLANS,
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
