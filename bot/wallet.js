const { randomDelay, loadJson } = require('../lib/utils');
const { logInfo, logWarn } = require('../lib/logger');
const { normalizeIban, isValidFrenchIban } = require('../lib/iban');
const { dismissJqueryUiOverlay } = require('./ui');
const { getAccessToken } = require('./auth');

const DECIPLUS_API = 'https://api.deciplus.pro/staff/v1';

function apiHeaders(token) {
  return {
    'x-access-token': token,
    'Deciplus-Client-Type': 'manager',
    'Content-Type': 'application/json',
  };
}

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

async function getMemberFormContext(page) {
  if ((await page.locator('form[name="db1_form"]').count()) > 0) return page;
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    if ((await frame.locator('form[name="db1_form"]').count()) > 0) return frame;
  }
  if ((await page.locator('input[name="nom"], input[name="prenom"], input[name="adr1"]').count()) > 0) {
    return page;
  }
  return page;
}

async function fillFormField(ctx, selectors, value) {
  if (value == null || value === '' || !selectors) return false;
  const list = String(selectors).split(',').map((s) => s.trim());
  for (const s of list) {
    const el = ctx.locator(s).first();
    if ((await el.count()) === 0) continue;
    const tag = await el.evaluate((node) => node.tagName.toLowerCase()).catch(() => 'input');
    if (tag === 'select') {
      await el.selectOption({ label: String(value) }).catch(async () => {
        await el.selectOption({ value: String(value) }).catch(() => {});
      });
    } else {
      await el.fill(String(value), { force: true }).catch(async () => {
        await el.evaluate((node, v) => {
          node.value = v;
          node.dispatchEvent(new Event('input', { bubbles: true }));
          node.dispatchEvent(new Event('change', { bubbles: true }));
        }, String(value));
      });
    }
    await randomDelay(150, 350);
    return true;
  }
  return false;
}

async function readMemberAddressFromUi(page) {
  const ctx = await getMemberFormContext(page);
  return ctx.evaluate(() => {
    const val = (name) => document.querySelector(`input[name="${name}"], select[name="${name}"]`)?.value || '';
    return {
      address: val('adr1'),
      postal_code: val('codepostal'),
      city: val('ville'),
      country: val('pays'),
    };
  }).catch(() => ({ address: '', postal_code: '', city: '', country: '' }));
}

async function updateMemberAddressViaApi(page, memberId, addr) {
  const token = await getAccessToken(page);
  if (!token) {
    logWarn('Token Deciplus absent — skip API adresse', { member_id: memberId });
    return false;
  }

  const payload = {
    adr1: addr.address,
    postalCode: addr.postal_code,
    city: addr.city,
    country: addr.country || 'France',
  };

  for (const method of ['PUT', 'PATCH', 'POST']) {
    try {
      const res = await page.request.fetch(`${DECIPLUS_API}/member/${memberId}`, {
        method,
        headers: apiHeaders(token),
        data: payload,
      });
      if (res.ok()) {
        logInfo('Adresse membre Deciplus via API', { member_id: memberId, method, status: res.status() });
        break;
      }
      logWarn('API adresse membre refusée', { member_id: memberId, method, status: res.status() });
    } catch (err) {
      logWarn('API adresse membre erreur', { member_id: memberId, method, error: err.message });
    }
  }

  try {
    const get = await page.request.get(`${DECIPLUS_API}/member/${memberId}`, {
      headers: apiHeaders(token),
    });
    if (!get.ok()) return false;
    const body = await get.json();
    const member = body.response || body;
    const savedPostal = String(member.postalCode || member.postal_code || '').replace(/\D/g, '');
    const expectedPostal = String(addr.postal_code || '').replace(/\D/g, '');
    const ok =
      savedPostal === expectedPostal &&
      Boolean(member.adr1 || member.address) &&
      Boolean(member.city);
    if (ok) {
      logInfo('Adresse membre Deciplus confirmée (API)', {
        member_id: memberId,
        postal_code: savedPostal,
      });
    }
    return ok;
  } catch (err) {
    logWarn('Lecture adresse API échouée', { member_id: memberId, error: err.message });
    return false;
  }
}

async function ensureMemberPostalAddress(page, memberId, addr) {
  logInfo('Mise à jour adresse membre Deciplus', { member_id: memberId });
  await closeGreyboxIfOpen(page);

  // 1) API Deciplus — plus fiable que le formulaire HTML pour le mandat SEPA
  if (await updateMemberAddressViaApi(page, memberId, addr)) {
    return true;
  }

  // 2) Fallback UI joueurs.php
  await openMemberDetail(page, memberId);
  await dismissJqueryUiOverlay(page).catch(() => {});
  await page.waitForTimeout(800);

  const ctx = await getMemberFormContext(page);
  const filled = {
    address: await fillFormField(ctx, 'input[name="adr1"]', addr.address),
    postal: await fillFormField(ctx, 'input[name="codepostal"]', addr.postal_code),
    city: await fillFormField(ctx, 'input[name="ville"]', addr.city),
    country: await fillFormField(ctx, 'input[name="pays"], select[name="pays"]', addr.country),
  };
  logInfo('Champs adresse UI remplis', { member_id: memberId, filled });

  await ctx.evaluate(() => {
    const form = document.querySelector('form[name="db1_form"]');
    if (!form) return;
    const submit = form.querySelector('input[name="alde_submit"]');
    if (submit) submit.value = 'valider';
    const demandeMaj = form.querySelector('input[name="demande_maj"]');
    if (demandeMaj) demandeMaj.value = '1';
  }).catch(() => {});

  const updated = await clickFirst(
    ctx,
    [
      'input[type="submit"][value="Mettre à jour"]',
      'input.albut_dw[value="Mettre à jour"]',
      'input[type="submit"][value="Valider"]',
      'input.albut[value="Valider"]',
    ].join(', '),
    { force: true }
  );
  if (!updated) {
    await ctx.evaluate(() => document.querySelector('form[name="db1_form"]')?.submit()).catch(() => {});
  }

  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await randomDelay(600, 1200);
  await dismissJqueryUiOverlay(page).catch(() => {});

  // Re-vérifie via API puis UI
  if (await updateMemberAddressViaApi(page, memberId, addr)) {
    return true;
  }

  await openMemberDetail(page, memberId);
  await page.waitForTimeout(800);
  const saved = await readMemberAddressFromUi(page);
  const ok =
    String(saved.postal_code || '').replace(/\D/g, '') === String(addr.postal_code || '').replace(/\D/g, '') &&
    Boolean(saved.address) &&
    Boolean(saved.city);

  if (!ok) {
    logWarn('Adresse membre Deciplus non confirmée après sauvegarde', {
      member_id: memberId,
      saved,
      expected: addr,
    });
  } else {
    logInfo('Adresse membre Deciplus confirmée (UI)', {
      member_id: memberId,
      postal_code: saved.postal_code,
    });
  }
  return ok;
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

async function openRibForm(page, memberId, { forceFresh = false } = {}) {
  const base = process.env.DECIPLUS_URL || 'https://boxingcenter.deciplus.pro/';

  if (forceFresh) {
    await closeGreyboxIfOpen(page);
  } else {
    let frame = await getRibFrame(page);
    if (frame) {
      logInfo('Formulaire RIB déjà ouvert (modale)', { member_id: memberId });
      return frame;
    }
  }

  await page.goto(new URL(`rib.php?idj=${memberId}`, base).href, {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });
  await randomDelay();

  if (page.url().includes('rib.php')) return page;

  let frame = await waitForRibFrame(page, 5000);
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
  const ribCtx = await openRibForm(page, memberId, { forceFresh: true });
  const saved = await readIbanFromRib(ribCtx);
  return saved === expectedIban;
}

async function closeGreyboxIfOpen(page) {
  const closeSelectors = [
    '#GB_window .close',
    '#GB_window a.close',
    '#GB_window img[title*="Close" i]',
    '#GB_window img[alt*="Close" i]',
    '#GB_close',
    '#GB_window img',
  ];
  for (const selClose of closeSelectors) {
    const closeBtn = page.locator(selClose).first();
    if ((await closeBtn.count()) > 0 && (await closeBtn.isVisible().catch(() => false))) {
      await closeBtn.click().catch(() => {});
      await randomDelay(200, 500);
    }
  }
  await page.keyboard.press('Escape').catch(() => {});
  await page.evaluate(() => {
    const win = document.querySelector('#GB_window');
    if (win) win.remove();
    document.querySelectorAll('#GB_overlay, .GB_overlay').forEach((el) => el.remove());
  }).catch(() => {});
  await randomDelay(200, 400);
}

/**
 * Flux : adresse membre → rib.php frais → IBAN + adresse mandat → Valider
 * Si Deciplus bloque sur l'adresse postale, on resauvegarde la fiche puis on réessaie.
 */
async function setMemberIban(page, memberId, iban, customer = {}, gymConfig = {}) {
  const value = normalizeIban(iban);
  if (!isValidFrenchIban(value)) {
    throw new Error('IBAN français invalide');
  }

  logInfo('Saisie RIB Deciplus', { member_id: memberId });
  const addr = ribAddressFields(customer, gymConfig);

  const addressOk = await ensureMemberPostalAddress(page, memberId, addr);
  if (!addressOk) {
    throw new Error(
      `RIB Deciplus: adresse postale membre ${memberId} non enregistrée (requis pour le mandat SEPA)`
    );
  }

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const ribCtx = await openRibForm(page, memberId, { forceFresh: true });
    const existingIban = await readIbanFromRib(ribCtx);
    if (existingIban === value) {
      logInfo('IBAN déjà enregistré sur le mandat Deciplus', { member_id: memberId });
      await closeGreyboxIfOpen(page);
      return true;
    }

    await fillRibForm(ribCtx, value, customer, gymConfig);

    if (await hasPostalAddressBlocker(ribCtx)) {
      logWarn('Blocage adresse postale Deciplus sur mandat — resauvegarde fiche membre', {
        member_id: memberId,
        attempt,
      });
      await closeGreyboxIfOpen(page);
      await ensureMemberPostalAddress(page, memberId, addr);
      continue;
    }

    await submitRibForm(ribCtx, page);
    await closeGreyboxIfOpen(page);

    const saved = await verifyIbanOnMandate(page, memberId, value);
    await closeGreyboxIfOpen(page);
    if (saved) {
      logInfo('RIB saisi sur fiche membre', { member_id: memberId, attempt });
      return true;
    }

    logWarn('IBAN non confirmé après soumission mandat', { member_id: memberId, attempt });
    await ensureMemberPostalAddress(page, memberId, addr);
  }

  throw new Error('RIB Deciplus: échec enregistrement IBAN sur le mandat');
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
