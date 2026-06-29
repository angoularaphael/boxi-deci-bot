/**
 * Maintient la session Deciplus active (token ~4h) via ping périodique.
 */
const { login, gotoDeciplus, getAccessToken } = require('./auth');
const { runWithSession } = require('./browser-pool');
const { listPending } = require('../lib/queue');
const { logInfo, logWarn } = require('../lib/logger');

const API_BASE = 'https://api.deciplus.pro/staff/v1';
const KEEPALIVE_MS = Number(process.env.BOT_SESSION_KEEPALIVE_MS || 2.5 * 60 * 60 * 1000);

let lastKeepAliveAt = Date.now();
let inFlight = false;

function touchKeepAliveClock() {
  lastKeepAliveAt = Date.now();
}

async function pingDeciplusApi(page, token) {
  const base = process.env.DECIPLUS_URL || 'https://boxingcenter.deciplus.pro/';
  const referer = new URL('nextgen/home', base).href;
  const response = await page.context().request.get(`${API_BASE}/product/getAvailableProducts?all=true`, {
    headers: {
      Accept: 'application/json, text/plain, */*',
      'x-access-token': token,
      'Deciplus-Client-Type': 'manager',
      Referer: referer,
    },
  });
  return response.ok();
}

async function maybeKeepSessionAlive() {
  if (inFlight) return;
  if (Date.now() - lastKeepAliveAt < KEEPALIVE_MS) return;
  if (listPending().length > 0) return;

  inFlight = true;
  try {
    await runWithSession('keepalive', async (page) => {
      await login(page);
      await gotoDeciplus(page, 'nextgen/home');

      const token = await getAccessToken(page);
      if (!token) {
        logWarn('Keepalive — token absent après login');
        return;
      }

      const ok = await pingDeciplusApi(page, token);
      if (!ok) {
        logWarn('Keepalive — ping API Deciplus en échec');
        return;
      }

      logInfo('Session Deciplus maintenue (keepalive)', {
        interval_min: Math.round(KEEPALIVE_MS / 60000),
      });
    });
    touchKeepAliveClock();
  } catch (err) {
    logWarn('Keepalive session échoué', { error: err.message });
  } finally {
    inFlight = false;
  }
}

module.exports = {
  maybeKeepSessionAlive,
  touchKeepAliveClock,
  KEEPALIVE_MS,
};
