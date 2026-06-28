const fs = require('fs');
const path = require('path');
const { ROOT, ensureDir, randomDelay } = require('../lib/utils');
const { logInfo } = require('../lib/logger');
const { launchChromiumWithRetry } = require('./playwright-launch');
const { isChooseZoneScreen, selectSiteInPicker, clickSellOnSite } = require('./deciplus-zone');

const SESSION_DIR = process.env.BOT_SESSION_DIR || path.join(ROOT, 'data', 'session');
const STORAGE_FILE = path.join(SESSION_DIR, 'storage-state.json');

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
  return { browser, context, page };
}

async function saveSession(context) {
  ensureDir(SESSION_DIR);
  await context.storageState({ path: STORAGE_FILE });
  logInfo('Session Deciplus sauvegardée');
}

async function isLoggedIn(page) {
  const url = page.url();
  if (url.includes('login') || url.includes('signin') || url.includes('connexion')) return false;

  const indicators = [
    'text=Membres',
    'text=Dashboard',
    'text=Tableau de bord',
    'nav',
    '[data-testid="dashboard"]',
    '.sidebar',
  ];
  for (const sel of indicators) {
    const loc = page.locator(sel).first();
    if ((await loc.count()) > 0 && (await loc.isVisible().catch(() => false))) return true;
  }
  return !url.includes('login');
}

async function handleChooseZone(page, siteLabel) {
  if (!(await isChooseZoneScreen(page))) return false;

  logInfo('Écran choix de site Deciplus détecté');
  await selectSiteInPicker(page, siteLabel);
  await clickSellOnSite(page);
  return true;
}

async function login(page, options = {}) {
  const url = process.env.DECIPLUS_URL;
  const user = process.env.DECIPLUS_USER;
  const pass = process.env.DECIPLUS_PASSWORD;

  if (!url || !user || !pass) {
    throw new Error('DECIPLUS_URL, DECIPLUS_USER et DECIPLUS_PASSWORD requis');
  }

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await randomDelay(process.env.BOT_MIN_DELAY_MS, process.env.BOT_MAX_DELAY_MS);

  if (await isLoggedIn(page)) {
    const token = await page.evaluate(() => {
      try {
        return JSON.parse(localStorage.getItem('auth') || '{}').token || null;
      } catch {
        return null;
      }
    });
    if (token) {
      logInfo('Déjà connecté via session persistée');
      await handleChooseZone(page, options.siteLabel);
      return;
    }
    logInfo('Session sans token — reconnexion');
  }

  const userSelectors = [
    'input[name="username"]',
    'input[name="login"]',
    'input[name="user"]',
    'input[name="email"]',
    'input[type="text"]',
    'input[type="email"]',
    '#username',
    '#login',
    '#email',
  ];
  const passSelectors = ['input[name="password"]', 'input[type="password"]', '#password'];
  const submitSelectors = [
    'button:has-text("Connexion")',
    'button:has-text("Se connecter")',
    'button[type="submit"]',
    'input[type="submit"]',
  ];

  async function fillFirst(list, value) {
    for (const sel of list) {
      const el = page.locator(sel).first();
      if ((await el.count()) > 0) {
        await el.fill(value);
        return true;
      }
    }
    return false;
  }

  const userOk = await fillFirst(userSelectors, user);
  const passOk = await fillFirst(passSelectors, pass);
  if (!userOk || !passOk) {
    throw new Error('Formulaire de connexion Deciplus introuvable — mettre à jour les sélecteurs');
  }

  for (const sel of submitSelectors) {
    const btn = page.locator(sel).first();
    if ((await btn.count()) > 0) {
      await btn.click();
      break;
    }
  }

  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  await randomDelay(process.env.BOT_MIN_DELAY_MS, process.env.BOT_MAX_DELAY_MS);

  if (!(await isLoggedIn(page))) {
    throw new Error('Échec connexion Deciplus — vérifier identifiants ou captcha');
  }

  logInfo('Connexion Deciplus réussie');
  await handleChooseZone(page, options.siteLabel);
}

module.exports = {
  SESSION_DIR,
  STORAGE_FILE,
  launchBrowser,
  saveSession,
  isLoggedIn,
  handleChooseZone,
  login,
};
