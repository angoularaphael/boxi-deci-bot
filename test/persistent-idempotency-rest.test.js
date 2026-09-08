'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const registry = require('../lib/persistent-idempotency');

test('registre idempotence fonctionne en REST sans SDK Supabase', async (t) => {
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    const body = String(url).includes('boxplus_acquire_job_action')
      ? [{ acquired: true, reason: 'acquired', attempt: 1 }]
      : String(url).includes('boxplus_job_actions?')
        ? [{ order_id: 'BC-REST', action: 'sale', status: 'processing' }]
        : { ok: true };
    return {
      ok: true,
      status: 200,
      json: async () => body,
    };
  };
  registry._setClientForTests({
    __rest: true,
    url: 'https://example.supabase.co',
    key: 'service-role-test',
  });
  t.after(() => {
    global.fetch = originalFetch;
    registry._setClientForTests(null);
  });

  assert.equal((await registry.health()).available, true);
  assert.equal((await registry.acquire('BC-REST', 'sale')).acquired, true);
  await registry.checkpoint('BC-REST', 'sale', { status: 'processing' });
  assert.equal((await registry.get('BC-REST', 'sale')).order_id, 'BC-REST');

  assert.ok(calls.some((call) => call.url.includes('/rest/v1/rpc/boxplus_acquire_job_action')));
  assert.ok(calls.some((call) => call.url.includes('/rest/v1/rpc/boxplus_checkpoint_job_action')));
  assert.ok(calls.every((call) => call.options.headers.apikey === 'service-role-test'));
});

test('RPC attempt ambigu bascule sur la table boxplus_job_actions', async (t) => {
  const calls = [];
  const originalFetch = global.fetch;
  let row = null;
  global.fetch = async (url, options = {}) => {
    const href = String(url);
    calls.push({ url: href, method: options.method, prefer: options.headers?.Prefer });
    if (href.includes('boxplus_acquire_job_action') || href.includes('boxplus_checkpoint_job_action')) {
      return {
        ok: false,
        status: 400,
        json: async () => ({
          code: '42702',
          message: 'column reference "attempt" is ambiguous',
        }),
      };
    }
    if (href.includes('boxplus_job_actions') && options.method === 'POST') {
      row = {
        order_id: 'BC-AMBIG',
        action: 'sale',
        status: 'processing',
        attempt: 1,
        worker_id: 'sales-1',
      };
      return { ok: true, status: 201, json: async () => null };
    }
    if (href.includes('boxplus_job_actions') && (options.method === 'PATCH' || !options.method || options.method === 'GET')) {
      if (options.method === 'PATCH' && options.body) {
        row = { ...row, ...JSON.parse(options.body) };
      }
      return { ok: true, status: 200, json: async () => [row] };
    }
    return { ok: true, status: 200, json: async () => [] };
  };
  registry._setClientForTests({
    __rest: true,
    url: 'https://example.supabase.co',
    key: 'service-role-test',
  });
  t.after(() => {
    global.fetch = originalFetch;
    registry._setClientForTests(null);
  });

  const lease = await registry.acquire('BC-AMBIG', 'sale', { workerId: 'sales-1', leaseSeconds: 60 });
  assert.equal(lease.acquired, true);
  assert.equal(lease.reason, 'acquired');
  await registry.checkpoint('BC-AMBIG', 'sale', {
    worker_id: 'sales-1',
    status: 'completed',
    sale_id: '99',
  });
  assert.ok(calls.some((call) => call.url.includes('/rest/v1/boxplus_job_actions')));
  assert.equal(row.status, 'completed');
  assert.equal(row.sale_id, '99');
});

