const { randomDelay, loadJson } = require('../lib/utils');
const { logInfo, logWarn } = require('../lib/logger');
const { normalizeIban, isValidFrenchIban } = require('../lib/iban');

function sel(key) {
  try {
    const cfg = loadJson('config/deciplus-selectors.json');
    const val = key.split('.').reduce((o, k) => o?.[k], cfg);
    return val || key;
  } catch {
    return key;
  }
}

function parseGymAddress(raw) {
  const text = String(raw || '').trim();
  const m = text.match(/^(.+?),\s*(\d{5})\s+(.+)$/);
  if (m) return { address: m[1].trim(), postal_code: m[2], city: m[3].trim(), country: 'France' };
  return { address: text, postal_code: '31200', city: 'Toulouse', country: 'France' };
}

function ribAddressFields(customer = {}, gymConfig = {}) {
  const postalDigits = String(customer.postal_code || '').replace(/\D/g, '');
  const validFrPostal = postalDigits.length === 5;

  if (validFrPostal && customer.address && customer.city) {
    return {
      address: customer.address,
      postal_code: postalDigits,
      city: customer.city,
      country: 'France',
    };
  }

  if (gymConfig?.address) {
    logWarn('Adresse client invalide pour RIB — repli adresse salle', {
      gym: gymConfig.label || gymConfig.deciplus_label,
    });
    return parseGymAddress(gymConfig.address);
  }

  return {
    address: customer.address || '12 rue de Fenouillet',
    postal_code: validFrPostal ? postalDigits : '31200',
    city: customer.city || 'Toulouse',
    country: 'France',
  };
}

async function clickFirst(ctx, selectors, opts = {}) {
  const list = String(selectors).split(',').map((s) => s.trim());
  for (const s of list) {
    const el = ctx.locator(s).first();
    if ((await el.count()) > 0 && (await el.isVisible().catch(() => false))) {
      await el.click({ ...opts, timeout: 15000 });
      await randomDelay();
      return true;
    }
  }
  return false;
}

async function fillFirst(ctx, selectors, value) {
  if (value == null || value === '' || !selectors) return false;
  const list = String(selectors).split(',').map((s) => s.trim());
  for (const s of list) {
    const el = ctx.locator(s).first();
    if ((await el.count()) > 0 && (await el.isVisible().catch(() => false))) {
      await el.fill(String(value));
      await randomDelay(200, 500);
      return true;
    }
  }
  return false;
}

async function readIbanFromRib(ctx) {
  const el = ctx.locator('input[name="iban"]').first();
  if ((await el.count()) === 0) return '';
  return normalizeIban(await el.inputValue().catch(() => ''));
}

async function hasPostalAddressBlocker(ctx) {
  const msg = ctx.locator('text=/adresse postale est obligatoire pour éditer le mandat/i').first();
  return (await msg.count()) > 0 && (await msg.isVisible().catch(() => false));
}

async function openMemberDetail(page, memberId) {
  const base = process.env.DECIPLUS_URL || 'https://boxingcenter.deciplus.pro/';
  await page.goto(new URL(`joueurs.php?idj=${memberId}`, base).href, {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });
  await randomDelay();
}

async function openMemberCheck(page, memberId) {
  const base = process.env.DECIPLUS_URL || 'https://boxingcenter.deciplus.pro/';
  await page.goto(new URL(`check.php?idj=${memberId}`, base).href, {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });
  await randomDelay();
}

async function ensureMemberPostalAddress(page, memberId, addr) {
  logInfo('Mise à jour adresse membre Deciplus', { member_id: memberId });
  await openMemberDetail(page, memberId);
  await fillFirst(page, 'input[name="adr1"]', addr.address);
  await fillFirst(page, 'input[name="codepostal"]', addr.postal_code);
  await fillFirst(page, 'input[name="ville"]', addr.city);
  await fillFirst(page, 'input[name="pays"]', addr.country);

  await page.evaluate(() => {
    const submit = document.querySelector('input[name="alde_submit"]');
    if (submit) submit.value = 'valider';
  });
  await clickFirst(
    page,
    'input[type="submit"][value="Valider"], input.albut[value="Valider"], input[type="submit"].albut'
  );
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await randomDelay();
}

async function getRibFrame(page) {
  const iframe = page.locator('#GB_frame, iframe[src*="rib.php"]').first();
  if ((await iframe.count()) > 0) {
    const handle = await iframe.elementHandle();
    const frame = handle ? await handle.contentFrame() : null;
    if (frame) return frame;
  }
  for (const frame of page.frames()) {
    if (frame.url().includes('rib.php')) return frame;
  }
  return null;
}

async function waitForRibFrame(page, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frame = await getRibFrame(page);
    if (frame) return frame;
    await page.waitForTimeout(400);
  }
  return null;
}

async function openRibForm(page, memberId) {
  const base = process.env.DECIPLUS_URL || 'https://boxingcenter.deciplus.pro/';

  let frame = await getRibFrame(page);
  if (frame) {
    logInfo('Formulaire RIB déjà ouvert (modale)', { member_id: memberId });
    return frame;
  }

  await page.goto(new URL(`rib.php?idj=${memberId}`, base).href, {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });
  await randomDelay();

  if (page.url().includes('rib.php')) return page;

  frame = await waitForRibFrame(page, 5000);
  if (frame) return frame;

  await openMemberCheck(page, memberId);
  if (await clickFirst(page, sel('member_check.saisir_mandat_sepa'))) {
    frame = await waitForRibFrame(page, 10000);
    if (frame) return frame;
  }

  await openMemberDetail(page, memberId);
  if (await clickFirst(page, sel('member_detail.saisir_rib_button'))) {
    frame = await waitForRibFrame(page, 10000);
    if (frame) return frame;
  }

  throw new Error(`Impossible d'ouvrir le formulaire RIB pour membre ${memberId}`);
}

async function fillRibForm(ctx, iban, customer, gymConfig) {
  const value = normalizeIban(iban);
  const addr = ribAddressFields(customer, gymConfig);

  await fillFirst(ctx, sel('rib_form.iban'), value);

  const titulaire = [customer.first_name, customer.last_name].filter(Boolean).join(' ').trim();
  if (titulaire) {
    await fillFirst(ctx, sel('rib_form.account_holder'), titulaire.toUpperCase());
  }

  await fillFirst(ctx, sel('rib_form.address'), addr.address);
  await fillFirst(ctx, sel('rib_form.address2'), '');
  await fillFirst(ctx, sel('rib_form.city'), addr.city.toUpperCase());
  await fillFirst(ctx, sel('rib_form.zip'), addr.postal_code);
  await fillFirst(ctx, sel('rib_form.country'), addr.country);
}

async function prepareRibSubmit(ctx) {
  await ctx.evaluate(() => {
    const form = document.querySelector('form');
    if (!form) return;
    const submit = form.querySelector('input[name="alde_submit"]');
    if (submit) submit.value = 'valider';
    const cb = form.querySelector('input[type="checkbox"]');
    if (cb) cb.checked = true;
  });
}

async function submitRibForm(ctx, page) {
  await prepareRibSubmit(ctx);
  const clicked = await clickFirst(ctx, sel('rib_form.save'));
  if (!clicked) {
    await ctx.evaluate(() => {
      const form = document.querySelector('form');
      if (form) form.submit();
    });
  }

  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await randomDelay(800, 1500);
}

async function verifyIbanOnMandate(page, memberId, expectedIban) {
  const ribCtx = await openRibForm(page, memberId);
  const saved = await readIbanFromRib(ribCtx);
  return saved === expectedIban;
}

async function closeGreyboxIfOpen(page) {
  const closeBtn = page.locator('#GB_window img, #GB_window a.close, #GB_window .close').first();
  if ((await closeBtn.count()) > 0 && (await closeBtn.isVisible().catch(() => false))) {
    await closeBtn.click().catch(() => {});
    await randomDelay();
  }
}

/**
 * Flux : adresse membre → rib.php → IBAN + adresse mandat → Valider
 */
async function setMemberIban(page, memberId, iban, customer = {}, gymConfig = {}) {
  const value = normalizeIban(iban);
  if (!isValidFrenchIban(value)) {
    throw new Error('IBAN français invalide');
  }

  logInfo('Saisie RIB Deciplus', { member_id: memberId });
  const addr = ribAddressFields(customer, gymConfig);

  await ensureMemberPostalAddress(page, memberId, addr);

  const ribCtx = await openRibForm(page, memberId);
  const existingIban = await readIbanFromRib(ribCtx);
  if (existingIban === value) {
    logInfo('IBAN déjà enregistré sur le mandat Deciplus', { member_id: memberId });
    await closeGreyboxIfOpen(page);
    return true;
  }

  const ribCtxFinal = (await getRibFrame(page)) || page;
  await fillRibForm(ribCtxFinal, value, customer, gymConfig);

  if (await hasPostalAddressBlocker(ribCtxFinal)) {
    logWarn('Avertissement adresse postale Deciplus — soumission du mandat quand même', {
      member_id: memberId,
    });
  }

  await submitRibForm(ribCtxFinal, page);
  await closeGreyboxIfOpen(page);

  const saved = await verifyIbanOnMandate(page, memberId, value);
  if (!saved) {
    throw new Error('RIB Deciplus: échec enregistrement IBAN sur le mandat');
  }

  await closeGreyboxIfOpen(page);
  logInfo('RIB saisi sur fiche membre', { member_id: memberId });
  return true;
}

module.exports = {
  openMemberDetail,
  openMemberCheck,
  setMemberIban,
  openRibForm,
  getRibFrame,
  ribAddressFields,
  clickFirst,
  fillFirst,
  sel,
  closeGreyboxIfOpen,
};
