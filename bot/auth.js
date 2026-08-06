const fs = require('fs');
const path = require('path');
const { ROOT, ensureDir, randomDelay } = require('../lib/utils');
const { logInfo, logWarn } = require('../lib/logger');
const { launchChromiumWithRetry } = require('./playwright-launch');
const { isChooseZoneScreen, selectSiteInPicker, clickSellOnSite } = require('./deciplus-zone');

const SESSION_DIR = process.env.BOT_SESSION_DIR || path.join(ROOT, 'data', 'session');
const STORAGE_FILE = path.join(SESSION_DIR, 'storage-state.json');
const AUTH_COOLDOWN_MS = Number(process.env.BOT_AUTH_COOLDOWN_MS || 10 * 60 * 1000);

let loginInFlight = null;
let authBlockedUntil = 0;

function isAuthBlocked() {
  return Date.now() < authBlockedUntil;
}

function getAuthBlockedMessage() {
  const minutes = Math.ceil((authBlockedUntil - Date.now()) / 60000);
  return `Connexion Deciplus en cooldown (${minutes} min) — évite les demandes de code email en rafale`;
}

function isMfaAuthError(message = '') {
  return /code.*email|DECIPLUS_EMAIL_CODE|vérification|verification|otp|mfa|cooldown/i.test(message);
}

function blockAuthRetries(reason) {
  authBlockedUntil = Date.now() + AUTH_COOLDOWN_MS;
  logWarn('Connexion Deciplus en cooldown', {
    reason,
    cooldown_min: Math.round(AUTH_COOLDOWN_MS / 60000),
  });
}

function assertAuthAllowed() {
  if (isAuthBlocked()) {
    throw new Error(getAuthBlockedMessage());
  }
}

async function getAccessToken(page) {
  return page.evaluate(() => {
    try {
      return JSON.parse(localStorage.getItem('auth') || '{}').token || null;
    } catch {
      return null;
    }
  });
}

async function isVerificationScreen(page) {
  const url = page.url();
  if (/verif|validation|otp|2fa|mfa|authenticate/i.test(url)) return true;

  const hints = [
    'text=/code.*(e-?mail|mail|sms)/i',
    'text=/vérification/i',
    'text=/validation du code/i',
    'text=/saisissez.*code/i',
    'input[name="code"]',
    'input[name="otp"]',
    'input[name="validationCode"]',
    'input[autocomplete="one-time-code"]',
    'input[inputmode="numeric"]',
  ];

  for (const sel of hints) {
    const loc = page.locator(sel).first();
    if ((await loc.count()) > 0 && (await loc.isVisible().catch(() => false))) {
      return true;
    }
  }
  return false;
}

async function fillVisible(page, selectors, value, { timeout = 15000 } = {}) {
  for (const sel of selectors) {
    const el = page.locator(sel).first();
    try {
      if ((await el.count()) > 0 && (await el.isVisible()) && (await el.isEnabled())) {
        await el.fill(value, { timeout });
        return true;
      }
    } catch {
      /* try next selector */
    }
  }
  return false;
}

async function injectAuthToken(page, token) {
  await page.evaluate((accessToken) => {
    let auth = {};
    try {
      auth = JSON.parse(localStorage.getItem('auth') || '{}');
    } catch {
      auth = {};
    }
    auth.token = accessToken;
    localStorage.setItem('auth', JSON.stringify(auth));
  }, token);
  logInfo('Token Deciplus injecté depuis DECIPLUS_AUTH_TOKEN');
}

async function handleEmailVerification(page) {
  const code = String(process.env.DECIPLUS_EMAIL_CODE || process.env.DECIPLUS_OTP || '').trim();
  if (!code) {
    throw new Error(
      'Deciplus demande un code de vérification email. ' +
        'Solution 1 : ajouter DECIPLUS_EMAIL_CODE=123456 dans .env (temporaire). ' +
        'Solution 2 (recommandée) : exporter data/session/storage-state.json en local ' +
        '(npm run session:export) et uploader sur BotHosting.'
    );
  }

  logInfo('Saisie code vérification Deciplus…');
  const codeSelectors = [
    'input[name="code"]',
    'input[name="otp"]',
    'input[name="validationCode"]',
    'input[autocomplete="one-time-code"]',
    'input[inputmode="numeric"]',
    'input[type="tel"]',
    'input[type="text"]',
  ];
  const submitSelectors = [
    'button:has-text("Valider")',
    'button:has-text("Vérifier")',
    'button:has-text("Confirmer")',
    'button:has-text("Continuer")',
    'button[type="submit"]',
  ];

  const ok = await fillVisible(page, codeSelectors, code);
  if (!ok) {
    throw new Error('Champ code vérification Deciplus introuvable');
  }

  for (const sel of submitSelectors) {
    const btn = page.locator(sel).first();
    if ((await btn.count()) > 0 && (await btn.isVisible().catch(() => false))) {
      await btn.click();
      break;
    }
  }

  await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
  await randomDelay(process.env.BOT_MIN_DELAY_MS, process.env.BOT_MAX_DELAY_MS);
}

async function launchBrowser() {
  ensureDir(SESSION_DIR);

  const browser = await launchChromiumWithRetry();
  const contextOptions = {
    viewport: { width: 1280, height: 720 },
    locale: 'fr-FR',
  };
  if (fs.existsSync(STORAGE_FILE)) {
    contextOptions.storageState = STORAGE_FILE;
  }

  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  return { browser, context, page, loadedStorageMtimeMs: getStorageMtimeMs() };
}

function getStorageMtimeMs() {
  try {
    if (!fs.existsSync(STORAGE_FILE)) return 0;
    return fs.statSync(STORAGE_FILE).mtimeMs;
  } catch {
    return 0;
  }
}

function hashStorageState(state) {
  try {
    const crypto = require('crypto');
    const cookies = (state.cookies || [])
      .map((c) => `${c.name}=${c.value}@${c.domain}`)
      .sort()
      .join('|');
    const origins = (state.origins || [])
      .map((o) => {
        const auth = (o.localStorage || []).find((x) => x.name === 'auth');
        return `${o.origin}:${auth?.value || ''}`;
      })
      .sort()
      .join('|');
    return crypto.createHash('sha256').update(`${cookies}::${origins}`).digest('hex');
  } catch {
    return null;
  }
}

function readDiskStorageHash() {
  try {
    if (!fs.existsSync(STORAGE_FILE)) return null;
    return hashStorageState(JSON.parse(fs.readFileSync(STORAGE_FILE, 'utf8')));
  } catch {
    return null;
  }
}

/**
 * Ne pas écraser un storage-state.json fraîchement uploadé (changement de session).
 * Ne réécrit pas si le contenu auth est inchangé (évite boucle mtime / reload).
 * Ne persiste pas une session morte (sans token) par-dessus un fichier valide.
 */
async function saveSession(context, opts = {}) {
  ensureDir(SESSION_DIR);
  const loadedMtimeMs = opts.loadedMtimeMs;
  const diskMtime = getStorageMtimeMs();
  if (loadedMtimeMs != null && diskMtime > Number(loadedMtimeMs) + 50) {
    logWarn('Session disque plus récente — pas d\'écrasement (export / changement session)');
    return { skipped: true, reason: 'newer_on_disk', mtimeMs: diskMtime };
  }

  const nextState = await context.storageState();
  const nextHash = hashStorageState(nextState);
  const diskHash = readDiskStorageHash();

  const hasAuthToken = (state) => {
    try {
      for (const o of state.origins || []) {
        const auth = (o.localStorage || []).find((x) => x.name === 'auth');
        if (!auth?.value) continue;
        const parsed = JSON.parse(auth.value);
        if (parsed?.token) return true;
      }
    } catch {
      /* ignore */
    }
    return false;
  };

  let diskHasToken = false;
  try {
    if (fs.existsSync(STORAGE_FILE)) {
      diskHasToken = hasAuthToken(JSON.parse(fs.readFileSync(STORAGE_FILE, 'utf8')));
    }
  } catch {
    diskHasToken = false;
  }
  if (opts.requireAuth !== false && diskHasToken && !hasAuthToken(nextState)) {
    logWarn('Session navigateur sans token — conservation du storage-state disque');
    return { skipped: true, reason: 'dead_session', mtimeMs: diskMtime };
  }

  if (nextHash && diskHash && nextHash === diskHash) {
    return { skipped: true, reason: 'unchanged', mtimeMs: diskMtime || getStorageMtimeMs() };
  }

  fs.writeFileSync(STORAGE_FILE, JSON.stringify(nextState, null, 2), 'utf8');
  logInfo('Session Deciplus sauvegardée');
  return { skipped: false, mtimeMs: getStorageMtimeMs(), hash: nextHash };
}

function isSessionRecoverableError(message = '') {
  return /session expir|token.*introuvable|relancer login|not logged|login\.php|Unauthorized|\b401\b|storage-state|connexion.*échou|Déconnexion|session Deciplus|déjà pas connect|auth.*expir|cookie/i.test(
    String(message || '')
  );
}

async function isLoggedIn(page) {
  if (await isVerificationScreen(page)) return false;

  const url = page.url();
  if (url.includes('login') || url.includes('signin') || url.includes('connexion')) return false;

  const token = await getAccessToken(page);
  if (token) return true;

  const indicators = [
    'text=Membres',
    'text=Dashboard',
    'text=Tableau de bord',
    '[data-testid="dashboard"]',
  ];
  for (const sel of indicators) {
    const loc = page.locator(sel).first();
    if ((await loc.count()) > 0 && (await loc.isVisible().catch(() => false))) return true;
  }
  return false;
}

async function handleChooseZone(page, siteLabel) {
  if (!(await isChooseZoneScreen(page))) return false;

  logInfo('Écran choix de site Deciplus détecté');
  await selectSiteInPicker(page, siteLabel);
  await clickSellOnSite(page);
  return true;
}

async function gotoDeciplus(page, pathPart = '', options = {}) {
  const base = process.env.DECIPLUS_URL || 'https://boxingcenter.deciplus.pro/';
  const timeout = Number(process.env.DECIPLUS_NAV_TIMEOUT || 90000);
  const target = pathPart ? new URL(pathPart, base).href : base;

  try {
    await page.goto(target, {
      waitUntil: options.waitUntil || 'domcontentloaded',
      timeout,
    });
  } catch (err) {
    logWarn('Navigation Deciplus lente, retry commit', { url: target, error: err.message });
    await page.goto(target, { waitUntil: 'commit', timeout: Math.min(timeout, 45000) });
  }
  await page.waitForTimeout(Number(process.env.DECIPLUS_NAV_SETTLE_MS || 400));
}

async function submitLoginForm(page, user, pass) {
  const userSelectors = [
    'input[name="username"]',
    'input[name="login"]',
    'input[name="user"]',
    'input[name="email"]',
    'input[type="email"]',
    '#username',
    '#login',
    '#email',
    'input[type="text"]',
  ];
  const passSelectors = ['input[name="password"]', 'input[type="password"]', '#password'];
  const submitSelectors = [
    'button:has-text("Connexion")',
    'button:has-text("Se connecter")',
    'button[type="submit"]',
    'input[type="submit"]',
  ];

  const userOk = await fillVisible(page, userSelectors, user);
  const passOk = await fillVisible(page, passSelectors, pass);
  if (!userOk || !passOk) {
    throw new Error('Formulaire de connexion Deciplus introuvable — page de vérification email ?');
  }

  for (const sel of submitSelectors) {
    const btn = page.locator(sel).first();
    if ((await btn.count()) > 0 && (await btn.isVisible().catch(() => false))) {
      await btn.click();
      break;
    }
  }

  await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
  await randomDelay(process.env.BOT_MIN_DELAY_MS, process.env.BOT_MAX_DELAY_MS);
}

async function performLogin(page, options = {}) {
  const url = process.env.DECIPLUS_URL;
  const user = process.env.DECIPLUS_USER;
  const pass = process.env.DECIPLUS_PASSWORD;
  const envToken = String(process.env.DECIPLUS_AUTH_TOKEN || '').trim();

  if (!url || !user || !pass) {
    throw new Error('DECIPLUS_URL, DECIPLUS_USER et DECIPLUS_PASSWORD requis');
  }

  const hasStoredSession = fs.existsSync(STORAGE_FILE);

  if (hasStoredSession && !envToken) {
    await gotoDeciplus(page, 'nextgen/home');
    if (await getAccessToken(page)) {
      logInfo('Déjà connecté via session persistée');
      await handleChooseZone(page, options.siteLabel);
      return;
    }
  }

  await gotoDeciplus(page, '');

  if (envToken) {
    await injectAuthToken(page, envToken);
    await gotoDeciplus(page, 'nextgen/home');
    if (await getAccessToken(page)) {
      logInfo('Connecté via DECIPLUS_AUTH_TOKEN');
      await handleChooseZone(page, options.siteLabel);
      return;
    }
    logWarn('DECIPLUS_AUTH_TOKEN ignoré — token invalide ou expiré');
  }

  if (await isVerificationScreen(page)) {
    await handleEmailVerification(page);
  }

  if (await isLoggedIn(page)) {
    const token = await getAccessToken(page);
    if (token) {
      logInfo('Déjà connecté via session persistée');
      await handleChooseZone(page, options.siteLabel);
      return;
    }
    logInfo('Session sans token — reconnexion');
  }

  if (await isVerificationScreen(page)) {
    await handleEmailVerification(page);
    if (await isLoggedIn(page)) {
      logInfo('Connexion Deciplus réussie (code email)');
      await handleChooseZone(page, options.siteLabel);
      return;
    }
  }

  await submitLoginForm(page, user, pass);

  if (await isVerificationScreen(page)) {
    await handleEmailVerification(page);
  }

  if (!(await isLoggedIn(page))) {
    if (await isVerificationScreen(page)) {
      throw new Error(
        'Code email Deciplus requis — DECIPLUS_EMAIL_CODE dans .env ou session exportée (npm run session:export)'
      );
    }
    throw new Error('Échec connexion Deciplus — vérifier identifiants');
  }

  logInfo('Connexion Deciplus réussie');
  await handleChooseZone(page, options.siteLabel);
}

async function login(page, options = {}) {
  assertAuthAllowed();
  if (loginInFlight) return loginInFlight;

  loginInFlight = (async () => {
    try {
      await performLogin(page, options);
    } catch (err) {
      if (isMfaAuthError(err.message)) {
        blockAuthRetries(err.message);
      }
      throw err;
    }
  })().finally(() => {
    loginInFlight = null;
  });

  return loginInFlight;
}

module.exports = {
  SESSION_DIR,
  STORAGE_FILE,
  launchBrowser,
  saveSession,
  isLoggedIn,
  isVerificationScreen,
  handleChooseZone,
  gotoDeciplus,
  getAccessToken,
  login,
  isAuthBlocked,
  isMfaAuthError,
  isSessionRecoverableError,
  getStorageMtimeMs,
};
