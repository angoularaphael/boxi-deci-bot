'use strict';

const os = require('os');
const { createClient } = require('@supabase/supabase-js');

let client;
let availability = { checked_at: null, available: false, reason: 'not_checked' };

function workerId() {
  return process.env.BOT_ID || `${os.hostname()}:${process.pid}`;
}

function getClient() {
  if (client) return client;
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return client;
}

function unavailable(reason) {
  availability = { checked_at: new Date().toISOString(), available: false, reason };
  return availability;
}

async function health() {
  const sb = getClient();
  if (!sb) return unavailable('supabase_credentials_missing');
  const { error } = await sb.from('boxplus_job_actions').select('order_id').limit(1);
  if (error) return unavailable(`registry_unavailable:${error.code || error.message}`);
  availability = { checked_at: new Date().toISOString(), available: true, reason: null };
  return availability;
}

function requireRegistry() {
  const sb = getClient();
  if (!sb) {
    const err = new Error('Registre idempotence Supabase indisponible — écriture Deciplus bloquée');
    err.code = 'IDEMPOTENCY_UNAVAILABLE';
    throw err;
  }
  return sb;
}

async function acquire(orderId, action, options = {}) {
  const sb = requireRegistry();
  const owner = options.workerId || workerId();
  const leaseSeconds = Number(options.leaseSeconds || process.env.BOT_LEASE_SECONDS || 1800);
  const { data, error } = await sb.rpc('boxplus_acquire_job_action', {
    p_order_id: String(orderId),
    p_action: String(action),
    p_worker_id: owner,
    p_lease_seconds: leaseSeconds,
  });
  if (error) {
    unavailable(`registry_rpc_unavailable:${error.code || error.message}`);
    const err = new Error(`Registre idempotence non déployé ou indisponible — ${error.message}`);
    err.code = 'IDEMPOTENCY_UNAVAILABLE';
    throw err;
  }
  availability = { checked_at: new Date().toISOString(), available: true, reason: null };
  const row = Array.isArray(data) ? data[0] : data;
  return { ...row, worker_id: owner };
}

async function checkpoint(orderId, action, patch = {}) {
  const sb = requireRegistry();
  const params = {
    p_order_id: String(orderId),
    p_action: String(action),
    p_worker_id: patch.worker_id || workerId(),
    p_status: patch.status || 'processing',
    p_lifecycle_state: patch.lifecycle_state || null,
    p_attempt: Number(patch.attempt || 1),
    p_error_classification: patch.error_classification || null,
    p_error_message: patch.error_message ? String(patch.error_message).slice(0, 1000) : null,
    p_human_action: patch.human_action ? String(patch.human_action).slice(0, 500) : null,
    p_member_id: patch.member_id ? String(patch.member_id) : null,
    p_sale_id: patch.sale_id ? String(patch.sale_id) : null,
    p_metadata: patch.metadata || {},
    p_lease_seconds: Number(patch.lease_seconds || process.env.BOT_LEASE_SECONDS || 1800),
  };
  const { data, error } = await sb.rpc('boxplus_checkpoint_job_action', params);
  if (error) {
    const err = new Error(`Checkpoint idempotence échoué — ${error.message}`);
    err.code = 'CALLBACK_STORAGE';
    throw err;
  }
  return data;
}

async function get(orderId, action) {
  const sb = requireRegistry();
  const { data, error } = await sb
    .from('boxplus_job_actions')
    .select('*')
    .eq('order_id', String(orderId))
    .eq('action', String(action))
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

function cachedHealth() {
  return { ...availability };
}

function resumeDecision(lease = {}) {
  if (!lease.acquired && lease.reason === 'completed') {
    return {
      disposition: 'completed',
      member_id: lease.member_id || null,
      sale_id: lease.sale_id || null,
    };
  }
  if (!lease.acquired) return { disposition: 'leased', retry_at: lease.lease_expires_at || null };
  if (lease.sale_id) {
    return { disposition: 'resume_after_sale', member_id: lease.member_id || null, sale_id: lease.sale_id };
  }
  if (lease.member_id) return { disposition: 'resume_after_member', member_id: lease.member_id };
  return { disposition: 'start' };
}

function _setClientForTests(value) {
  client = value;
}

module.exports = {
  acquire,
  checkpoint,
  get,
  health,
  cachedHealth,
  workerId,
  resumeDecision,
  _setClientForTests,
};
