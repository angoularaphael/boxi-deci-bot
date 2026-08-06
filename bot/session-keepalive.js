/**
 * Maintient la session Deciplus active (token ~4h) via ping périodique.
 */
const { login, gotoDeciplus, getAccessToken, isAuthBlocked } = require('./auth');
const { runWithSession } = require('./browser-pool');
const { listPending } = require('../lib/queue');
const { logInfo, logWarn } = require('../lib/logger');

const API_BASE = 'https://api.deciplus.pro/staff/v1';
// Token Deciplus ~4h — ping avant expiration (défaut 90 min)
const KEEPALIVE_MS = Number(process.env.BOT_SESSION_KEEPALIVE_MS || 90 * 60 * 1000);
const KEEPALIVE_RETRY_MS = Number(process.env.BOT_SESSION_KEEPALIVE_RETRY_MS || 15 * 60 * 1000);

let lastKeepAliveSuccessAt = Date.now();
let lastKeepAliveAttemptAt = 0;
let inFlight = false;

function touchKeepAliveClock() {
  lastKeepAliveSuccessAt = Date.now();
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

async function refreshSessionIfNeeded(page) {
  await gotoDeciplus(page, 'nextgen/home');
  let token = await getAccessToken(page);
  if (token && (await pingDeciplusApi(page, token))) {
    return token;
  }

  await login(page);
  await gotoDeciplus(page, 'nextgen/home');
  token = await getAccessToken(page);
  if (!token) return null;
  if (await pingDeciplusApi(page, token)) return token;
  return null;
}

async function maybeKeepSessionAlive() {
  if (inFlight) return;
  if (isAuthBlocked()) return;
  if (listPending().length > 0) return;

  const sinceSuccess = Date.now() - lastKeepAliveSuccessAt;
  if (sinceSuccess < KEEPALIVE_MS) return;

  const sinceAttempt = Date.now() - lastKeepAliveAttemptAt;
  if (sinceAttempt < KEEPALIVE_RETRY_MS) return;

  inFlight = true;
  lastKeepAliveAttemptAt = Date.now();
  try {
    const token = await runWithSession('keepalive', async (page) => refreshSessionIfNeeded(page));
    if (!token) {
      logWarn('Keepalive — session Deciplus non rafraîchie');
      return;
    }

    logInfo('Session Deciplus maintenue (keepalive)', {
      interval_min: Math.round(KEEPALIVE_MS / 60000),
    });
    lastKeepAliveSuccessAt = Date.now();
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
  KEEPALIVE_RETRY_MS,
};
