'use strict';

const { pickBotBase } = require('./bot-forward');
const { getJobId } = require('./normalize');

function botSecret() {
  return process.env.SYNC_SECRET || process.env.BRIDGE_SECRET || '';
}

function jobIdCandidates(order = {}) {
  const ids = new Set();
  const orderId = String(order.order_id || '').trim();
  if (orderId) {
    ids.add(orderId);
    ids.add(getJobId({ ...order, order_id: orderId, action: order.action || 'sale' }));
    ids.add(getJobId({ ...order, order_id: orderId, action: 'balma_switch' }));
    ids.add(`${orderId}#balma_switch`);
  }
  const jobId = String(order.job_id || '').trim();
  if (jobId) ids.add(jobId);
  return [...ids];
}

/**
 * Lit le statut traité côté bot (processed-orders.json).
 */
async function fetchBotProcessed(jobId, order = {}) {
  const candidates = jobId ? [String(jobId)] : jobIdCandidates(order);
  for (const id of candidates) {
    const record = await fetchBotProcessedOne(id, order);
    if (record) return record;
  }
  return null;
}

async function fetchBotProcessedOne(jobId, order = {}) {
  const id = String(jobId || '').trim();
  if (!id) return null;
  const base = pickBotBase(order).replace(/\/$/, '');
  const secret = botSecret();
  if (!base || !secret) return null;
  try {
    const res = await fetch(`${base}/api/jobs/${encodeURIComponent(id)}`, {
      headers: { 'x-sync-secret': secret },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body?.processed) return null;
    return body.processed;
  } catch {
    return null;
  }
}

function mapBotStatus(record = {}) {
  const st = String(record.status || '').toLowerCase();
  if (st === 'success') return 'success';
  if (st === 'manual_review') return 'manual_review';
  if (st === 'error' || st === 'rejected') return 'error';
  return st || null;
}

/**
 * Applique member_id / sale_id depuis le bot vers la commande boutique.
 */
async function syncOrderFromBotProcessed(orderId, { applyBotSaleStatus, order = null } = {}) {
  if (!applyBotSaleStatus) {
    ({ applyBotSaleStatus } = require('../storefront/lib/order-lifecycle'));
  }
  const record = await fetchBotProcessed(null, { ...(order || {}), order_id: orderId });
  if (!record) return { synced: false, reason: 'no_processed_record' };
  const memberId = record.deciplus_member_id ? String(record.deciplus_member_id) : '';
  const saleId = record.deciplus_sale_id ? String(record.deciplus_sale_id) : '';
  if (!memberId && !saleId) {
    return { synced: false, reason: 'no_deciplus_ids', record };
  }
  const updated = await applyBotSaleStatus(orderId, {
    status: mapBotStatus(record),
    deciplus_member_id: memberId || undefined,
    deciplus_sale_id: saleId || undefined,
    error: record.error || null,
  });
  return {
    synced: Boolean(updated),
    order_id: orderId,
    deciplus_member_id: memberId || null,
    deciplus_sale_id: saleId || null,
    bot_status: mapBotStatus(record),
  };
}

module.exports = {
  fetchBotProcessed,
  syncOrderFromBotProcessed,
  mapBotStatus,
};
