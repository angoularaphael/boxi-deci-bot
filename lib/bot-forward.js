/**
 * Envoie une commande vers le bot BotHosting (file persistante côté bot).
 * Ventes → BOXPLUS_BOT_URL ; résils / verify / changements → BOXPLUS_BOT_URL_OPS.
 */
function isOpsOrder(order = {}) {
  const action = String(order.action || 'sale').toLowerCase();
  const reason = String(order.cancel_reason || '').toLowerCase();
  const isChangeSale =
    action === 'sale' &&
    (reason === 'change_to_comptant' ||
      order.notify_change_complete ||
      String(order.source || '').includes('change'));
  // member_photo reste sur le bot ventes (eu1)
  return (
    action === 'cancel' ||
    action === 'verify_identity' ||
    action === 'echeancier' ||
    action === 'encaisser' ||
    action === 'inscription_nudge' ||
    action === 'check_sale' ||
    action === 'balma_switch' ||
    isChangeSale
  );
}

function pickBotBase(order = {}) {
  const sales = (process.env.BOXPLUS_BOT_URL || '').replace(/\/$/, '');
  const ops = (process.env.BOXPLUS_BOT_URL_OPS || '').replace(/\/$/, '');

  if (isOpsOrder(order)) {
    if (!ops) {
      throw new Error(
        'BOXPLUS_BOT_URL_OPS manquant sur Vercel — résils / vérifs / changements doivent aller sur prem-eu2'
      );
    }
    return ops;
  }
  return sales;
}

async function forwardJobToBot(order) {
  const { getStoreUrl } = require('./app-urls');
  const base = pickBotBase(order);
  const secret = process.env.SYNC_SECRET || process.env.BRIDGE_SECRET || '';
  if (!base) {
    return {
      forwarded: false,
      reason: isOpsOrder(order) ? 'no_bot_url_ops' : 'no_bot_url',
    };
  }

  const res = await fetch(`${base}/api/jobs`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-sync-secret': secret,
    },
    body: JSON.stringify({
      ...order,
      status_callback_base: order.status_callback_base || getStoreUrl(),
    }),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.error || `Bot ingest HTTP ${res.status}`);
  }
  return { forwarded: true, bot_url: base, ...body };
}

module.exports = { forwardJobToBot, pickBotBase, isOpsOrder };
