/**
 * Une seule session Playwright Deciplus à la fois (évite double connexion).
 * Recharge le navigateur si storage-state.json change (nouvelle session uploadée).
 */
const { launchBrowser, saveSession, getStorageMtimeMs } = require('./auth');
const { logInfo, logWarn } = require('../lib/logger');

let session = null;
let loadedStorageMtimeMs = 0;
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

function sessionFileChanged() {
  const disk = getStorageMtimeMs();
  return disk > 0 && disk > loadedStorageMtimeMs + 50;
}

function sessionPageDead() {
  const page = session?.page;
  if (!page) return true;
  if (page.__deciplusCrashed) return true;
  try {
    return page.isClosed();
  } catch {
    return true;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureBrowser() {
  const browserAlive = Boolean(session?.browser && session.browser.isConnected());
  if (browserAlive && !sessionPageDead()) {
    if (sessionFileChanged()) {
      logWarn('Nouveau storage-state détecté — rechargement navigateur (session changée)');
      await closeBrowser();
    } else {
      return session;
    }
  } else if (session?.browser) {
    logWarn('Page ou navigateur Deciplus mort — relance Chromium');
    await closeBrowser();
    await delay(1500);
  }

  if (session?.browser) {
    await session.browser.close().catch(() => {});
    session = null;
  }

  session = await launchBrowser();
  loadedStorageMtimeMs =
    session.loadedStorageMtimeMs != null ? session.loadedStorageMtimeMs : getStorageMtimeMs();
  logInfo('Session Playwright Deciplus ouverte (unique)', {
    storage_mtime: loadedStorageMtimeMs || null,
  });
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
    const mtimeAtStart = loadedStorageMtimeMs;
    const result = await fn(page, context);
    const saveResult = await saveSession(context, { loadedMtimeMs: mtimeAtStart });
    // Toujours aligner l’horloge locale (y compris skip) pour éviter la boucle
    // « storage-state modifié → fermeture navigateur ».
    loadedStorageMtimeMs =
      saveResult?.mtimeMs != null ? saveResult.mtimeMs : getStorageMtimeMs();
    return result;
  });
}

/** Marque le mtime courant comme déjà chargé (après reload externe volontaire). */
function syncLoadedStorageMtime() {
  loadedStorageMtimeMs = getStorageMtimeMs();
  return loadedStorageMtimeMs;
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
  sessionFileChanged,
  syncLoadedStorageMtime,
};
