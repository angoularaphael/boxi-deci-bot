'use strict';

const {
  SALES_BOT_RAPHAEL,
  normalizeSalesBot,
  alternateSalesBot,
  getBotId,
} = require('./sales-bot');

function maxFailovers() {
  return Math.max(0, Number(process.env.BOT_MAX_FAILOVERS || 1));
}

function failoverUrl(currentBot = getBotId()) {
  const explicit = String(process.env.BOT_FAILOVER_URL || '').trim();
  if (explicit) return explicit.replace(/\/$/, '');
  if (normalizeSalesBot(currentBot) === SALES_BOT_RAPHAEL) {
    return String(process.env.BOXPLUS_BOT_URL_SALES_2 || '')
      .trim()
      .replace(/\/$/, '');
  }
  return '';
}

function failoverTarget(currentBot = getBotId()) {
  return (
    normalizeSalesBot(process.env.BOT_FAILOVER_TARGET) ||
    alternateSalesBot(currentBot)
  );
}

function shouldFailoverSale(order = {}, policy = {}, outcome = {}) {
  const action = String(order.action || outcome.action || 'sale').toLowerCase();
  const source = getBotId() || normalizeSalesBot(order.sales_bot);
  const target = failoverTarget(source);
  const count = Number(order.failover_count || 0);
  return Boolean(
    action === 'sale' &&
      policy.retryable &&
      !outcome.deciplus_sale_id &&
      source &&
      target &&
      source !== target &&
      failoverUrl(source) &&
      count < maxFailovers()
  );
}

async function handoffFailedSale(order = {}, details = {}) {
  const source = getBotId() || normalizeSalesBot(order.sales_bot);
  const target = failoverTarget(source);
  const base = failoverUrl(source);
  if (!base || !target) {
    return { handed_off: false, reason: 'failover_not_configured' };
  }

  const secret = process.env.SYNC_SECRET || process.env.BRIDGE_SECRET || '';
  if (!secret) return { handed_off: false, reason: 'sync_secret_missing' };

  const failoverCount = Number(order.failover_count || 0) + 1;
  const payload = {
    ...order,
    sales_bot: target,
    failover_count: failoverCount,
    failover_from: source,
    failover_at: new Date().toISOString(),
    failover_reason: String(details.error || '').slice(0, 500) || null,
    force_requeue: true,
    force_sale_retry: true,
    attempts: 0,
  };

  const post = async (path) => {
    const response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-sync-secret': secret,
      },
      body: JSON.stringify(payload),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(body.error || `Bot failover HTTP ${response.status}`);
    }
    return body;
  };

  let body = await post('/api/jobs');
  if (body.reason === 'wrong_bot') {
    throw new Error(`Bot failover refuse le job destiné à ${target}`);
  }
  if (
    body.reason === 'already_processed' &&
    !body.processed?.deciplus_sale_id &&
    !body.processed?.sale_id
  ) {
    body = await post('/api/jobs/force-requeue');
  }
  if (body.queued === false && body.reason !== 'already_queued' && body.reason !== 'already_processed') {
    throw new Error(body.error || body.reason || 'Bot failover n’a pas accepté le job');
  }
  return {
    handed_off: true,
    target,
    failover_count: failoverCount,
    queued: body.queued !== false,
    reason: body.reason || null,
    processed: body.processed || null,
  };
}

module.exports = {
  maxFailovers,
  failoverUrl,
  failoverTarget,
  shouldFailoverSale,
  handoffFailedSale,
};
