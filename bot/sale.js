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

function badgeEndDate(delayDays = 7) {
  const endDate = new Date();
  endDate.setDate(endDate.getDate() + delayDays);
  return { endDate, endStr: formatFrDate(endDate), iso: endDate.toISOString().slice(0, 10) };
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
  const { endStr, iso } = badgeEndDate(delayDays);
  const scopes = [];
  const dialog = page.locator('[role="dialog"]').first();
  if ((await dialog.count()) > 0 && (await dialog.isVisible().catch(() => false))) {
    scopes.push(dialog);
  }
  scopes.push(page);

  for (const scope of scopes) {
    let filled = await fillFirst(
      scope,
      'input[name="date_fin"], input[name="dfin"], input[name="datefin"], input[name="dateFin"], input[name="date_fin_carte"]',
      endStr
    );

    if (!filled) {
      const byLabel = scope.locator('text=/Date de fin/i').locator('xpath=following::input[1]').first();
      if ((await byLabel.count()) > 0 && (await byLabel.isVisible().catch(() => false))) {
        await byLabel.fill(endStr);
        filled = true;
      }
    }

    if (!filled) {
      const dateInputs = scope.locator('input[type="date"], input[name*="date"], input[placeholder*="jj/mm"]');
      const count = await dateInputs.count();
      if (count >= 2) {
        const endInput = dateInputs.nth(count - 1);
        if (await endInput.isVisible().catch(() => false)) {
          await endInput.fill(iso).catch(async () => {
            await endInput.fill(endStr);
          });
          filled = true;
        }
      } else if (count === 1) {
        const only = dateInputs.first();
        if (await only.isVisible().catch(() => false)) {
          await only.fill(iso).catch(async () => {
            await only.fill(endStr);
          });
          filled = true;
        }
      }
    }

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

async function dismissPostApplyDialogs(page) {
  await clickFirst(page, sel('sale_config_modal.ignorer_continuer'));
  await clickFirst(page, sel('sale_config_modal.saisir_rib')).catch(() => {});
  await randomDelay(400, 700);
}

async function applyBadgeConfigModal(page, productConfig) {
  await page.locator('[role="dialog"]').first()
    .waitFor({ state: 'visible', timeout: 15000 })
    .catch(() => {});

  await ensurePaiementComptantOff(page, { strict: true });
  const comptantConfirmedOff = (await isPaiementComptantChecked(page)) === false;

  const delayDays = Number(
    productConfig.prelevement_delay_days ||
      process.env.BADGE_PRELEVEMENT_DELAY_DAYS ||
      7
  );

  let adjusted = await adjustBadgeEndDate(page, delayDays);
  if (!adjusted) {
    adjusted = await fillBadgeEndDateFields(page, delayDays);
  }

  await clickFirst(page, sel('sale_config_modal.appliquer'));
  await randomDelay(1000, 1500);
  await dismissPostApplyDialogs(page);

  if (!adjusted) {
    adjusted = await adjustBadgeEndDateWithRetry(page, delayDays, { attempts: 8, intervalMs: 800 });
  }

  if (!adjusted) {
    if (comptantConfirmedOff) {
      logInfo('Badge — pas de popup « Modifier la date de fin » (Paiement Comptant off, prélèvement différé attendu)', {
        delay_days: delayDays,
      });
      return;
    }
    throw new Error(
      'Badge — prélèvement différé impossible (Paiement Comptant actif et date de fin non modifiable)'
    );
  }
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

async function applyConfigModal(page, productConfig) {
  if (isBadgeSale(productConfig)) {
    return applyBadgeConfigModal(page, productConfig);
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
    const delayDays = Number(
      productConfig.prelevement_delay_days ||
        process.env.BADGE_PRELEVEMENT_DELAY_DAYS ||
        7
    );
    await adjustBadgeEndDateWithRetry(page, delayDays, { attempts: 3, intervalMs: 600 }).catch(() => {});
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

async function buyCarteBadge(page, productConfig, gymConfig) {
  await openSaleFlow(page, productConfig, gymConfig, 'carte');
  await applyConfigModal(page, productConfig);
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
    result = await buyCarteBadge(page, productConfig, gymConfig);
  } else if (productConfig.sale_type === 'abonnement') {
    result = await buyAbonnement(page, productConfig, gymConfig);

    if (badgeProductConfig) {
      logInfo('Création badge après abonnement', { member_id: memberId, order_id: order.order_id });
      await closeGreyboxIfOpen(page);
      await openMemberCheck(page, memberId);
      await randomDelay(800, 1200);
      try {
        const badgeResult = await buyCarteBadge(page, badgeProductConfig, gymConfig);
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
