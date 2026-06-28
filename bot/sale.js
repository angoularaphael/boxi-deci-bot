/**
 * Ventes Deciplus — toutes offres (DUO, Saison, Badge, Essai)
 * Sans module Caisse → via check.php + nextgen/vente
 */
const { randomDelay } = require('../lib/utils');
const { logInfo, logWarn } = require('../lib/logger');
const { buildInternalNote } = require('../lib/normalize');
const { openMemberCheck, clickFirst, fillFirst, sel, closeGreyboxIfOpen } = require('./wallet');
const { ensureDeciplusSaleZone } = require('./deciplus-zone');
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
  const dialog = page.locator('[role="dialog"]').first();
  const scopes = [];
  if ((await dialog.count()) > 0) scopes.push(dialog);
  scopes.push(page);

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

async function selectProductInCatalog(page, productConfig) {
  const name = productConfig.deciplus_product_name || productConfig.label;
  const searchCandidates = buildSearchCandidates(productConfig);

  const searchInput = page
    .locator(
      'input[placeholder*="Rechercher un produit"], input[placeholder*="Rechercher"], input[placeholder*="prestation"]'
    )
    .first();
  await searchInput.waitFor({ state: 'visible', timeout: 20000 });

  await openProductCategory(page, productConfig);

  for (const search of searchCandidates) {
    await searchInput.fill('');
    await randomDelay(250, 450);
    await searchInput.fill(search);
    await searchInput.press('Enter').catch(() => {});
    await randomDelay(1500, 2500);

    if (await clickProductResult(page, productConfig)) {
      await randomDelay();
      logInfo('Produit Deciplus trouvé dans le catalogue UI', { search, name });
      return true;
    }

    logWarn('Recherche produit Deciplus sans résultat', {
      search,
      name,
      visible: await listVisibleProducts(page),
    });
  }

  throw new Error(`Produit Deciplus introuvable: "${name}"`);
}

async function ensurePaiementComptantOff(page, { strict = false } = {}) {
  await page.getByText('Paiement Comptant', { exact: false }).first()
    .waitFor({ state: 'attached', timeout: 12000 })
    .catch(() => {});

  for (let pass = 0; pass < 4; pass += 1) {
    const cb = await findPaiementComptantCheckbox(page);
    if (!cb) break;

    const checked = await cb.isChecked().catch(() => null);
    if (checked === false) {
      logInfo('Paiement Comptant — désactivé');
      return true;
    }
    if (checked === true) {
      try {
        await uncheckPaiementComptantInput(cb);
      } catch (err) {
        logWarn('Paiement Comptant — uncheck JS échoué', { error: err.message });
        await cb.uncheck({ force: true, timeout: 5000 }).catch(() => {});
      }
      const label = page.locator('[role="dialog"]').getByText(/Paiement Comptant/i).first();
      if ((await label.count()) > 0) {
        await label.click({ force: true, timeout: 3000 }).catch(() => {});
      }
      await randomDelay(400, 700);
    }
  }

  const stillChecked = await isPaiementComptantChecked(page);
  if (stillChecked === false) {
    logInfo('Paiement Comptant — désactivé');
    return true;
  }
  if (stillChecked === true) {
    const msg = 'Paiement Comptant toujours activé';
    if (strict) throw new Error(msg);
    logWarn(msg);
    return false;
  }

  logWarn('Paiement Comptant — état indéterminé');
  if (strict) throw new Error('Paiement Comptant — toggle introuvable');
  return false;
}

function resolveBadgePrelevementDelayDays(productConfig = {}) {
  const min = Number(
    productConfig.prelevement_delay_days_min ||
      process.env.BADGE_PRELEVEMENT_DELAY_MIN ||
      5
  );
  const max = Number(
    productConfig.prelevement_delay_days_max ||
      process.env.BADGE_PRELEVEMENT_DELAY_MAX ||
      7
  );
  const raw = Number(
    productConfig.prelevement_delay_days ||
      process.env.BADGE_PRELEVEMENT_DELAY_DAYS ||
      max
  );
  const delay = Number.isFinite(raw) ? raw : max;
  return Math.min(max, Math.max(min, delay));
}

function badgeContractDates(delayDays = 7) {
  const startDate = new Date();
  const endDate = new Date(startDate);
  endDate.setDate(endDate.getDate() + delayDays);
  return {
    startDate,
    endDate,
    startStr: formatFrDate(startDate),
    endStr: formatFrDate(endDate),
    isoEnd: endDate.toISOString().slice(0, 10),
  };
}

function badgeEndDate(delayDays = 7) {
  const { endDate, endStr, isoEnd: iso } = badgeContractDates(delayDays);
  return { endDate, endStr, iso };
}

async function getBadgeEditorScopes(page) {
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
  out.push(page);
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

async function fillBadgeContractDates(page, delayDays = 7) {
  const { startStr, endStr } = badgeContractDates(delayDays);
  await focusBadgeContractInSale(page);

  for (const scope of await getBadgeEditorScopes(page)) {
    await ensureContractModifyAction(scope);
    await uncheckKeepDuration(scope);

    await fillDateFieldByLabel(scope, /Date de début/i, startStr);
    const finFilled = await fillDateFieldByLabel(scope, /Date de fin/i, endStr);
    if (!finFilled) continue;

    if (await applyContractDateChange(scope)) {
      logInfo('Badge — prélèvement IBAN différé (contrat J → J+delai)', {
        date_debut: startStr,
        date_fin: endStr,
        delay_days: delayDays,
        window: '5-7 jours',
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

async function fillBadgeEndDateFields(page, delayDays = 7) {
  const { endStr } = badgeEndDate(delayDays);

  for (const scope of await getBadgeEditorScopes(page)) {
    await uncheckKeepDuration(scope);
    const filled = await fillDateFieldByLabel(scope, /Date de fin/i, endStr);
    if (filled) {
      logInfo('Badge — date de fin saisie', { date_fin: endStr, delay_days: delayDays });
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

async function adjustBadgeEndDate(page, delayDays = 7) {
  const modControl = await findModifierDateFinControl(page);
  if (!modControl) return false;

  await modControl.click();
  await randomDelay(800, 1200);

  const { endStr } = badgeEndDate(delayDays);
  await fillBadgeEndDateFields(page, delayDays);

  const applied = await confirmBadgeDateModal(page);
  if (!applied) {
    throw new Error('Badge — validation date de fin impossible (Appliquer introuvable)');
  }

  logInfo('Badge — date de fin repoussée pour prélèvement différé', {
    date_fin: endStr,
    delay_days: delayDays,
  });
  await randomDelay(600, 1000);
  return true;
}

async function adjustBadgeEndDateWithRetry(page, delayDays = 7, { attempts = 12, intervalMs = 1000 } = {}) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      if (await adjustBadgeEndDate(page, delayDays)) return true;
    } catch (err) {
      logWarn('Badge — ajustement date de fin interrompu', { error: err.message, attempt: i + 1 });
    }
    if (await fillBadgeEndDateFields(page, delayDays)) return true;
    await page.waitForTimeout(intervalMs);
  }
  return false;
}

async function fillBadgeAuDateViaDom(scope, endStr) {
  if (typeof scope.evaluate !== 'function') return false;
  return scope.evaluate((val) => {
    const isVisible = (el) => el && el.offsetParent !== null;
    const setInput = (input) => {
      if (!input || !isVisible(input)) return false;
      input.focus();
      input.value = val;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.dispatchEvent(new Event('blur', { bubbles: true }));
      return true;
    };

    const modalRoot =
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
    }
    return false;
  }, endStr);
}

async function fillBadgeAuDate(scope, endStr) {
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
    if (current.includes(endStr.slice(0, 5)) || current === endStr) return true;
  }

  return fillBadgeAuDateViaDom(scope, endStr);
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

async function readBadgeConfigModalText(page) {
  for (const scope of await getBadgeEditorScopes(page)) {
    if (typeof scope.innerText !== 'function') continue;
    const text = (await scope.innerText().catch(() => '')).replace(/\s+/g, ' ');
    if (/Configuration de Badge|Valide du|Prélèvement Automatique/i.test(text)) return text;
  }
  return (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
}

async function verifyBadgeConfigModalReady(page, delayDays = 7) {
  const { endStr } = badgeContractDates(delayDays);
  const text = await readBadgeConfigModalText(page);

  if (/en dehors de la dur[ée]e de validit[ée]/i.test(text)) return false;

  if (/Prélèvement Automatique/i.test(text) && /Date de paiement/i.test(text)) {
    return true;
  }

  if (text.includes(endStr)) return true;

  return false;
}

async function verifyBadgeDeferredSetup(page, delayDays = 7) {
  if (await verifyBadgeConfigModalReady(page, delayDays)) return true;

  const { endStr } = badgeContractDates(delayDays);
  const text = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');

  if (text.includes(endStr)) return true;

  if (/Prélèvement Automatique/i.test(text) && /Date de paiement/i.test(text)) {
    return !/en dehors de la dur[ée]e de validit[ée]/i.test(text);
  }

  if (/Restant d[uû].*34[,.]99/i.test(text) && !/Total encaiss[ée].*34[,.]99/i.test(text)) {
    return true;
  }

  return false;
}

async function fillBadgeDatesInConfigModal(page, delayDays = 7) {
  await page.getByText(/Configuration de Badge/i).first()
    .waitFor({ state: 'visible', timeout: 15000 })
    .catch(() => {});

  const { startStr, endStr } = badgeContractDates(delayDays);
  let filledAu = await fillBadgeAuDate(page, endStr);

  for (const scope of await getBadgeEditorScopes(page)) {
    await uncheckKeepDuration(scope);
    await fillBadgeValideDuDate(scope, startStr);
    if (!filledAu && (await fillBadgeAuDate(scope, endStr))) {
      filledAu = true;
    }
  }

  if (!filledAu) {
    filledAu = await fillBadgeAuDateViaDom(page, endStr);
  }

  await randomDelay(1200, 1800);

  let ready = await verifyBadgeConfigModalReady(page, delayDays);
  if (!ready && filledAu) {
    await randomDelay(1000, 1500);
    ready = await verifyBadgeConfigModalReady(page, delayDays);
  }

  logInfo('Badge — validité modale Configuration', {
    valide_du: startStr,
    valide_au: endStr,
    delay_days: delayDays,
    filled_au: filledAu,
    prelevement_ok: ready,
  });
  return ready;
}

async function waitForModifierDateFinPopup(page, delayDays = 7, { attempts = 15, intervalMs = 1000 } = {}) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      if (await adjustBadgeEndDate(page, delayDays)) return true;
    } catch (err) {
      logWarn('Badge — popup date de fin', { error: err.message, attempt: i + 1 });
    }
    if (await fillBadgeContractDates(page, delayDays)) return true;
    await page.waitForTimeout(intervalMs);
  }
  return false;
}

async function dismissPostApplyDialogs(page) {
  await clickFirst(page, sel('sale_config_modal.ignorer_continuer'));
  await clickFirst(page, sel('sale_config_modal.saisir_rib')).catch(() => {});
  await randomDelay(400, 700);
}

async function configureBadgeDeferredDates(page, delayDays) {
  if (await waitForModifierDateFinPopup(page, delayDays)) return true;
  if (await fillBadgeContractDates(page, delayDays)) return true;

  if (await fillBadgeEndDateFields(page, delayDays) && (await applyContractDateChange(page))) {
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

async function applyBadgeConfigModal(page, productConfig, _memberId = null) {
  await page.getByText(/Configuration de Badge/i).first()
    .waitFor({ state: 'visible', timeout: 15000 })
    .catch(() => {
      return page.locator('[role="dialog"]').first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
    });

  await ensurePaiementComptantOff(page, { strict: true });

  const delayDays = resolveBadgePrelevementDelayDays(productConfig);
  const { endStr } = badgeContractDates(delayDays);

  const modalReady = await fillBadgeDatesInConfigModal(page, delayDays);

  if (!modalReady) {
    logWarn('Badge — modale Configuration : validité « au » non confirmée, nouvelle tentative', {
      date_fin: endStr,
    });
    await fillBadgeDatesInConfigModal(page, delayDays);
  }

  if (!(await verifyBadgeConfigModalReady(page, delayDays))) {
    throw new Error(
      `Badge — champ « au » J+${delayDays} requis dans Configuration de Badge (échéance prélèvement hors validité)`
    );
  }

  await clickFirst(page, sel('sale_config_modal.appliquer'));
  await randomDelay(1500, 2500);
  await dismissPostApplyDialogs(page);
  await randomDelay(1000, 1500);

  if (await verifyBadgeDeferredSetup(page, delayDays)) {
    logInfo('Badge — prélèvement IBAN différé (Configuration de Badge)', {
      date_fin: endStr,
      delay_days: delayDays,
      window: '5-7 jours',
    });
    return;
  }

  const configured = await configureBadgeDeferredDates(page, delayDays);
  if (configured) return;

  throw new Error(
    `Badge — contrat J+${delayDays} requis (prélèvement IBAN 5-7 jours, pas encaissement immédiat 34,99 €)`
  );
}

async function togglePaiementComptantOff(page) {
  return ensurePaiementComptantOff(page);
}

async function openSaleFlow(page, productConfig, gymConfig, saleKind) {
  const buttonKey = saleKind === 'carte' ? 'member_check.achat_carte' : 'member_check.achat_abonnement';
  await clickFirst(page, sel(buttonKey));
  await page.waitForURL(/nextgen|vente|choose-zone/, { timeout: 20000 }).catch(() => {});
  await randomDelay(800, 1500);
  await ensureDeciplusSaleZone(page, gymConfig);
  await page.waitForURL(/vente/, { timeout: 20000 }).catch(() => {});
  await randomDelay(1000, 2000);
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
  const note = [
    buildInternalNote(order),
    `Offre: ${productConfig.label}`,
    `Montant PrestaShop: ${order.payment.amount} €`,
    `Mode: ${order.payment.method}`,
  ].join(' | ');

  await fillFirst(page, 'textarea[name="info_compta"]', note);
  await clickFirst(page, sel('member_detail.update_button'));
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
  await openMemberCheck(page, memberId);
  await annotateMember(page, order, productConfig);

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

async function cancelSale(page, memberId) {
  if (!memberId) throw new Error('member_id requis pour annuler la vente');

  await openMemberCheck(page, memberId);
  await randomDelay();

  const consulter = page.locator(sel('member_check.consulter_abo')).first();
  if ((await consulter.count()) === 0) {
    throw new Error('Bouton Consulter introuvable — aucune vente active ?');
  }
  await consulter.click();
  await randomDelay();

  await clickFirst(page, sel('contract_actions.annuler_vente'));
  await randomDelay();
  await clickFirst(page, sel('contract_actions.appliquer_quitter'));

  logInfo('Vente annulée Deciplus', { member_id: memberId });
  return { action: 'sale_cancelled', sale_type: 'cancel' };
}

module.exports = {
  recordSale,
  cancelSale,
  buyAbonnement,
  buyCarteBadge,
};
