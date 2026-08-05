/**
 * Ventes Deciplus — toutes offres (DUO, Saison, Badge, Essai)
 * Sans module Caisse → via check.php + nextgen/vente
 */
const path = require('path');
const { randomDelay, ensureDir, timestamp } = require('../lib/utils');
const { logInfo, logWarn } = require('../lib/logger');
const { openMemberCheck, clickFirst, fillFirst, sel, closeGreyboxIfOpen } = require('./wallet');
const { cancelSale } = require('./cancel-sale');
const { ensureDeciplusSaleZone, isChooseZoneScreen } = require('./deciplus-zone');
const { dismissJqueryUiOverlay } = require('./ui');
const { buildDeciplusProductSearch, buildSearchTokens, normalizeText } = require('./catalog');

function isBadgeSale(productConfig) {
  return (
    productConfig.sale_type === 'carte' ||
    /badge/i.test(String(productConfig.label || productConfig.deciplus_product_name || ''))
  );
}

function formatFrDate(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()}`;
}

async function findPaiementComptantCheckbox(page) {
  const scopes = [];
  const gb = page.locator('#GB_window').first();
  if ((await gb.count()) > 0 && (await gb.isVisible().catch(() => false))) scopes.push(gb);
  const dialog = page.locator('[role="dialog"]').first();
  if ((await dialog.count()) > 0 && (await dialog.isVisible().catch(() => false))) scopes.push(dialog);
  if (!scopes.length) scopes.push(page);

  for (const scope of scopes) {
    const selectors = [
      'label:has-text("Paiement Comptant") >> .. >> input[type="checkbox"]',
      'label:has-text("Paiement Comptant") >> xpath=following::input[@type="checkbox"][1]',
      ':text("Paiement Comptant") >> xpath=ancestor::*[1]/following::input[@type="checkbox"][1]',
    ];
    for (const selector of selectors) {
      const cb = scope.locator(selector).first();
      if ((await cb.count()) > 0) return cb;
    }
    const dialogCb = scope.locator('input[type="checkbox"]').first();
    if ((await dialogCb.count()) > 0 && scope !== page) return dialogCb;
  }
  return null;
}

async function uncheckPaiementComptantInput(cb) {
  await cb.evaluate((el) => {
    if (!el.checked) return;
    el.checked = false;
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function isPaiementComptantChecked(page) {
  const cb = await findPaiementComptantCheckbox(page);
  if (!cb) return null;
  return cb.isChecked().catch(() => null);
}

function buildSearchCandidates(productConfig) {
  const name = productConfig.deciplus_product_name || productConfig.label || '';
  const candidates = new Set();

  if (productConfig.deciplus_product_search) {
    candidates.add(productConfig.deciplus_product_search);
  }
  candidates.add(buildDeciplusProductSearch(name, productConfig.deciplus_product_id));

  for (const token of buildSearchTokens(name)) {
    candidates.add(token);
  }

  if (productConfig.deciplus_reference) {
    candidates.add(String(productConfig.deciplus_reference));
    candidates.add(String(productConfig.deciplus_reference).replace(/^0+/, ''));
  }
  if (productConfig.deciplus_product_id) {
    candidates.add(String(productConfig.deciplus_product_id));
  }

  for (const value of [
    name,
    name.replace(/\s*€.*$/i, '').trim(),
  ]) {
    if (value) candidates.add(value);
  }

  const price = name.match(/(\d+[,.]\d{2})/);
  if (price) {
    candidates.add(price[1]);
    candidates.add(price[1].replace('.', ','));
  }

  return [...candidates].filter(Boolean);
}

async function openProductCategory(page, productConfig) {
  const isCarte =
    productConfig.sale_type === 'carte' ||
    /badge|decipass|carte/i.test(String(productConfig.label || productConfig.deciplus_product_name || ''));

  const patterns = isCarte
    ? [/Cartes/i, /prépay/i, /Decipass/i]
    : [/^Abonnements$/i, /Abonnement/i];

  for (const pat of patterns) {
    const el = page.getByText(pat).first();
    if ((await el.count()) > 0 && (await el.isVisible().catch(() => false))) {
      await el.click();
      await randomDelay(900, 1400);
      logInfo('Catégorie catalogue Deciplus', { category: String(pat) });
      return true;
    }
  }
  return false;
}

async function getProductTileLocator(page) {
  const selectors = [
    '.product-wrapper-title',
    '.product-wrapper .product-wrapper-title',
    '[class*="product-wrapper-title"]',
    '[class*="product-card"] [class*="title"]',
  ];
  for (const selector of selectors) {
    const loc = page.locator(selector);
    if ((await loc.count()) > 0) return loc;
  }
  return page.locator('.product-wrapper-title');
}

async function scoreProductTile(text, productConfig) {
  const name = productConfig.deciplus_product_name || productConfig.label || '';
  const normalized = normalizeText(text);
  const targetName = normalizeText(name);
  let score = 0;

  if (normalized === targetName) score += 200;
  else if (normalized.includes(targetName) || targetName.includes(normalized)) score += 120;

  const amount = Number(productConfig.amount);
  if (Number.isFinite(amount) && amount > 0) {
    const priceVariants = [
      String(amount),
      String(amount).replace('.', ','),
      amount.toFixed(2),
      amount.toFixed(2).replace('.', ','),
    ];
    for (const pv of priceVariants) {
      if (text.includes(pv)) score += 80;
    }
  }

  if (/training camp/i.test(name) && /training camp/i.test(text)) score += 40;
  if (/badge/i.test(name) && /badge/i.test(text)) score += 100;
  if (/association/i.test(name) && /association/i.test(text)) score += 60;

  const targetTokens = normalizeText(name).split(' ').filter((t) => t.length > 3);
  const textTokens = new Set(normalizeText(text).split(' '));
  const overlap = targetTokens.filter((t) => textTokens.has(t)).length;
  score += overlap * 15;

  return score;
}

async function clickProductResult(page, productConfig) {
  const name = productConfig.deciplus_product_name || productConfig.label || '';
  const tiles = await getProductTileLocator(page);
  const count = await tiles.count();

  let bestTile = null;
  let bestScore = 0;

  for (let i = 0; i < count; i += 1) {
    const tile = tiles.nth(i);
    if (!(await tile.isVisible().catch(() => false))) continue;
    const text = (await tile.innerText().catch(() => '')).trim();
    if (!text) continue;
    const score = await scoreProductTile(text, productConfig);
    if (score > bestScore) {
      bestScore = score;
      bestTile = tile;
    }
  }

  if (bestTile && bestScore >= 40) {
    await bestTile.click();
    logInfo('Produit Deciplus sélectionné', {
      name,
      score: bestScore,
      search: productConfig.deciplus_product_search,
    });
    return true;
  }

  const exact = tiles.filter({ hasText: name }).first();
  if ((await exact.count()) > 0 && (await exact.isVisible().catch(() => false))) {
    await exact.click();
    return true;
  }

  const partial = page.getByText(new RegExp(escapeRegExp(name.slice(0, 24)), 'i')).first();
  if ((await partial.count()) > 0 && (await partial.isVisible().catch(() => false))) {
    await partial.click();
    return true;
  }

  return false;
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function listVisibleProducts(page) {
  const tiles = await getProductTileLocator(page);
  const count = Math.min(await tiles.count(), 8);
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const text = (await tiles.nth(i).innerText().catch(() => '')).trim();
    if (text) out.push(text.slice(0, 60));
  }
  return out;
}

const PRODUCT_SEARCH_SELECTOR =
  'input[placeholder*="Rechercher un produit"], input[placeholder*="Rechercher"], input[placeholder*="prestation"], input[placeholder*="Produit"]';

/**
 * check.php nextgen charge la fiche dans un iframe _vue_iframe.
 * Les boutons Achat sont des input.fichemembre_button[value=...].
 */
async function getMemberCheckContext(page, { waitMs = 20000 } = {}) {
  const deadline = Date.now() + Math.max(0, waitMs);
  const achatSel =
    'input.fichemembre_button[value="Achat Abonnement"], input[type="button"][value="Achat Abonnement"]';
  do {
    try {
      if ((await page.locator(achatSel).count()) > 0) return page;
      for (const frame of page.frames()) {
        if (frame === page.mainFrame()) continue;
        try {
          if ((await frame.locator(achatSel).count()) > 0) return frame;
          if ((await frame.locator('input.fichemembre_button').count()) > 0) return frame;
        } catch {
          /* detached */
        }
      }
    } catch {
      /* nav */
    }
    if (Date.now() >= deadline) break;
    await page.waitForTimeout(400);
  } while (Date.now() < deadline);
  return page;
}

/**
 * Le catalogue nextgen/vente peut être dans la page ou un iframe.
 */
async function resolveVenteCatalogContext(page, { timeoutMs = 25000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const scopes = [page];
    try {
      for (const frame of page.frames()) {
        if (frame !== page.mainFrame()) scopes.push(frame);
      }
    } catch {
      /* frames change during nav */
    }

    for (const ctx of scopes) {
      try {
        const input = ctx.locator(PRODUCT_SEARCH_SELECTOR).first();
        if ((await input.count()) === 0) continue;
        if (await input.isVisible().catch(() => false)) return ctx;
        await input.waitFor({ state: 'visible', timeout: 1500 }).catch(() => {});
        if (await input.isVisible().catch(() => false)) return ctx;
      } catch {
        /* frame detached */
      }
    }
    await page.waitForTimeout(400);
  }
  return null;
}

async function selectProductInCatalog(page, productConfig) {
  const name = productConfig.deciplus_product_name || productConfig.label;
  const searchCandidates = buildSearchCandidates(productConfig);

  const ctx = (await resolveVenteCatalogContext(page, { timeoutMs: 5000 })) || page;
  const searchInput = ctx.locator(PRODUCT_SEARCH_SELECTOR).first();
  await searchInput.waitFor({ state: 'visible', timeout: 20000 });

  await openProductCategory(ctx, productConfig);

  for (const search of searchCandidates) {
    await searchInput.fill('');
    await randomDelay(250, 450);
    await searchInput.fill(search);
    await searchInput.press('Enter').catch(() => {});
    await randomDelay(1500, 2500);

    if (await clickProductResult(ctx, productConfig)) {
      await randomDelay();
      logInfo('Produit Deciplus trouvé dans le catalogue UI', { search, name });
      return true;
    }

    logWarn('Recherche produit Deciplus sans résultat', {
      search,
      name,
      visible: await listVisibleProducts(ctx),
    });
  }

  throw new Error(`Produit Deciplus introuvable: "${name}"`);
}

async function badgeDomEvaluate(ctx, operation, value = null) {
  return ctx.evaluate(
    ({ op, val }) => {
      function deepWalk(root, fn) {
        if (!root) return;
        fn(root);
        if (root.shadowRoot) deepWalk(root.shadowRoot, fn);
        for (const child of root.children || []) deepWalk(child, fn);
      }

      function deepQueryAll(root, selector) {
        const out = [];
        deepWalk(root, (node) => {
          if (node.querySelectorAll) {
            for (const el of node.querySelectorAll(selector)) out.push(el);
          }
        });
        return out;
      }

      function deepText(node) {
        if (!node) return '';
        let text = node.innerText || node.textContent || '';
        if (node.shadowRoot) text += ` ${deepText(node.shadowRoot)}`;
        for (const child of node.children || []) text += ` ${deepText(child)}`;
        return text;
      }

      function setNativeInputValue(input, v) {
        if (!input) return false;
        input.focus();
        input.click();
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
        if (setter) setter.call(input, v);
        else input.value = v;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: v }));
        input.dispatchEvent(new Event('blur', { bubbles: true }));
        return String(input.value || '').trim() === v;
      }

      function findPaiementComptantSwitch() {
        const spans = deepQueryAll(document.body, 'span').filter((el) =>
          /Paiement Comptant/i.test(String(el.textContent || '').replace(/\s+/g, ' ').trim())
        );
        for (const span of spans) {
          let parent = span.parentElement;
          for (let depth = 0; depth < 8 && parent; depth += 1) {
            const sw = parent.querySelector('.el-switch');
            if (sw) return sw;
            parent = parent.parentElement;
          }
        }
        return (
          deepQueryAll(document.body, '.el-switch').find((sw) => {
            const row = sw.closest('.col-12, .row, div');
            return row && /Paiement Comptant/i.test(row.textContent || '');
          }) || null
        );
      }

      function turnOffElSwitch(sw) {
        if (!sw) return false;
        if (!sw.classList.contains('is-checked')) return true;
        const core = sw.querySelector('.el-switch__core');
        if (core) core.click();
        else {
          const input = sw.querySelector('input.el-switch__input, input[role="switch"]');
          if (input) input.click();
          else sw.click();
        }
        return !sw.classList.contains('is-checked');
      }

      function findBadgeDateInputs() {
        const editors = deepQueryAll(
          document.body,
          '.el-date-editor input.el-input__inner, .el-date-editor input, input.el-input__inner'
        ).filter((input) => {
          if (input.type === 'checkbox' || input.type === 'hidden') return false;
          const r = input.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        });

        const dateLike = editors.filter((input) =>
          /^\d{2}\/\d{2}\/\d{4}$/.test(String(input.value || '').trim())
        );
        if (dateLike.length >= 2) return dateLike;

        const valideNode = deepQueryAll(document.body, 'span, label, div, b, strong').find((el) =>
          /^Valide du$/i.test(String(el.textContent || '').replace(/\s+/g, ' ').trim())
        );
        if (valideNode) {
          let parent = valideNode.parentElement;
          for (let depth = 0; depth < 10 && parent; depth += 1) {
            const near = deepQueryAll(parent, '.el-date-editor input, input.el-input__inner').filter(
              (input) => input.type !== 'checkbox' && input.type !== 'hidden'
            );
            if (near.length >= 2) return near;
            parent = parent.parentElement;
          }
        }
        return editors;
      }

      function clickAppliquerButton() {
        const candidates = [
          ...deepQueryAll(document.body, 'button.ari-button-filled, button.ari-button'),
          ...deepQueryAll(document.body, 'button'),
          ...deepQueryAll(document.body, 'input[type="button"], input[type="submit"]'),
        ];
        for (const btn of candidates) {
          const label = String(btn.textContent || btn.value || '').replace(/\s+/g, ' ').trim();
          if (!/^Appliquer$/i.test(label)) continue;
          const r = btn.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) continue;
          btn.click();
          return true;
        }
        return false;
      }

      if (op === 'readText') return deepText(document.body).replace(/\s+/g, ' ');
      if (op === 'turnOffComptant') return turnOffElSwitch(findPaiementComptantSwitch());
      if (op === 'isComptantOn') {
        const sw = findPaiementComptantSwitch();
        return Boolean(sw && sw.classList.contains('is-checked'));
      }
      if (op === 'readAu') {
        const inputs = findBadgeDateInputs();
        return inputs.length >= 2 ? String(inputs[1].value || '').trim() : null;
      }
      if (op === 'fillAu') {
        const inputs = findBadgeDateInputs();
        if (inputs.length < 2) return false;
        return setNativeInputValue(inputs[1], val);
      }
      if (op === 'fillDu') {
        const inputs = findBadgeDateInputs();
        if (inputs.length < 1) return false;
        return setNativeInputValue(inputs[0], val);
      }
      if (op === 'clickAppliquer') return clickAppliquerButton();
      if (op === 'clickModifierDateFin') {
        const candidates = [
          ...deepQueryAll(document.body, 'button.p-button, button, [role="button"], a'),
        ];
        for (const btn of candidates) {
          const label = String(
            btn.textContent || btn.getAttribute('aria-label') || ''
          ).replace(/\s+/g, ' ').trim();
          if (!/Modifier la date de fin/i.test(label)) continue;
          const r = btn.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) continue;
          btn.click();
          return true;
        }
        return false;
      }
      if (op === 'isDateFinDialogOpen') {
        const text = deepText(document.body).replace(/\s+/g, ' ');
        return (
          /Derni[eè]re [eé]ch[eé]ance apr[eè]s/i.test(text) &&
          /Modifier la date de fin/i.test(text)
        );
      }
      if (op === 'closePicker') {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        const title = deepQueryAll(document.body, 'span, h1, h2, h3, div').find((el) =>
          /^Configuration de Badge$/i.test(String(el.textContent || '').replace(/\s+/g, ' ').trim())
        );
        title?.click();
        return true;
      }
      if (op === 'recapReady') {
        const text = deepText(document.body).replace(/\s+/g, ' ');
        if (/en dehors de la dur[ée]e de validit[ée]/i.test(text)) return false;
        if (/Paiement imm[ée]diat/i.test(text) && /34[,.]99/.test(text)) return false;
        return /Pr[eé]l[eè]vement Automatique/i.test(text) && /Date de paiement/i.test(text);
      }
      if (op === 'fillPaymentDate') {
        const setInput = (input) => {
          if (!input) return false;
          const r = input.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) return false;
          input.focus();
          const proto = window.HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          if (setter) setter.call(input, val);
          else input.value = val;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          input.dispatchEvent(new Event('blur', { bubbles: true }));
          return String(input.value || '').trim() === val;
        };

        // Champ proche du libellé « Date de paiement »
        const payLabel = deepQueryAll(document.body, 'span, label, div, b, strong, td, th, p').find((el) =>
          /^Date de paiement$/i.test(String(el.textContent || '').replace(/\s+/g, ' ').trim())
        );
        if (payLabel) {
          let parent = payLabel.parentElement;
          for (let depth = 0; depth < 10 && parent; depth += 1) {
            const near = deepQueryAll(
              parent,
              '.el-date-editor input, input.el-input__inner, input[type="text"], input:not([type])'
            ).filter((input) => input.type !== 'checkbox' && input.type !== 'hidden');
            for (const input of near) {
              if (setInput(input)) return true;
            }
            parent = parent.parentElement;
          }
        }

        // Repli : date inputs visibles hors « Valide du »
        const editors = deepQueryAll(
          document.body,
          '.el-date-editor input.el-input__inner, .el-date-editor input, input.el-input__inner'
        ).filter((input) => {
          if (input.type === 'checkbox' || input.type === 'hidden') return false;
          const r = input.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        });
        // Souvent : [Valide du, au, Date de paiement] → 3e ; sinon 2e si seulement 2
        if (editors.length >= 3 && setInput(editors[2])) return true;
        if (editors.length === 2 && setInput(editors[1])) return true;
        return false;
      }
      return null;
    },
    { op: operation, val: value }
  );
}

async function clickPaiementComptantToggleOff(scope) {
  if (typeof scope.evaluate !== 'function') return false;
  return badgeDomEvaluate(scope, 'turnOffComptant');
}

async function isElSwitchComptantOn(page) {
  const ctx = await resolveDeciplusWorkPage(page);
  return badgeDomEvaluate(ctx, 'isComptantOn');
}

async function ensurePaiementComptantOff(page, { strict = false } = {}) {
  const ctx = await resolveDeciplusWorkPage(page);

  for (let pass = 0; pass < 5; pass += 1) {
    await clickPaiementComptantToggleOff(ctx);
    await randomDelay(500, 900);

    if (!(await isElSwitchComptantOn(page))) {
      logInfo('Paiement Comptant — désactivé (el-switch)');
      return true;
    }

    const cb = await findPaiementComptantCheckbox(page);
    if (cb) {
      const checked = await cb.isChecked().catch(() => null);
      if (checked === false) {
        logInfo('Paiement Comptant — désactivé');
        return true;
      }
      if (checked === true) {
        await uncheckPaiementComptantInput(cb).catch(() => {});
        await cb.uncheck({ force: true, timeout: 5000 }).catch(() => {});
        await randomDelay(400, 700);
      }
    }
  }

  if (await isBadgeConfigModalOpen(page)) {
    const text = await readBadgeConfigModalText(page);
    if (/Pr[eé]l[eè]vement Automatique/i.test(text) && !modalShowsImmediateBadgePayment(text)) {
      logInfo('Paiement Comptant — désactivé (modale badge)');
      return true;
    }
  }

  if (await isElSwitchComptantOn(page)) {
    const msg = 'Paiement Comptant toujours activé';
    if (strict) throw new Error(msg);
    logWarn(msg);
    return false;
  }

  logInfo('Paiement Comptant — désactivé');
  return true;
}

function resolveBadgePrelevementDelayDays(productConfig = {}) {
  // Défaut : 3 jours ≈ 72h après l'abonnement (date de PAIEMENT uniquement)
  const min = Number(
    productConfig.prelevement_delay_days_min ||
      process.env.BADGE_PRELEVEMENT_DELAY_MIN ||
      3
  );
  const max = Number(
    productConfig.prelevement_delay_days_max ||
      process.env.BADGE_PRELEVEMENT_DELAY_MAX ||
      3
  );
  const raw = Number(
    productConfig.prelevement_delay_days ||
      process.env.BADGE_PRELEVEMENT_DELAY_DAYS ||
      3
  );
  const delay = Number.isFinite(raw) ? raw : 3;
  const lo = Number.isFinite(min) ? min : 3;
  const hi = Number.isFinite(max) ? Math.max(lo, max) : lo;
  return Math.min(hi, Math.max(lo, delay));
}

/** Validité contrat Badge Deciplus = 1 mois (pas la fenêtre de prélèvement ~72h). */
function resolveBadgeValidityDays(productConfig = {}) {
  const raw = Number(
    productConfig.badge_validity_days ||
      process.env.BADGE_VALIDITY_DAYS ||
      30
  );
  return Number.isFinite(raw) && raw > 0 ? raw : 30;
}

function badgeValidityDates(validityDays = 30) {
  const startDate = new Date();
  const endDate = new Date(startDate);
  endDate.setDate(endDate.getDate() + validityDays);
  return {
    startDate,
    endDate,
    startStr: formatFrDate(startDate),
    endStr: formatFrDate(endDate),
    isoEnd: endDate.toISOString().slice(0, 10),
  };
}

function badgePaymentDateParts(delayDays = 3) {
  const date = new Date();
  date.setDate(date.getDate() + delayDays);
  return { date, str: formatFrDate(date) };
}

/** @deprecated préférer badgeValidityDates + badgePaymentDateParts */
function badgeContractDates(delayDays = 3) {
  // Historique : confondait fin de validité et date de paiement.
  // Conservé pour appels legacy → validité 1 mois + paiement J+delay exposé via endStr paiement? Non.
  // On expose la VALIDITÉ 1 mois ; le paiement se calcule à part.
  return badgeValidityDates(resolveBadgeValidityDays());
}

function badgeEndDate(validityDays = 30) {
  const { endDate, endStr, isoEnd: iso } = badgeValidityDates(validityDays);
  return { endDate, endStr, iso };
}

function parseFrDate(str) {
  const m = String(str || '').match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (!m) return null;
  return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
}

function isFrDateAtLeast(actual, expected) {
  const a = parseFrDate(actual);
  const e = parseFrDate(expected);
  return Boolean(a && e && a.getTime() >= e.getTime());
}

async function captureBadgeDebugScreenshot(page, label) {
  try {
    const dir = path.join(process.env.BOT_DATA_DIR || 'data', 'logs');
    ensureDir(dir);
    const file = path.join(dir, `badge-${label}-${timestamp()}.png`);
    await page.screenshot({ path: file, fullPage: true });
    logWarn('Badge — capture debug', { screenshot: file });
    return file;
  } catch {
    return null;
  }
}

async function resolveDeciplusWorkPage(page) {
  for (const frame of page.frames()) {
    const name = frame.name() || '';
    if (/GB_frame/i.test(name)) {
      try {
        const hit = await frame.evaluate(() => {
          const text = String(document.body?.innerText || '');
          return /Configuration de Badge|Paiement Comptant/i.test(text);
        });
        if (hit) return frame;
      } catch {
        /* ignore */
      }
    }
  }

  for (const frame of page.frames()) {
    try {
      const hit = await frame.evaluate(() => {
        const text = String(document.body?.innerText || '');
        return /Configuration de Badge/i.test(text) && /Paiement Comptant/i.test(text);
      });
      if (hit) return frame;
    } catch {
      /* ignore detached/cross-origin frames */
    }
  }

  for (const frame of page.frames()) {
    if (/nextgen\/vente|\/vente/i.test(frame.url())) return frame;
  }

  return page;
}

async function getBadgeConfigModal(page) {
  if (!(await isBadgeConfigModalOpen(page))) return null;
  return resolveDeciplusWorkPage(page);
}

async function isBadgeConfigModalOpen(page) {
  const ctx = await resolveDeciplusWorkPage(page);
  const text = await badgeDomEvaluate(ctx, 'readText');
  return (
    /Configuration de Badge/i.test(text) &&
    /Paiement Comptant/i.test(text) &&
    /Valide\s+du/i.test(text)
  );
}

async function waitForBadgeConfigModal(page, timeoutMs = 15000, { tryReopen = true } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isBadgeConfigModalOpen(page)) return true;
    await page.waitForTimeout(250);
  }

  await page.getByText(/Configuration de Badge|Paiement Comptant/i).first()
    .waitFor({ state: 'visible', timeout: 3000 })
    .catch(() => {});
  if (await getBadgeConfigModal(page)) return true;

  if (tryReopen) {
    await clickBadgeConfigEntry(page);
    await randomDelay(800, 1200);
    return waitForBadgeConfigModal(page, 8000, { tryReopen: false });
  }
  return isBadgeConfigModalOpen(page);
}

async function clickBadgeConfigEntry(page) {
  const ctx = await resolveDeciplusWorkPage(page);
  const targets = [
    ctx.locator('text=/Prestation/i').locator('xpath=ancestor::*[1]').getByText(/^Badge$/i).first(),
    ctx.locator('div, tr, li, section').filter({ hasText: /^Badge$/ }).filter({ hasText: /34[,.]99/ }).first(),
    ctx.getByText(/^Badge$/i).last(),
  ];
  for (const el of targets) {
    if ((await el.count()) === 0 || !(await el.isVisible().catch(() => false))) continue;
    await el.click({ force: true }).catch(() => {});
    return true;
  }
  return false;
}

async function reopenBadgeConfigModal(page) {
  await clickBadgeConfigEntry(page);
  await randomDelay(800, 1200);
  return waitForBadgeConfigModal(page, 10000, { tryReopen: false });
}

async function ensureBadgeConfigModalForSale(page) {
  const ctx = await resolveDeciplusWorkPage(page);
  if (await waitForBadgeConfigModal(page, 10000, { tryReopen: false })) return true;

  await clickBadgeConfigEntry(page);
  await randomDelay(1000, 1500);
  if (await waitForBadgeConfigModal(page, 8000, { tryReopen: false })) return true;

  const tile = ctx.locator('.product-wrapper-title, [class*="product-wrapper"]').filter({ hasText: /^Badge$/i }).first();
  if ((await tile.count()) > 0 && (await tile.isVisible().catch(() => false))) {
    await tile.click({ force: true }).catch(() => {});
    await randomDelay(1500, 2200);
  }

  await waitForBadgeConfigModal(page, 10000, { tryReopen: false });
  return isBadgeConfigModalOpen(page);
}

async function waitForBadgeModalClosed(page, timeoutMs = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!(await isBadgeConfigModalOpen(page))) return true;
    await page.waitForTimeout(300);
  }
  return false;
}

function extractBadgePaymentDate(text) {
  const m = String(text || '').match(/Date de paiement\s*(\d{2}\/\d{2}\/\d{4})/i);
  return m ? m[1] : null;
}

function modalShowsImmediateBadgePayment(text) {
  return /Paiement imm[ée]diat/i.test(text) && /34[,.]99/.test(text);
}

function minBadgePaymentDate(delayDays = 3) {
  const d = new Date();
  // Tolérance J+(delay-1) pour fuseau / arrondi Deciplus (ex. 72h → à partir de J+2)
  d.setDate(d.getDate() + Math.max(1, Number(delayDays) - 1));
  d.setHours(0, 0, 0, 0);
  return d;
}

async function readBadgeConfigModalText(page) {
  if (!(await isBadgeConfigModalOpen(page))) return '';
  const ctx = await resolveDeciplusWorkPage(page);
  return badgeDomEvaluate(ctx, 'readText');
}

async function readBadgeAuValueFromModal(page) {
  const ctx = await resolveDeciplusWorkPage(page);
  return badgeDomEvaluate(ctx, 'readAu');
}

async function clickBadgeModalAppliquer(page) {
  const ctx = await resolveDeciplusWorkPage(page);
  const clicked = await badgeDomEvaluate(ctx, 'clickAppliquer');
  if (clicked) await randomDelay(600, 1000);
  return clicked;
}

async function clickDeepLabel(ctx, labelPattern, { exact = false, preferClass = null } = {}) {
  if (typeof ctx?.evaluate !== 'function') return false;
  return ctx.evaluate(
    ({ patternStr, exactMatch, classHint }) => {
      const pattern = new RegExp(patternStr, exactMatch ? '' : 'i');

      function deepWalk(root, fn) {
        if (!root) return;
        fn(root);
        if (root.shadowRoot) deepWalk(root.shadowRoot, fn);
        for (const child of root.children || []) deepWalk(child, fn);
      }

      function deepQueryAll(root, selector) {
        const out = [];
        deepWalk(root, (node) => {
          if (node.querySelectorAll) {
            for (const el of node.querySelectorAll(selector)) out.push(el);
          }
        });
        return out;
      }

      function normText(el) {
        return String(el.innerText || el.textContent || el.getAttribute('aria-label') || '')
          .replace(/\s+/g, ' ')
          .trim();
      }

      function isVisible(el) {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      }

      function matches(label) {
        if (exactMatch) return pattern.test(label) && label.length <= 24;
        return pattern.test(label);
      }

      const prioritized = classHint
        ? deepQueryAll(document.body, `[class*="${classHint}"]`)
        : [];

      const selector =
        'button, [role="button"], a, div.verticalDocumentBar, div[class*="verticalDocumentBar"], div[class*="paymentModes"], div[class*="DocumentBar"], span, div';
      const candidates = [...prioritized, ...deepQueryAll(document.body, selector)];

      let best = null;
      let bestScore = -1;

      for (const el of candidates) {
        const label = normText(el);
        if (!label || !matches(label)) continue;
        if (!isVisible(el)) continue;
        if (/Facture|Reçu|Contrat/i.test(label) && /Terminer/i.test(label) && label.length > 16) {
          continue;
        }

        const r = el.getBoundingClientRect();
        let score = r.top;
        if (classHint && String(el.className || '').includes(classHint)) score += 10000;
        if (/^>?[\s>]*Terminer$/i.test(label)) score += 5000;
        if (label.length <= 12) score += 1000;

        if (score > bestScore) {
          bestScore = score;
          best = el;
        }
      }

      if (best) {
        best.scrollIntoView({ block: 'center', inline: 'center' });
        best.click();
        return true;
      }
      return false;
    },
    {
      patternStr: labelPattern.source,
      exactMatch: exact,
      classHint: preferClass,
    }
  );
}

async function clickVenteFooterAction(page, labelPattern, opts = {}) {
  const work = await resolveDeciplusWorkPage(page);
  const scopes = [work, page, ...(page.frames?.() || [])];
  const seen = new Set();
  for (const ctx of scopes) {
    const key = ctx.url?.() || String(ctx);
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      await ctx.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
      if (await clickDeepLabel(ctx, labelPattern, opts)) return true;
    } catch {
      /* frame détachée */
    }
  }
  return false;
}

async function clickTerminerVente(page) {
  await randomDelay(800, 1200);

  const work = await resolveDeciplusWorkPage(page);
  const scopes = [work, page, ...(page.frames?.() || [])];
  const seen = new Set();

  for (const ctx of scopes) {
    const key = ctx.url?.() || String(ctx);
    if (seen.has(key)) continue;
    seen.add(key);

    try {
      await ctx.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});

      const viaDom = await clickDeepLabel(ctx, /\bTerminer\b/i, {
        preferClass: 'verticalDocumentBar',
      });
      if (viaDom) return true;

      const bar = ctx.locator('[class*="verticalDocumentBar"]').filter({ hasText: /Terminer/i }).last();
      if ((await bar.count()) > 0 && (await bar.isVisible().catch(() => false))) {
        await bar.scrollIntoViewIfNeeded().catch(() => {});
        await bar.click({ force: true });
        return true;
      }

      const terminerText = ctx.getByText(/^>?[\s>]*Terminer$/i).last();
      if ((await terminerText.count()) > 0 && (await terminerText.isVisible().catch(() => false))) {
        await terminerText.scrollIntoViewIfNeeded().catch(() => {});
        await clickParentClickable(terminerText);
        return true;
      }
    } catch {
      /* ignore */
    }
  }
  return false;
}

async function clickParentClickable(locator) {
  const handle = await locator.elementHandle().catch(() => null);
  if (!handle) {
    await locator.click({ force: true });
    return;
  }
  await handle.evaluate((el) => {
    let node = el;
    for (let i = 0; i < 6 && node; i += 1) {
      const cls = String(node.className || '');
      if (/verticalDocumentBar|DocumentBar|paymentModes|col-auto/i.test(cls)) {
        node.scrollIntoView({ block: 'center', inline: 'center' });
        node.click();
        return;
      }
      node = node.parentElement;
    }
    el.scrollIntoView({ block: 'center', inline: 'center' });
    el.click();
  });
}

async function isBadgeDateFinDialogOpen(page) {
  const scopes = [page, ...(page.frames?.() || [])];
  for (const ctx of scopes) {
    try {
      if (await badgeDomEvaluate(ctx, 'isDateFinDialogOpen')) return true;
    } catch {
      /* ignore */
    }
  }
  return false;
}

async function handleBadgeModifierDateFinDialog(page, { timeoutMs = 15000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const scopes = [await resolveDeciplusWorkPage(page), page, ...(page.frames?.() || [])];
    for (const ctx of scopes) {
      try {
        if (await badgeDomEvaluate(ctx, 'clickModifierDateFin')) {
          logInfo('Badge — « Modifier la date de fin » (popup échéance)');
          await randomDelay(800, 1200);
          if (await isBadgeConfigModalOpen(page)) {
            await clickBadgeModalAppliquer(page);
            await randomDelay(600, 1000);
          }
          return true;
        }
      } catch {
        /* ignore */
      }
    }

    if (!(await isBadgeDateFinDialogOpen(page))) {
      return false;
    }
    await page.waitForTimeout(400);
  }

  if (await isBadgeDateFinDialogOpen(page)) {
    const clicked = await clickFirst(page, sel('payment_finalize.modifier_date_fin_popup'));
    if (clicked) {
      logInfo('Badge — « Modifier la date de fin » (fallback sélecteur)');
      await randomDelay(800, 1200);
      return true;
    }
    throw new Error('Badge — popup « Modifier la date de fin » visible mais bouton introuvable');
  }

  return false;
}

async function waitForBadgeModalRecapReady(page, delayDays = 3, timeoutMs = 15000) {
  const minPay = minBadgePaymentDate(delayDays);
  const maxPay = new Date();
  maxPay.setDate(maxPay.getDate() + delayDays + 2);
  maxPay.setHours(23, 59, 59, 999);
  const ctx = await resolveDeciplusWorkPage(page);
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    if (await badgeDomEvaluate(ctx, 'recapReady')) {
      const text = await readBadgeConfigModalText(page);
      const payDate = extractBadgePaymentDate(text);
      const parsed = parseFrDate(payDate);
      if (parsed && parsed >= minPay && parsed <= maxPay) return true;
    }

    const text = await readBadgeConfigModalText(page);
    if (text && !/en dehors de la dur[ée]e de validit[ée]/i.test(text)) {
      if (/Pr[eé]l[eè]vement Automatique/i.test(text) && !modalShowsImmediateBadgePayment(text)) {
        const payDate = extractBadgePaymentDate(text);
        const parsed = parseFrDate(payDate);
        if (parsed && parsed >= minPay && parsed <= maxPay) return true;
      }
    }

    await page.waitForTimeout(500);
  }
  return false;
}

async function verifyVentePageBadgeDeferred(page, delayDays = 3) {
  const text = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
  if (modalShowsImmediateBadgePayment(text)) return false;

  const minPay = minBadgePaymentDate(delayDays);
  const maxPay = new Date();
  maxPay.setDate(maxPay.getDate() + delayDays + 2);
  maxPay.setHours(23, 59, 59, 999);
  const payDate = extractBadgePaymentDate(text);
  const parsed = parseFrDate(payDate);
  if (parsed && parsed >= minPay && parsed <= maxPay) return true;

  // Sans date lisible : ne pas valider un échéancier à 1 mois
  return false;
}

async function getBadgeEditorScopes(page) {
  const modal = await getBadgeConfigModal(page);
  if (modal) return [modal];

  const locators = [
    page.locator('#GB_window').first(),
    page.locator('[role="dialog"]').first(),
    page.locator('.swal2-popup').first(),
    page.locator('.modal-content').first(),
  ];
  const out = [];
  for (const scope of locators) {
    if ((await scope.count()) > 0 && (await scope.isVisible().catch(() => false))) {
      out.push(scope);
    }
  }
  return out;
}

async function fillDateFieldByDom(page, labelText, value) {
  return page.evaluate(
    ({ label, val }) => {
      const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const target = norm(label);
      const candidates = [...document.querySelectorAll('label, span, td, th, div, p, b, strong')].filter(
        (el) => norm(el.textContent) === target || norm(el.textContent).startsWith(`${target} `)
      );
      for (const node of candidates) {
        let root = node.parentElement;
        for (let depth = 0; depth < 6 && root; depth += 1) {
          const inputs = [...root.querySelectorAll('input:not([type="hidden"])')].filter(
            (input) => input.offsetParent !== null
          );
          if (inputs.length > 0) {
            const input = inputs.length > 1 && /fin/i.test(label) ? inputs[inputs.length - 1] : inputs[0];
            input.focus();
            input.value = val;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          }
          root = root.parentElement;
        }
      }
      return false;
    },
    { label: labelText, val: value }
  );
}

async function fillDateFieldByLabel(scope, labelPattern, value) {
  const labelText = labelPattern.source.replace(/\\b.*$/i, '').replace(/^\//, '').replace(/\\i$/i, '');

  const locators = [
    scope.getByLabel(labelPattern).first(),
    scope.getByText(labelPattern).locator('xpath=following::input[1]').first(),
    scope.locator('tr').filter({ hasText: labelPattern }).locator('input').first(),
    scope.locator('div').filter({ has: scope.getByText(labelPattern) }).locator('input').first(),
  ];

  for (const el of locators) {
    if ((await el.count()) === 0 || !(await el.isVisible().catch(() => false))) continue;
    await el.click({ force: true }).catch(() => {});
    await el.fill('').catch(() => {});
    await el.fill(value).catch(() => {});
    await el.press('Tab').catch(() => {});
    const current = (await el.inputValue().catch(() => '')).trim();
    if (current.includes(value.slice(0, 5)) || current === value) return true;
  }

  if (/fin/i.test(labelText)) {
    const filled = await fillFirst(
      scope,
      'input[name="dfin"], input[name="date_fin"], input[name="datefin"], input[name="dateFin"], input[id*="dfin"], input[id*="date_fin"]',
      value
    );
    if (filled) return true;
  }

  if (typeof scope.evaluate === 'function') {
    return fillDateFieldByDom(scope, labelText, value);
  }
  return false;
}

async function uncheckKeepDuration(scope) {
  const selectors = [
    sel('sale_config_modal.conserver_duree'),
    'label:has-text("Conserver la durée") input[type="checkbox"]',
  ];
  for (const selector of selectors) {
    const cb = scope.locator(selector).first();
    if ((await cb.count()) === 0) continue;
    const checked = await cb.isChecked().catch(() => null);
    if (checked === true) {
      await cb.uncheck({ force: true }).catch(async () => {
        await cb.evaluate((el) => {
          el.checked = false;
          el.dispatchEvent(new Event('change', { bubbles: true }));
        });
      });
    }
    return true;
  }
  return false;
}

async function ensureContractModifyAction(scope) {
  const finVisible = scope.getByText(/Date de fin/i).first();
  if ((await finVisible.count()) > 0 && (await finVisible.isVisible().catch(() => false))) {
    return true;
  }

  const actionHeader = scope.getByText(/Action souhaitée/i).first();
  if ((await actionHeader.count()) === 0 || !(await actionHeader.isVisible().catch(() => false))) {
    return false;
  }

  const selects = scope.locator('select');
  const count = await selects.count();
  for (let i = 0; i < count; i += 1) {
    const select = selects.nth(i);
    if (!(await select.isVisible().catch(() => false))) continue;
    const options = await select.locator('option').allTextContents();
    const modIndex = options.findIndex((o) => /modifier/i.test(o));
    if (modIndex >= 0) {
      await select.selectOption({ index: modIndex }).catch(() => {});
      await randomDelay(400, 700);
      return true;
    }
  }

  const modBtn = scope.getByRole('button', { name: /^Modifier$/i }).first();
  if ((await modBtn.count()) > 0 && (await modBtn.isVisible().catch(() => false))) {
    await modBtn.click();
    await randomDelay(400, 700);
    return true;
  }
  return false;
}

async function focusBadgeContractInSale(page) {
  const selectors = [
    'text=/Prestation\\s*:\\s*Badge/i',
    ':text("Prestation") >> xpath=ancestor::*[1] >> text=Badge',
    '[class*="contract"]:has-text("Badge")',
    'text=/Contrat n°.*Badge/i',
  ];
  for (const selector of selectors) {
    const el = page.locator(selector).first();
    if ((await el.count()) > 0 && (await el.isVisible().catch(() => false))) {
      await el.click();
      await randomDelay(500, 800);
      return true;
    }
  }

  const badgeTile = page.getByText(/^Badge$/i).last();
  if ((await badgeTile.count()) > 0 && (await badgeTile.isVisible().catch(() => false))) {
    await badgeTile.click();
    await randomDelay(500, 800);
    return true;
  }
  return false;
}

async function ensureMemberCheckForBadgeEdit(page, memberId) {
  if (!memberId) return false;

  if (!page.url().includes('check.php')) {
    await openMemberCheck(page, memberId);
    await randomDelay(1500, 2200);
  } else {
    await randomDelay(800, 1200);
  }
  await focusBadgeContractInSale(page);
  return page.url().includes('check.php');
}

async function applyContractDateChange(scope) {
  const applied = await clickFirst(
    scope,
    [
      'button:has-text("Appliquer"):not(:has-text("Quitter"))',
      sel('sale_config_modal.appliquer'),
      sel('contract_actions.appliquer_quitter'),
      'button:has-text("Appliquer")',
    ].join(', ')
  );
  if (applied) await randomDelay(600, 1000);
  return applied;
}

async function fillBadgeContractDates(page, validityDays = 30) {
  const { startStr, endStr } = badgeValidityDates(validityDays);
  await focusBadgeContractInSale(page);

  for (const scope of await getBadgeEditorScopes(page)) {
    await ensureContractModifyAction(scope);
    await uncheckKeepDuration(scope);

    await fillDateFieldByLabel(scope, /Date de début/i, startStr);
    const finFilled = await fillDateFieldByLabel(scope, /Date de fin/i, endStr);
    if (!finFilled) continue;

    if (await applyContractDateChange(scope)) {
      logInfo('Badge — validité contrat 1 mois', {
        date_debut: startStr,
        date_fin: endStr,
        validity_days: validityDays,
      });
      return true;
    }
  }

  return false;
}

async function findModifierDateFinControl(page) {
  const patterns = [
    sel('sale_config_modal.modifier_date_fin'),
    'button:has-text("Modifier la date de fin")',
    'a:has-text("Modifier la date de fin")',
    '[role="button"]:has-text("Modifier la date de fin")',
    'text=/Modifier la date de fin/i',
    'text=/Modifier.*date.*fin/i',
  ];

  for (const pattern of patterns) {
    const el = page.locator(pattern).first();
    if ((await el.count()) > 0 && (await el.isVisible().catch(() => false))) {
      return el;
    }
  }

  const roleBtn = page.getByRole('button', { name: /Modifier la date de fin/i }).first();
  if ((await roleBtn.count()) > 0 && (await roleBtn.isVisible().catch(() => false))) {
    return roleBtn;
  }

  const roleLink = page.getByRole('link', { name: /Modifier la date de fin/i }).first();
  if ((await roleLink.count()) > 0 && (await roleLink.isVisible().catch(() => false))) {
    return roleLink;
  }

  return null;
}

async function fillBadgeEndDateFields(page, validityDays = 30) {
  const { endStr } = badgeEndDate(validityDays);

  for (const scope of await getBadgeEditorScopes(page)) {
    await uncheckKeepDuration(scope);
    const filled = await fillDateFieldByLabel(scope, /Date de fin/i, endStr);
    if (filled) {
      logInfo('Badge — date de fin saisie (validité)', { date_fin: endStr, validity_days: validityDays });
      return true;
    }
  }

  return false;
}

async function confirmBadgeDateModal(page) {
  return clickFirst(
    page,
    [
      sel('contract_actions.appliquer_quitter'),
      sel('sale_config_modal.appliquer'),
      'button:has-text("Appliquer et Quitter")',
      'button:has-text("Appliquer")',
      'button:has-text("Valider")',
    ].join(', ')
  );
}

async function adjustBadgeEndDate(page, validityDays = 30) {
  const modControl = await findModifierDateFinControl(page);
  if (!modControl) return false;

  await modControl.click();
  await randomDelay(800, 1200);

  const { endStr } = badgeEndDate(validityDays);
  await fillBadgeEndDateFields(page, validityDays);

  const applied = await confirmBadgeDateModal(page);
  if (!applied) {
    throw new Error('Badge — validation date de fin impossible (Appliquer introuvable)');
  }

  logInfo('Badge — date de fin (validité 1 mois)', {
    date_fin: endStr,
    validity_days: validityDays,
  });
  await randomDelay(600, 1000);
  return true;
}

async function adjustBadgeEndDateWithRetry(page, validityDays = 30, { attempts = 12, intervalMs = 1000 } = {}) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      if (await adjustBadgeEndDate(page, validityDays)) return true;
    } catch (err) {
      logWarn('Badge — ajustement date de fin interrompu', { error: err.message, attempt: i + 1 });
    }
    if (await fillBadgeEndDateFields(page, validityDays)) return true;
    await page.waitForTimeout(intervalMs);
  }
  return false;
}

async function readBadgeAuValueViaDom(scope) {
  if (typeof scope.evaluate !== 'function') return null;
  return scope.evaluate(() => {
    const isVisible = (el) => el && el.offsetParent !== null;
    const readInput = (input) => String(input?.value || '').trim();

    const modalRoot =
      document.querySelector('#GB_window') ||
      document.querySelector('[role="dialog"]') ||
      [...document.querySelectorAll('*')].find((el) =>
        /Configuration de Badge/i.test(String(el.textContent || '').slice(0, 80))
      )?.closest('div');

    const searchRoots = modalRoot ? [modalRoot, document.body] : [document.body];

    for (const root of searchRoots) {
      const inputs = [...root.querySelectorAll('input:not([type="hidden"])')].filter(isVisible);
      const dateLike = inputs.filter((input) =>
        /^\d{2}\/\d{2}\/\d{4}$/.test(String(input.value || '').trim())
      );
      if (dateLike.length >= 2) return readInput(dateLike[1]);

      const valideNode = [...root.querySelectorAll('*')].find(
        (el) => /^Valide du$/i.test(String(el.textContent || '').trim())
      );
      if (valideNode) {
        let parent = valideNode.parentElement;
        for (let depth = 0; depth < 8 && parent; depth += 1) {
          const near = [...parent.querySelectorAll('input:not([type="hidden"])')].filter(isVisible);
          if (near.length >= 2) return readInput(near[1]);
          parent = parent.parentElement;
        }
      }

      const auNode = [...root.querySelectorAll('*')].find(
        (el) => /^au$/i.test(String(el.textContent || '').trim())
      );
      if (auNode) {
        let parent = auNode.parentElement;
        for (let depth = 0; depth < 6 && parent; depth += 1) {
          const near = [...parent.querySelectorAll('input:not([type="hidden"])')].filter(isVisible);
          if (near.length >= 1) return readInput(near[0]);
          parent = parent.parentElement;
        }
      }
    }
    return null;
  });
}

async function readBadgeAuValue(scope) {
  const selectors = [
    sel('sale_config_modal.valide_au_input'),
    sel('sale_config_modal.valide_au_alt'),
    ':text("Valide du") >> xpath=following::input[2]',
    ':text-is("au") >> xpath=following::input[1]',
  ];

  for (const selector of selectors) {
    if (!selector || selector.includes(',')) continue;
    const el = scope.locator(selector).first();
    if ((await el.count()) === 0 || !(await el.isVisible().catch(() => false))) continue;
    const current = (await el.inputValue().catch(() => '')).trim();
    if (current) return current;
  }

  return readBadgeAuValueViaDom(scope);
}

async function fillBadgeAuDateViaDom(scope, endStr) {
  if (typeof scope.evaluate !== 'function') return false;
  return scope.evaluate(
    ({ val, helper }) => {
      const isVisible = (el) => el && el.offsetParent !== null;
      const setInput = (input) => {
        if (!input || !isVisible(input)) return false;
        input.focus();
        const proto = window.HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) setter.call(input, val);
        else input.value = val;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: val }));
        input.dispatchEvent(new Event('blur', { bubbles: true }));
        return String(input.value || '').trim() === val;
      };

      const modalRoot =
        document.querySelector('#GB_window') ||
        document.querySelector('[role="dialog"]') ||
        [...document.querySelectorAll('*')].find((el) =>
          /Configuration de Badge/i.test(String(el.textContent || '').slice(0, 80))
        )?.closest('div');

      const searchRoots = modalRoot ? [modalRoot, document.body] : [document.body];

      for (const root of searchRoots) {
        const inputs = [...root.querySelectorAll('input:not([type="hidden"])')].filter(isVisible);
        const dateLike = inputs.filter((input) =>
          /^\d{2}\/\d{2}\/\d{4}$/.test(String(input.value || '').trim())
        );
        if (dateLike.length >= 2 && setInput(dateLike[1])) return true;

        const valideNode = [...root.querySelectorAll('*')].find(
          (el) => /^Valide du$/i.test(String(el.textContent || '').trim())
        );
        if (valideNode) {
          let parent = valideNode.parentElement;
          for (let depth = 0; depth < 8 && parent; depth += 1) {
            const near = [...parent.querySelectorAll('input:not([type="hidden"])')].filter(isVisible);
            if (near.length >= 2 && setInput(near[1])) return true;
            parent = parent.parentElement;
          }
        }

        const auNode = [...root.querySelectorAll('*')].find(
          (el) => /^au$/i.test(String(el.textContent || '').trim())
        );
        if (auNode) {
          let parent = auNode.parentElement;
          for (let depth = 0; depth < 6 && parent; depth += 1) {
            const near = [...parent.querySelectorAll('input:not([type="hidden"])')].filter(isVisible);
            if (near.length >= 1 && setInput(near[0])) return true;
            parent = parent.parentElement;
          }
        }
      }
      return false;
    },
    { val: endStr, helper: true }
  );
}

async function fillBadgeAuDateViaKeyboard(page, scope, endStr) {
  const keyboard = page.keyboard;
  const selectors = [
    sel('sale_config_modal.valide_au_input'),
    sel('sale_config_modal.valide_au_alt'),
    ':text("Valide du") >> xpath=following::input[2]',
    ':text-is("au") >> xpath=following::input[1]',
  ];

  for (const selector of selectors) {
    if (!selector || selector.includes(',')) continue;
    const el = scope.locator(selector).first();
    if ((await el.count()) === 0 || !(await el.isVisible().catch(() => false))) continue;
    await el.click({ clickCount: 3, force: true }).catch(() => {});
    await keyboard.press('Control+A').catch(() => {});
    await keyboard.type(endStr, { delay: 40 }).catch(() => {});
    await keyboard.press('Tab').catch(() => {});
    const current = (await el.inputValue().catch(() => '')).trim();
    if (isFrDateAtLeast(current, endStr)) return true;
  }

  return false;
}

async function fillBadgeAuDate(page, scope, endStr) {
  const selectors = [
    sel('sale_config_modal.valide_au_input'),
    sel('sale_config_modal.valide_au_alt'),
    ':text("Valide du") >> xpath=following::input[2]',
    ':text-is("au") >> xpath=following::input[1]',
  ];

  for (const selector of selectors) {
    if (!selector || selector.includes(',')) continue;
    const el = scope.locator(selector).first();
    if ((await el.count()) === 0 || !(await el.isVisible().catch(() => false))) continue;
    await el.click({ force: true }).catch(() => {});
    await el.fill('').catch(() => {});
    await el.fill(endStr).catch(() => {});
    await el.press('Tab').catch(() => {});
    const current = (await el.inputValue().catch(() => '')).trim();
    if (isFrDateAtLeast(current, endStr)) return true;
  }

  if (await fillBadgeAuDateViaDom(scope, endStr)) return true;
  if (await fillBadgeAuDateViaKeyboard(page, scope, endStr)) return true;

  const readback = await readBadgeAuValue(scope);
  return isFrDateAtLeast(readback, endStr);
}

async function fillBadgeValideDuDate(scope, startStr) {
  const el = scope.locator(sel('sale_config_modal.valide_du_input')).first();
  if ((await el.count()) === 0 || !(await el.isVisible().catch(() => false))) {
    return fillDateFieldByLabel(scope, /Valide du/i, startStr);
  }
  await el.click({ force: true }).catch(() => {});
  await el.fill(startStr).catch(() => {});
  await el.press('Tab').catch(() => {});
  return true;
}

async function nudgeBadgeModalRecap(page) {
  const modal = await getBadgeConfigModal(page);
  if (!modal) return;
  await modal.getByText(/Configuration de Badge|Récap|Valide du/i).first().click({ force: true }).catch(() => {});
  await randomDelay(400, 700);
}

async function waitForBadgeWarningGone(page, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const text = await readBadgeConfigModalText(page);
    if (!text || !/en dehors de la dur[ée]e de validit[ée]/i.test(text)) return true;
    await page.waitForTimeout(400);
  }
  return false;
}

async function verifyBadgeConfigModalReady(page, delayDays = 7) {
  return waitForBadgeModalRecapReady(page, delayDays, 2000);
}

async function verifyBadgeDeferredSetup(page, delayDays = 7) {
  if (await isBadgeConfigModalOpen(page)) {
    return waitForBadgeModalRecapReady(page, delayDays, 2000);
  }
  return verifyVentePageBadgeDeferred(page, delayDays);
}

async function fillBadgeDatesInConfigModal(page, delayDays = 3, validityDays = 30) {
  await waitForBadgeConfigModal(page, 15000);

  const ctx = await resolveDeciplusWorkPage(page);
  const { startStr, endStr } = badgeValidityDates(validityDays);
  const payStr = badgePaymentDateParts(delayDays).str;

  await badgeDomEvaluate(ctx, 'fillDu', startStr);
  let filledAu = await badgeDomEvaluate(ctx, 'fillAu', endStr);
  await fillBadgePaymentDate(page, payStr);
  await randomDelay(500, 800);
  await page.keyboard.press('Escape').catch(() => {});
  await badgeDomEvaluate(ctx, 'closePicker');
  await randomDelay(800, 1200);

  if (!filledAu) {
    filledAu = await fillBadgeAuDateViaDom(ctx, endStr);
  }
  if (!filledAu) {
    filledAu = await fillBadgeAuDateViaKeyboard(page, ctx, endStr);
  }

  await randomDelay(1200, 1800);
  await waitForBadgeWarningGone(page);

  const auReadback = await readBadgeAuValueFromModal(page);
  const ready = await waitForBadgeModalRecapReady(page, delayDays, 12000);

  logInfo('Badge — validité 1 mois + paiement ~72h', {
    valide_du: startStr,
    valide_au: endStr,
    date_paiement: payStr,
    au_readback: auReadback,
    delay_days: delayDays,
    validity_days: validityDays,
    filled_au: filledAu,
    prelevement_ok: ready,
  });
  return ready;
}

async function waitForModifierDateFinPopup(page, validityDays = 30, { attempts = 15, intervalMs = 1000 } = {}) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      if (await adjustBadgeEndDate(page, validityDays)) return true;
    } catch (err) {
      logWarn('Badge — popup date de fin', { error: err.message, attempt: i + 1 });
    }
    if (await fillBadgeContractDates(page, validityDays)) return true;
    await page.waitForTimeout(intervalMs);
  }
  return false;
}

async function dismissPostApplyDialogs(page) {
  await clickFirst(page, sel('sale_config_modal.ignorer_continuer'));
  await clickFirst(page, sel('sale_config_modal.saisir_rib')).catch(() => {});
  await randomDelay(400, 700);
}

async function finalizeBadgePayment(page) {
  let clotured = await clickVenteFooterAction(page, /Cl[ôo]turer(\s+la\s+note)?/i);
  if (!clotured) {
    clotured = await clickFirst(page, sel('payment_finalize.cloturer'));
  }
  if (!clotured) {
    throw new Error('Badge — « Clôturer la note » introuvable');
  }
  logInfo('Badge — note clôturée');
  await randomDelay(1000, 1500);

  let done = await clickTerminerVente(page);
  if (!done) {
    done = await clickVenteFooterAction(page, /\bTerminer\b/i, { preferClass: 'verticalDocumentBar' });
  }
  if (!done) {
    done = await clickFirst(page, sel('payment_finalize.terminer'));
  }
  if (!done) {
    throw new Error('Badge — bouton « Terminer » introuvable');
  }

  logInfo('Paiement finalisé Deciplus', { mode: 'prelevement_differe', badge_differe: true });
}

async function configureBadgeDeferredDates(page, validityDays = 30) {
  // Ne touche QUE la validité (1 mois) — la date de paiement est gérée à part (J+3)
  if (await waitForModifierDateFinPopup(page, validityDays)) return true;
  if (await fillBadgeContractDates(page, validityDays)) return true;

  if (await fillBadgeEndDateFields(page, validityDays) && (await applyContractDateChange(page))) {
    return true;
  }

  logWarn('Badge — panneau date introuvable sur vente', {
    url: page.url(),
    has_action: (await page.getByText(/Action souhaitée/i).count()) > 0,
    has_date_fin: (await page.getByText(/Date de fin/i).count()) > 0,
    has_virement: (await page.getByText(/Virement/i).count()) > 0,
  });
  return false;
}

async function fillBadgePaymentDate(page, dateStr) {
  const ctx = await resolveDeciplusWorkPage(page);
  const ok = await badgeDomEvaluate(ctx, 'fillPaymentDate', dateStr);
  if (ok) {
    logInfo('Badge — Date de paiement forcée', { date_paiement: dateStr });
  }
  return Boolean(ok);
}

async function applyBadgeConfigModal(page, productConfig, _memberId = null) {
  await randomDelay(1500, 2500);
  await ensureBadgeConfigModalForSale(page);

  if (!(await isBadgeConfigModalOpen(page))) {
    await captureBadgeDebugScreenshot(page, 'modal-missing');
    throw new Error('Badge — modale Configuration de Badge introuvable');
  }

  const delayDays = resolveBadgePrelevementDelayDays(productConfig);
  const validityDays = resolveBadgeValidityDays(productConfig);
  const timing = String(productConfig.badge_timing || 'deferred').toLowerCase();
  const immediate = timing === 'immediate' || productConfig.paiement_comptant === true;
  const { startStr, endStr } = badgeValidityDates(validityDays);
  // Paiement ~72h ≠ fin de validité (1 mois)
  const payStr = immediate ? startStr : badgePaymentDateParts(delayDays).str;

  if (immediate) {
    logInfo('Badge — paiement immédiat (Comptant)', {
      badge_timing: timing,
      badge_method: productConfig.badge_method || null,
    });
  } else {
    await ensurePaiementComptantOff(page, { strict: true });
    await randomDelay(400, 700);
    const ctx = await resolveDeciplusWorkPage(page);
    await badgeDomEvaluate(ctx, 'fillDu', startStr).catch(() => false);
    await badgeDomEvaluate(ctx, 'fillAu', endStr).catch(() => false);
    await fillBadgePaymentDate(page, payStr);
    await randomDelay(400, 700);
  }

  const clicked = await clickBadgeModalAppliquer(page);
  if (!clicked) {
    const fallback = await clickFirst(
      page,
      [
        'button.ari-button-filled:has-text("Appliquer")',
        'button.ari-button:has-text("Appliquer")',
        'button:has-text("Appliquer"):not(:has-text("Quitter"))',
        sel('sale_config_modal.appliquer'),
      ].join(', '),
      { force: true }
    );
    if (!fallback) {
      await captureBadgeDebugScreenshot(page, 'appliquer-missing');
      throw new Error('Badge — bouton Appliquer introuvable dans Configuration de Badge');
    }
  }

  await randomDelay(1000, 1500);

  let dateFinOk = false;
  let payDateOk = false;

  if (!immediate) {
    // Validité 1 mois si Deciplus ouvre le panneau Modifier — PAS J+3
    dateFinOk = await configureBadgeDeferredDates(page, validityDays).catch((err) => {
      logWarn('Badge — ajustement validité', { error: err.message });
      return false;
    });
    if (!dateFinOk) {
      dateFinOk = await handleBadgeModifierDateFinDialog(page);
    }

    // Forcer Date de paiement = J+3 (défaut Deciplus = souvent fin de mois / 5 du mois suivant)
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const text = (await readBadgeConfigModalText(page).catch(() => '')) || '';
      const venteText =
        text ||
        ((await page.locator('body').innerText().catch(() => '')) || '').slice(0, 4000);
      const payDate = extractBadgePaymentDate(venteText);
      const minPay = minBadgePaymentDate(delayDays);
      const maxPay = new Date();
      maxPay.setDate(maxPay.getDate() + delayDays + 2);
      maxPay.setHours(23, 59, 59, 999);
      const parsed = parseFrDate(payDate);
      const inWindow = parsed && parsed >= minPay && parsed <= maxPay;
      if (inWindow) {
        payDateOk = true;
        break;
      }
      if (!(await isBadgeConfigModalOpen(page))) {
        await reopenBadgeConfigModal(page).catch(() => false);
      }
      await fillBadgePaymentDate(page, payStr);
      await clickBadgeModalAppliquer(page).catch(() => false);
      await randomDelay(600, 1000);
    }
  } else {
    payDateOk = true;
  }

  await waitForBadgeModalClosed(page);
  await clickFirst(page, sel('sale_config_modal.saisir_rib')).catch(() => {});
  await randomDelay(800, 1200);

  const deferredOk = immediate
    ? true
    : await verifyBadgeDeferredSetup(page, delayDays).catch(() => false);

  logInfo(
    immediate
      ? 'Badge — Configuration appliquée (paiement immédiat)'
      : 'Badge — Configuration appliquée (validité 1 mois, prélèvement ~72h)',
    {
      delay_days: immediate ? 0 : delayDays,
      validity_days: validityDays,
      date_debut: startStr,
      date_fin: endStr,
      date_paiement: payStr,
      date_fin_ok: Boolean(dateFinOk),
      pay_date_ok: Boolean(payDateOk),
      deferred_ok: Boolean(deferredOk),
      badge_timing: timing,
      badge_method: productConfig.badge_method || null,
    }
  );

  if (!immediate && !payDateOk && !deferredOk) {
    logWarn('Badge — Date de paiement peut encore être au défaut Deciplus (ex. fin de mois)', {
      expected: payStr,
    });
  }
}

async function togglePaiementComptantOff(page) {
  return ensurePaiementComptantOff(page);
}

async function openSaleFlow(page, productConfig, gymConfig, saleKind) {
  await closeGreyboxIfOpen(page);
  await dismissJqueryUiOverlay(page).catch(() => {});

  // check.php est dans nextgen/legacy iframe (_vue_iframe) — boutons = input.fichemembre_button
  const checkCtx = await getMemberCheckContext(page, { waitMs: 20000 });
  const buttonKey = saleKind === 'carte' ? 'member_check.achat_carte' : 'member_check.achat_abonnement';
  const clicked = await clickFirst(checkCtx, sel(buttonKey), { force: true });
  if (!clicked) {
    // Repli : clic via evaluate dans l'iframe
    const fallbackValue = saleKind === 'carte' ? 'Achat Carte' : 'Achat Abonnement';
    const forced = await checkCtx
      .evaluate((value) => {
        const btn = document.querySelector(
          `input.fichemembre_button[value="${value}"], input[type="button"][value="${value}"]`
        );
        if (!btn || btn.disabled) return false;
        btn.click();
        return true;
      }, fallbackValue)
      .catch(() => false);
    if (!forced) {
      throw new Error(`Bouton vente Deciplus introuvable (${buttonKey}) — url=${page.url()}`);
    }
  }

  await page.waitForURL(/nextgen|vente|choose-zone/, { timeout: 20000 }).catch(() => {});
  await randomDelay(800, 1500);

  // Critical : sans sortir de choose-zone, le champ « Rechercher un produit » n'existe pas
  await ensureDeciplusSaleZone(page, gymConfig);

  if (await isChooseZoneScreen(page)) {
    throw new Error(
      `Catalogue vente bloqué sur choose-zone (salle=${gymConfig.deciplus_label || gymConfig.label || '?'}, url=${page.url()})`
    );
  }

  await page.waitForURL(/vente/, { timeout: 20000 }).catch(() => {});
  await randomDelay(1000, 2000);

  const catalogCtx = await resolveVenteCatalogContext(page, { timeoutMs: 25000 });
  if (!catalogCtx) {
    throw new Error(
      `Catalogue Deciplus (recherche produit) introuvable après ouverture vente — url=${page.url()}`
    );
  }

  await selectProductInCatalog(page, productConfig);
}

async function applyConfigModal(page, productConfig, memberId = null) {
  if (isBadgeSale(productConfig)) {
    return applyBadgeConfigModal(page, productConfig, memberId);
  }

  await page.locator('[role="dialog"]').first()
    .waitFor({ state: 'visible', timeout: 15000 })
    .catch(() => {});

  if (productConfig.paiement_comptant === false) {
    await ensurePaiementComptantOff(page);
  }

  if (productConfig.requires_iban && !productConfig.skip_rib_prompt) {
    await clickFirst(page, sel('sale_config_modal.saisir_rib')).catch(() => {});
  }

  await clickFirst(page, sel('sale_config_modal.appliquer'));
  await randomDelay(600, 1000);
  await clickFirst(page, sel('sale_config_modal.ignorer_continuer'));
}

async function finalizePayment(page, productConfig) {
  const mode = productConfig.payment_mode || 'virement';
  const badge = isBadgeSale(productConfig);

  if (badge) {
    await finalizeBadgePayment(page);
    return;
  }

  if (mode === 'virement') {
    await clickFirst(page, sel('payment_finalize.virement'));
  } else if (mode === 'card' || mode === 'cb') {
    await clickFirst(page, sel('payment_finalize.carte_bancaire'));
  }

  await clickFirst(page, sel('payment_finalize.cloturer'));
  await clickFirst(page, sel('payment_finalize.terminer'));
  logInfo('Paiement finalisé Deciplus', { mode, badge_differe: badge });
}

async function buyAbonnement(page, productConfig, gymConfig) {
  await openSaleFlow(page, productConfig, gymConfig, 'abonnement');
  await applyConfigModal(page, productConfig);
  await finalizePayment(page, productConfig);

  return { action: 'abonnement_created', sale_type: 'abonnement' };
}

async function buyCarteBadge(page, productConfig, gymConfig, memberId = null) {
  await openSaleFlow(page, productConfig, gymConfig, 'carte');
  await applyConfigModal(page, productConfig, memberId);
  await finalizePayment(page, productConfig);

  return { action: 'carte_badge_created', sale_type: 'carte' };
}

async function annotateMember(page, order, productConfig) {
  // Plus d'annotation technique (Source / Produit / Montant / Mode) sur la fiche
  void page;
  void order;
  void productConfig;
}

async function recordSale(page, order, productConfig, memberId, gymConfig = {}, options = {}) {
  if (productConfig.create_sale === false || productConfig.sale_type === 'none') {
    logInfo('Essai — fiche membre seulement', { order_id: order.order_id });
    if (memberId) await openMemberCheck(page, memberId);
    return { sale_id: null, action: 'skipped_essai' };
  }

  if (!memberId) {
    logWarn('Pas de member_id', { order_id: order.order_id });
    return { sale_id: null, action: 'no_member_id', manual_review: true };
  }

  await closeGreyboxIfOpen(page);
  await dismissJqueryUiOverlay(page).catch(() => {});
  await openMemberCheck(page, memberId);
  await dismissJqueryUiOverlay(page).catch(() => {});
  await annotateMember(page, order, productConfig).catch((err) => {
    logWarn('Annotation fiche membre ignorée', { error: err.message });
  });
  // Après Mettre à jour, revenir sur check.php (iframe) pour Achat Abonnement / Carte
  await closeGreyboxIfOpen(page);
  await openMemberCheck(page, memberId);
  await randomDelay(1000, 1800);

  let result;
  const { badgeProductConfig } = options;

  if (productConfig.sale_type === 'carte') {
    result = await buyCarteBadge(page, productConfig, gymConfig, memberId);
  } else if (productConfig.sale_type === 'abonnement') {
    result = await buyAbonnement(page, productConfig, gymConfig);

    if (badgeProductConfig) {
      logInfo('Création badge après abonnement', { member_id: memberId, order_id: order.order_id });
      await closeGreyboxIfOpen(page);
      await openMemberCheck(page, memberId);
      await randomDelay(800, 1200);
      try {
        const badgeResult = await buyCarteBadge(page, badgeProductConfig, gymConfig, memberId);
        result.badge_action = badgeResult.action;
      } catch (err) {
        logWarn('Badge non créé — prélèvement différé requis', {
          order_id: order.order_id,
          member_id: memberId,
          error: err.message,
        });
        result.badge_action = 'badge_failed';
        result.badge_error = err.message;
        result.manual_review = true;
      }
    }
  } else {
    return { sale_id: null, action: 'unknown_sale_type', manual_review: true };
  }

  logInfo('Vente Deciplus enregistrée', {
    order_id: order.order_id,
    offer: order.offer,
    sale_type: productConfig.sale_type,
    badge_action: result.badge_action || null,
  });

  return { sale_id: null, ...result, member_id: memberId };
}

async function cancelSaleOnMember(page, memberId) {
  return cancelSale(page, memberId);
}

module.exports = {
  recordSale,
  cancelSale: cancelSaleOnMember,
  buyAbonnement,
  buyCarteBadge,
};
