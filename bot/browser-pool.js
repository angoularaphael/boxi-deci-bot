/**
 * Une seule session Playwright Deciplus à la fois (évite double connexion).
 */
const { launchBrowser, saveSession } = require('./auth');
const { logInfo, logWarn } = require('../lib/logger');

let session = null;
let lock = Promise.resolve();

async function withBrowserLock(owner, fn) {
  const prev = lock;
  let unlock;
  lock = new Promise((resolve) => {
    unlock = resolve;
  });
  await prev;

  try {
    const handle = await ensureBrowser();
    logInfo('Session Deciplus verrouillée', { owner });
    return await fn(handle);
  } finally {
    unlock();
  }
}

async function ensureBrowser() {
  if (session?.browser && session.browser.isConnected()) {
    return session;
  }

  if (session?.browser) {
    await session.browser.close().catch(() => {});
  }

  session = await launchBrowser();
  logInfo('Session Playwright Deciplus ouverte (unique)');
  return session;
}

async function closeBrowser() {
  if (session?.browser) {
    await session.browser.close().catch(() => {});
  }
  session = null;
}

async function runWithSession(owner, fn) {
  return withBrowserLock(owner, async ({ page, context }) => {
    const result = await fn(page, context);
    await saveSession(context);
    return result;
  });
}

function hasActiveBrowser() {
  return Boolean(session?.browser?.isConnected());
}

module.exports = {
  withBrowserLock,
  ensureBrowser,
  closeBrowser,
  runWithSession,
  hasActiveBrowser,
};
