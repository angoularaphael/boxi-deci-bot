'use strict';

const CATEGORY = Object.freeze({
  PAID_UNSIGNED_MEMBER: 'paid_unsigned_member',
  SIGNED_NO_SALE: 'signed_no_sale',
  SUCCESS_NO_SALE_ID: 'success_no_sale_id',
  SALE_MANDATE_MISSING: 'sale_mandate_missing',
  DUPLICATE_SUBSCRIPTION: 'duplicate_pending_active_subscription',
  BADGE_WITHOUT_CONTRACT: 'badge_without_expected_contract',
});

function requiresMandate(order = {}) {
  const snap = order.product_snapshot || {};
  const plan = String(order.payment?.billing_plan || '').toLowerCase();
  return snap.requires_iban === true || plan === 'rib' || plan === 'sepa';
}

function requiresSale(order = {}) {
  const snap = order.product_snapshot || {};
  if (snap.create_sale === false) return false;
  return String(snap.sale_type || order.sale_type || '').toLowerCase() !== 'none';
}

function categoriesForOrder(order = {}) {
  const out = [];
  const paid = String(order.payment?.status || '').toLowerCase() === 'paid';
  const signed = Boolean(order.signature?.signed_at || order.ready_for_dispatch);
  const member = Boolean(order.deciplus_member_id);
  const sale = Boolean(order.deciplus_sale_id);
  const status = String(order.bot_status || '').toLowerCase();
  const mandate = Boolean(order.reliability?.mandate_set_at || order.payment?.mandate_set_at);

  if (paid && !signed && member) out.push(CATEGORY.PAID_UNSIGNED_MEMBER);
  if (signed && paid && requiresSale(order) && !sale) out.push(CATEGORY.SIGNED_NO_SALE);
  if (status === 'success' && requiresSale(order) && !sale) out.push(CATEGORY.SUCCESS_NO_SALE_ID);
  if (sale && requiresMandate(order) && !mandate) out.push(CATEGORY.SALE_MANDATE_MISSING);
  if (order.reliability?.duplicate_subscription || Number(order.reliability?.active_subscription_count || 0) > 1) {
    out.push(CATEGORY.DUPLICATE_SUBSCRIPTION);
  }
  if (order.reliability?.badge_created && !order.reliability?.expected_contract_verified) {
    out.push(CATEGORY.BADGE_WITHOUT_CONTRACT);
  }
  return out;
}

function reconcileOrders(orders = [], options = {}) {
  const generatedAt = options.now ? new Date(options.now).toISOString() : new Date().toISOString();
  const anomalies = [];
  const compensation = [];
  for (const order of orders) {
    for (const category of categoriesForOrder(order)) {
      anomalies.push({
        order_id: order.order_id,
        category,
        severity: category === CATEGORY.PAID_UNSIGNED_MEMBER ? 'critical' : 'high',
        member_id: order.deciplus_member_id || null,
        sale_id: order.deciplus_sale_id || null,
        action: 'manual_review',
      });
    }
    if (
      String(order.payment?.status || '').toLowerCase() === 'paid' &&
      !order.signature?.signed_at &&
      !order.ready_for_dispatch
    ) {
      compensation.push({
        order_id: order.order_id,
        dry_run: true,
        proposed_action: order.deciplus_sale_id ? 'review_only_never_auto_cancel_sale' : 'contact_customer_or_expire_draft',
        member_id: order.deciplus_member_id || null,
        sale_id: order.deciplus_sale_id || null,
      });
    }
  }
  const counts = Object.fromEntries(Object.values(CATEGORY).map((key) => [key, 0]));
  for (const item of anomalies) counts[item.category] += 1;
  return {
    schema_version: 1,
    generated_at: generatedAt,
    mode: 'read_only_dry_run',
    checked: orders.length,
    counts,
    anomalies,
    compensation,
  };
}

module.exports = { CATEGORY, requiresMandate, requiresSale, categoriesForOrder, reconcileOrders };
