#!/usr/bin/env node
'use strict';
/**
 * Leo Villars — recréer l’abo 29 € payé (BC-1788370988650-7cbcf9) + 1 badge.
 * Déjà sur Minimes : aucune migration.
 *
 *   node scripts/fix-leo-villars-sale.js --check
 *   node scripts/fix-leo-villars-sale.js
 */
require('dotenv').config();
process.env.BOXPLUS_ORDERS_REMOTE = '1';
process.env.DECIPLUS_FAST = process.env.DECIPLUS_FAST || '1';
process.env.DECIPLUS_HEADLESS = process.env.DECIPLUS_HEADLESS || 'true';
delete process.env.PLAYWRIGHT_BROWSERS_PATH;
delete process.env.BOXPLUS_HOSTED;
delete process.env.BOXPLUS_BOT_URL;
delete process.env.BOXPLUS_BOT_URL_OPS;

const fs = require('fs');
const path = require('path');
const { getSupabase } = require('../storefront/lib/supabase');
const { getGymConfig } = require('../lib/normalize');
const { applyBillingPlanToProductConfig, orderNeedsAutoBadge } = require('../lib/billing-plan');
const { applyBotSaleStatus } = require('../storefront/lib/order-lifecycle');
const { login } = require('../bot/auth');
const { runWithSession, closeBrowser } = require('../bot/browser-pool');
const { switchDeciplusSite } = require('../bot/deciplus-zone');

const CHECK = process.argv.includes('--check');
const ORDER_ID = 'BC-1788370988650-7cbcf9';
const MEMBER_ID = '21564';
const OUT = path.join(__dirname, '..', 'data', `fix-leo-villars-${Date.now()}.json`);

function slim(c) {
  return {
    idc: c.idc,
    badge: Boolean(c.isBadge),
    label: String(c.label || '').replace(/\s+/g, ' ').slice(0, 160),
  };
}

async function loadOrder() {
  const sb = getSupabase();
  const { data, error } = await sb.from('boxplus_orders').select('payload').eq('order_id', ORDER_ID).single();
  if (error) throw error;
  return data.payload || {};
}

function saleOrder(payload) {
  const cs = payload.customer_short || {};
  const cf = payload.customer_full || {};
  const pay = payload.payment || {};
  return {
    order_id: ORDER_ID,
    product_id: payload.product_id || 'dp-104',
    product_name: payload.product_name || payload.product_snapshot?.display_name || 'Sans engagement — 29 €',
    deciplus_product_search: payload.deciplus_product_search || 'OFFRE A 29',
    gym: 'minimes',
    deciplus_member_id: MEMBER_ID,
    deciplus_sale_id: null,
    paiement_comptant: false,
    requires_iban: true,
    billing_plan: pay.billing_plan || 'rib',
    payment: {
      status: 'paid',
      amount: pay.amount || 29.99,
      method: pay.method || 'payplug',
      payment_plan: pay.payment_plan || 'recurring',
      billing_plan: pay.billing_plan || 'rib',
      iban: pay.iban || cf.iban || null,
      paid_at: pay.paid_at || null,
    },
    customer: {
      first_name: cs.first_name || cf.first_name || 'Leo',
      last_name: cs.last_name || cf.last_name || 'Villars',
      email: cs.email || cf.email || 'leo.villars123@gmail.com',
      phone: cs.phone || cf.phone,
      birthdate: cs.birthdate || cf.birthdate,
      gender: cf.gender,
      address: cf.address,
      postal_code: cf.postal_code,
      city: cf.city,
      iban: pay.iban || cf.iban || null,
    },
    signature: payload.signature || { signed_at: payload.signed_at || new Date().toISOString() },
    source: 'fix-leo-villars-sale',
  };
}

async function main() {
  const browsers = path.join(process.env.USERPROFILE || '', 'AppData', 'Local', 'ms-playwright');
  if (fs.existsSync(browsers)) process.env.PLAYWRIGHT_BROWSERS_PATH = browsers;

  const payload = await loadOrder();
  const order = saleOrder(payload);
  const gymConfig = getGymConfig('minimes');
  const report = {
    name: 'Leo Villars',
    order_id: ORDER_ID,
    member_id: MEMBER_ID,
    gym: 'minimes',
    has_iban: Boolean(order.payment.iban),
    check: CHECK,
  };

  await runWithSession('fix-leo-villars-sale', async (page) => {
    const { openMemberCheck, closeGreyboxIfOpen } = require('../bot/wallet');
    const { detectMemberGymConfig } = require('../bot/member');
    const { findActiveContracts } = require('../bot/cancel-sale');
    const { recordSale, isActiveBadgeContract, isActiveMembershipContract } = require('../bot/sale');
    const { fetchDeciplusCatalog, resolveProductConfig, resolveBadgeProductConfig } = require('../bot/catalog');

    await login(page, { force: true, siteLabel: 'Minimes' });
    await switchDeciplusSite(page, 'Minimes').catch(() => {});
    await closeGreyboxIfOpen(page).catch(() => {});
    await openMemberCheck(page, MEMBER_ID, gymConfig);
    const beforeSite = await detectMemberGymConfig(page, gymConfig);
    const before = await findActiveContracts(page, { includeExpiredPrestation: true }).catch(() => []);
    report.before_site = beforeSite?.deciplus_label || null;
    report.before_zone = beforeSite?.deciplus_zone_id || null;
    report.before = before.map(slim);
    report.active_abo = before.filter(isActiveMembershipContract).map(slim);
    report.active_badge = before.filter(isActiveBadgeContract).map(slim);

    if (CHECK) return;

    const catalog = await fetchDeciplusCatalog(page);
    const productConfig = applyBillingPlanToProductConfig(resolveProductConfig(order, catalog), order);
    productConfig.paiement_comptant = false;
    productConfig.auto_badge = orderNeedsAutoBadge(order, productConfig);
    productConfig.skip_rib_prompt = true;
    let badgeProductConfig = null;
    if (productConfig.auto_badge) {
      badgeProductConfig = resolveBadgeProductConfig(catalog, {
        badge_timing: 'deferred',
        badge_method: 'iban',
      });
    }
    report.auto_badge = Boolean(productConfig.auto_badge);

    const sale = await recordSale(page, order, productConfig, MEMBER_ID, gymConfig, {
      badgeProductConfig,
      forceNewSale: report.active_abo.length === 0,
    });
    report.sale = {
      sale_id: sale.sale_id || null,
      action: sale.action || null,
      badge_action: sale.badge_action || null,
      badge_sale_id: sale.badge_sale_id || null,
      error: sale.error || sale.badge_error || null,
    };

    await closeGreyboxIfOpen(page).catch(() => {});
    await openMemberCheck(page, MEMBER_ID, gymConfig);
    const afterSite = await detectMemberGymConfig(page, gymConfig);
    const after = await findActiveContracts(page, { includeExpiredPrestation: true }).catch(() => []);
    report.after_site = afterSite?.deciplus_label || null;
    report.after_zone = afterSite?.deciplus_zone_id || null;
    report.after = after.map(slim);
    report.after_abo = after.filter(isActiveMembershipContract).map(slim);
    report.after_badge = after.filter(isActiveBadgeContract).map(slim);

    const saleId = sale.sale_id || report.after_abo[0]?.idc || null;
    await applyBotSaleStatus(ORDER_ID, {
      deciplus_member_id: MEMBER_ID,
      deciplus_sale_id: saleId || undefined,
      status: saleId && report.after_abo.length === 1 && report.after_badge.length === 1 ? 'success' : 'manual_review',
      error:
        saleId && report.after_abo.length === 1 && report.after_badge.length === 1
          ? null
          : `abo=${report.after_abo.length} badge=${report.after_badge.length}`,
    });
  });

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  await closeBrowser().catch(() => {});
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
