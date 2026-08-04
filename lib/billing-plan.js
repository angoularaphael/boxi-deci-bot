'use strict';

/**
 * Formules 4 semaines sans engagement — choix RIB (SEPA) ou CB récurrente (Stripe).
 */

const VALID_PLANS = new Set(['rib', 'cb']);

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

function productSupportsBillingChoice(_product) {
  // Plus de choix RIB vs CB récurrente — prélèvement seul (sauf offres comptant / 4× sans frais).
  return false;
}

function isComptantStyleProduct(product = {}) {
  const text = productText(product);
  if (/comptant/i.test(product.name || '') || product.subsection === 'comptant') return true;
  if (/4\s*[x×]\s*sans\s*frais/i.test(text) || /sans\s*frais/i.test(product.badge || '')) return true;
  return false;
}

function normalizeBillingPlan(raw, product) {
  const plan = String(raw || '').trim().toLowerCase();
  if (isComptantStyleProduct(product)) return null;
  if (VALID_PLANS.has(plan)) {
    // CB récurrente désactivée — forcer RIB pour les formules à prélèvement
    if (plan === 'cb' && product?.requires_iban) return 'rib';
    return plan;
  }
  if (product?.requires_iban) return 'rib';
  return null;
}

function requiresIbanForPlan(product, billingPlan) {
  const plan = normalizeBillingPlan(billingPlan, product);
  if (plan === 'cb') return false;
  if (plan === 'rib') return true;
  if (product?.requires_iban === false) return false;
  // Badge ~72h toujours en IBAN pour les abonnements (y compris comptant)
  if (productNeedsAutoBadge(product)) return true;
  return Boolean(product?.requires_iban) && !isComptantStyleProduct(product);
}

function productNeedsAutoBadge(product = {}) {
  if (!product) return false;
  if (product.sale_type === 'abonnement') return true;
  if (product.auto_badge === true) return true;
  if (product.requires_iban) return true;
  const cat = String(product.category || '');
  return /abonnement/i.test(cat) && product.requires_payment !== false;
}

function paymentModeLabel(product, billingPlan) {
  const plan = normalizeBillingPlan(billingPlan, product);
  if (isComptantStyleProduct(product)) {
    return 'Paiement par carte — pas de prélèvement abonnement';
  }
  if (plan === 'cb') return 'Échéances carte — débit automatique toutes les 4 semaines';
  if (plan === 'rib' || product?.requires_iban) {
    return 'Échéances — 1ère CB aujourd\'hui, puis prélèvement SEPA';
  }
  if (productSupportsBillingChoice(product)) {
    return 'Échéances 4 semaines — RIB ou carte au choix';
  }
  return 'Paiement par carte';
}

function paymentTodayVsNextLabel(product, billingPlan) {
  const plan = normalizeBillingPlan(billingPlan, product);
  if (!product?.requires_payment) return { today: 'Gratuit', next: null };
  if (isComptantStyleProduct(product)) {
    return { today: 'Paiement par carte aujourd\'hui', next: 'Badge d\'accès prélevé ~72h (IBAN)' };
  }
  if (plan === 'cb') {
    return {
      today: '1ère échéance par carte aujourd\'hui',
      next: 'Renouvellement carte toutes les 4 semaines',
    };
  }
  if (plan === 'rib' || product?.requires_iban || productSupportsBillingChoice(product)) {
    return {
      today: '1ère échéance par carte aujourd\'hui',
      next: 'Échéances suivantes par prélèvement (IBAN) · badge ~72h',
    };
  }
  return { today: 'Paiement par carte aujourd\'hui', next: null };
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

module.exports = {
  VALID_PLANS,
  productSupportsBillingChoice,
  isComptantStyleProduct,
  productNeedsAutoBadge,
  normalizeBillingPlan,
  requiresIbanForPlan,
  paymentModeLabel,
  paymentTodayVsNextLabel,
  applyBillingPlanToProductConfig,
};
