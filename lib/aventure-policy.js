/**
 * Parcours Aventure Balma — règles métier (pas de migration, pas de résil).
 */
function aventureBotPolicy() {
  return {
    skip_cancel: true,
    skip_migrate: true,
    skip_restore: true,
    create_duplicate: true,
    search_gym: 'balma',
    create_gym: 'minimes',
    dispatch_after: 'dossier',
  };
}

function isAventureOrder(order = {}) {
  const src = String(order.source || order.utm?.source || '').toLowerCase();
  return (
    order.aventure === true ||
    order.skip_dossier === true ||
    src === 'balma_retour' ||
    src.includes('balma_retour')
  );
}

/** Après paiement (ou abandon) : IBAN si besoin, sinon dossier sans tél./mail. */
function aventureAfterPaymentStep(order = {}, product = {}) {
  try {
    const { requiresIbanForPlan } = require('./billing-plan');
    const paid = String(order.payment?.status || '').toLowerCase() === 'paid';
    const snap = product || order.product_snapshot || {};
    const plan = order.payment?.billing_plan;
    if (paid && requiresIbanForPlan(snap, plan) && !order.payment?.iban) return 5;
  } catch {
    /* billing-plan indispo en test isolé */
  }
  return 6;
}

module.exports = { aventureBotPolicy, isAventureOrder, aventureAfterPaymentStep };
