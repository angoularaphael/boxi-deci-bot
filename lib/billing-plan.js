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

function productSupportsBillingChoice(product) {
  if (!product || product.requires_iban === false) return false;
  if (/comptant/i.test(product.name || '')) return false;
  if (product.subsection === 'prelevement') return true;
  return /4\s*semaines/i.test(productText(product));
}

function normalizeBillingPlan(raw, product) {
  const plan = String(raw || '').trim().toLowerCase();
  if (VALID_PLANS.has(plan)) return plan;
  if (productSupportsBillingChoice(product)) return 'rib';
  if (product?.requires_iban) return 'rib';
  return null;
}

function requiresIbanForPlan(product, billingPlan) {
  const plan = normalizeBillingPlan(billingPlan, product);
  if (plan === 'cb') return false;
  if (plan === 'rib') return true;
  if (product?.requires_iban === false) return false;
  return Boolean(product?.requires_iban) && !/comptant/i.test(product?.name || '');
}

function paymentModeLabel(product, billingPlan) {
  const plan = normalizeBillingPlan(billingPlan, product);
  if (/comptant/i.test(product?.name || '') || product?.subsection === 'comptant') {
    return 'Paiement unique par carte — pas de prélèvement';
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
  if (/comptant/i.test(product?.name || '') || product?.subsection === 'comptant') {
    return { today: 'Paiement unique aujourd\'hui', next: 'Aucun prélèvement ensuite' };
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
      next: 'Échéances suivantes par prélèvement (IBAN)',
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
  normalizeBillingPlan,
  requiresIbanForPlan,
  paymentModeLabel,
  paymentTodayVsNextLabel,
  applyBillingPlanToProductConfig,
};
