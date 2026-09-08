'use strict';

/**
 * Répartition des inscriptions : Raphaël (eu1) vs Eddy (eu2:21871).
 * Sticky : si sales_bot est déjà posé, on ne le change pas.
 * Sans BOXPLUS_BOT_URL_SALES_2, tout reste sur le bot Raphaël.
 */

const SALES_BOT_RAPHAEL = 'raphael';
const SALES_BOT_EDDY = 'eddy';

function normalizeSalesBot(value) {
  const v = String(value || '')
    .toLowerCase()
    .trim();
  if (!v) return '';
  if (v === 'eddy') return SALES_BOT_EDDY;
  if (v === 'raphael' || v === 'brad' || v === 'eu1') return SALES_BOT_RAPHAEL;
  return '';
}

function hashOrderId(orderId) {
  const s = String(orderId || '');
  let h = 0;
  for (let i = 0; i < s.length; i += 1) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function assignSalesBot(order = {}) {
  const existing = normalizeSalesBot(order.sales_bot);
  if (existing) return existing;
  const id = order.order_id || order.job_id || '';
  return hashOrderId(id) % 2 === 0 ? SALES_BOT_RAPHAEL : SALES_BOT_EDDY;
}

function sales2Url() {
  return String(process.env.BOXPLUS_BOT_URL_SALES_2 || '').replace(/\/$/, '');
}

function getBotId() {
  return normalizeSalesBot(process.env.BOT_ID);
}

function alternateSalesBot(value) {
  const current = normalizeSalesBot(value);
  if (current === SALES_BOT_RAPHAEL) return SALES_BOT_EDDY;
  if (current === SALES_BOT_EDDY) return SALES_BOT_RAPHAEL;
  return '';
}

function stampSalesBot(order = {}) {
  if (!order || typeof order !== 'object') return order;
  if (!sales2Url()) {
    if (!order.sales_bot) order.sales_bot = SALES_BOT_RAPHAEL;
    return order;
  }
  order.sales_bot = assignSalesBot(order);
  return order;
}

function pickSalesBotUrl(order = {}, raphaelUrl = '', eddyUrl = '') {
  const raphael = String(raphaelUrl || '').replace(/\/$/, '');
  const eddy = String(eddyUrl || '').replace(/\/$/, '');
  if (!eddy) {
    stampSalesBot(order);
    return raphael;
  }
  stampSalesBot(order);
  return order.sales_bot === SALES_BOT_EDDY ? eddy : raphael;
}

function wrongSalesBotReject(order = {}) {
  const botId = getBotId();
  if (!botId) return null;
  const assigned = normalizeSalesBot(order.sales_bot);
  if (!assigned) return null;
  if (assigned === botId) return null;
  return {
    queued: false,
    reason: 'wrong_bot',
    sales_bot: assigned,
    bot_id: botId,
  };
}

module.exports = {
  SALES_BOT_RAPHAEL,
  SALES_BOT_EDDY,
  normalizeSalesBot,
  assignSalesBot,
  stampSalesBot,
  pickSalesBotUrl,
  getBotId,
  alternateSalesBot,
  wrongSalesBotReject,
  sales2Url,
};
