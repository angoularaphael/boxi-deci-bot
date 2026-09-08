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

