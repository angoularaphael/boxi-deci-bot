'use strict';

const os = require('os');
let createClient = null;
try {
  ({ createClient } = require('@supabase/supabase-js'));
} catch {
  // BotHosting peut démarrer avant le npm install du dépôt cloné.
  // Le repli REST ci-dessous conserve le registre distribué sans faire crasher le bot.
}

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
  client = createClient
    ? createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
    : { __rest: true, url: String(url).replace(/\/$/, ''), key };
  return client;
}

async function restRequest(sb, path, { method = 'GET', body = null, prefer = null } = {}) {
  const response = await fetch(`${sb.url}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: sb.key,
      Authorization: `Bearer ${sb.key}`,
      'Content-Type': 'application/json',
      ...(prefer ? { Prefer: prefer } : {}),
    },
    ...(body == null ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    return {
      data: null,
      error: {
        code: data?.code || `HTTP_${response.status}`,
        message: data?.message || data?.error || `Supabase REST HTTP ${response.status}`,
      },
    };
  }
  return { data, error: null };
}

async function rpc(sb, name, params) {
  if (!sb.__rest) return sb.rpc(name, params);
  return restRequest(sb, `rpc/${encodeURIComponent(name)}`, {
    method: 'POST',
    body: params,
  });
}

function unavailable(reason) {
  availability = { checked_at: new Date().toISOString(), available: false, reason };
  return availability;
}

async function health() {
  const sb = getClient();
  if (!sb) return unavailable('supabase_credentials_missing');
  const { error } = sb.__rest
    ? await restRequest(sb, 'boxplus_job_actions?select=order_id&limit=1')
    : await sb.from('boxplus_job_actions').select('order_id').limit(1);
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
  const { data, error } = await rpc(sb, 'boxplus_acquire_job_action', {
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
  const { data, error } = await rpc(sb, 'boxplus_checkpoint_job_action', params);
  if (error) {
    const err = new Error(`Checkpoint idempotence échoué — ${error.message}`);
    err.code = 'CALLBACK_STORAGE';
    throw err;
  }
  return data;
}

async function get(orderId, action) {
  const sb = requireRegistry();
  const { data, error } = sb.__rest
    ? await restRequest(
        sb,
        `boxplus_job_actions?select=*&order_id=eq.${encodeURIComponent(String(orderId))}` +
          `&action=eq.${encodeURIComponent(String(action))}&limit=1`
      )
    : await sb
        .from('boxplus_job_actions')
        .select('*')
        .eq('order_id', String(orderId))
        .eq('action', String(action))
        .maybeSingle();
  if (error) throw error;
  return (sb.__rest && Array.isArray(data) ? data[0] : data) || null;
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
