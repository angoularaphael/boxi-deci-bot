const { randomDelay, loadJson } = require('../lib/utils');
const { logInfo } = require('../lib/logger');
const { buildInternalNote } = require('../lib/normalize');

function getSelectors() {
  try {
    return loadJson('config/deciplus-selectors.json');
  } catch {
    return {};
  }
}

function genderToDeciplus(g) {
  const v = String(g || '').toUpperCase();
  if (v === 'M' || v === 'H' || v === 'HOMME') return 'H';
  if (v === 'F' || v === 'FEMME') return 'F';
  return v || 'H';
}

function formatBirthdate(raw) {
  if (!raw) return '01/01/1990';
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(raw)) return raw;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}

function phoneForDeciplus(raw) {
  let digits = String(raw || '').replace(/\D/g, '');
  if (digits.startsWith('33') && digits.length === 11) digits = `0${digits.slice(2)}`;
  if (digits.startsWith('0') && digits.length > 10) digits = digits.slice(0, 10);
  if (digits.length === 9) digits = `0${digits}`;
  return digits;
}

function countryLabelForDeciplus(raw) {
  const v = String(raw || '').trim().toUpperCase();
  if (!v || v === 'FR' || v === 'FRA') return 'France';
  return String(raw || '').trim() || 'France';
}

async function clickFirst(ctx, selectors, opts = {}) {
  const list = String(selectors).split(',').map((s) => s.trim());
  for (const sel of list) {
    const el = ctx.locator(sel).first();
    if ((await el.count()) > 0 && (await el.isVisible().catch(() => false))) {
      await el.click(opts);
      await randomDelay();
      return true;
    }
  }
  return false;
}

async function getMemberFormContext(page) {
  if ((await page.locator('form[name="db1_form"]').count()) > 0) return page;
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    if ((await frame.locator('form[name="db1_form"]').count()) > 0) return frame;
  }
  if ((await page.locator('input[name="nom"], input[name="prenom"]').count()) > 0) return page;
  return page;
}

async function fillFirst(ctx, selectors, value) {
  if (value == null || value === '' || !selectors) return false;
  const list = String(selectors).split(',').map((s) => s.trim());
  for (const sel of list) {
    const el = ctx.locator(sel).first();
    if ((await el.count()) > 0) {
      const tag = await el.evaluate((node) => node.tagName.toLowerCase()).catch(() => 'input');
      if (tag === 'select') {
        await el.selectOption({ value: String(value) }).catch(async () => {
          await el.selectOption({ label: String(value) }).catch(() => {});
        });
      } else {
        await el.fill(String(value));
      }
      await randomDelay(200, 500);
      return true;
    }
  }
  return false;
}

async function navigateToMembers(page) {
  const base = process.env.DECIPLUS_URL || 'https://boxingcenter.deciplus.pro/';
  const selectUrl = new URL('select.php', base).href;

  if (!page.url().includes('select.php')) {
    await page.goto(selectUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(async () => {
      const icon = page.locator('i.icon.fa-solid').first();
      if ((await icon.count()) > 0) await icon.click();
    });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await randomDelay();
  }
}

async function searchMember(page, query) {
  if (!query) return { found: false };
  logInfo('Recherche membre Deciplus', { query: query.includes('@') ? query : '***phone***' });

  const sel = getSelectors();
  await navigateToMembers(page);

  if (query.includes('@')) {
    await fillFirst(page, sel.quick_search_selectors?.email || '#i_email', query);
  } else {
    await fillFirst(page, sel.quick_search_selectors?.tel || '#i_tel', phoneForDeciplus(query));
  }

  await page.keyboard.press('Enter').catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  await randomDelay();

  const url = page.url();
  const idMatch = url.match(/idj=(\d+)/);
  if (idMatch && idMatch[1] !== 'new') {
    return { found: true, member_id: idMatch[1] };
  }

  return { found: false };
}

async function openNewMemberForm(page, customer) {
  const base = process.env.DECIPLUS_URL || 'https://boxingcenter.deciplus.pro/';
  const params = new URLSearchParams({
    idj: 'new',
    idn: '',
    returntoselect: '',
    jnom: customer.last_name || '',
    jprenom: customer.first_name || '',
  });
  if (customer.email) params.set('jemail', customer.email);

  await page.goto(new URL(`joueurs.php?${params}`, base).href, {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await randomDelay();

  const ctx = await getMemberFormContext(page);
  if ((await ctx.locator('form[name="db1_form"], input[name="nom"]').count()) > 0) {
    return ctx;
  }

  const sel = getSelectors();
  await navigateToMembers(page);
  await fillFirst(page, sel.quick_search_selectors?.nom || '#i_nom', customer.last_name);
  await fillFirst(page, sel.quick_search_selectors?.prenom || '#i_prenom', customer.first_name);
  if (customer.email) {
    await fillFirst(page, sel.quick_search_selectors?.email || '#i_email', customer.email);
  }

  const newBtn = page.locator(sel.quick_search_selectors?.new_button || '#buttonNew').first();
  if ((await newBtn.count()) > 0) {
    await newBtn.click();
    await page.waitForURL(/joueurs\.php.*idj=new/, { timeout: 20000 }).catch(() => {});
    await randomDelay();
    return getMemberFormContext(page);
  }

  throw new Error('Impossible d\'ouvrir joueurs.php pour création membre');
}

async function startNewMemberFromSelect(page, customer) {
  try {
    await openNewMemberForm(page, customer);
    return true;
  } catch {
    return false;
  }
}

async function fillMemberForm(page, customer, gymConfig, order) {
  const sel = getSelectors().member_form_selectors || {};
  const internalNote = buildInternalNote(order);
  const ctx = await getMemberFormContext(page);
  const phone = phoneForDeciplus(customer.phone);

  await fillFirst(ctx, sel.nom || 'input[name="nom"]', customer.last_name);
  await fillFirst(ctx, sel.prenom || 'input[name="prenom"]', customer.first_name);
  await fillFirst(ctx, sel.email || 'input[name="email"]', customer.email);
  await fillFirst(ctx, sel.date_naissance || 'input[name="date_naissance"]', formatBirthdate(customer.birthdate));
  await fillFirst(ctx, sel.sexe || 'select[name="sexe"]', genderToDeciplus(customer.gender));
  await fillFirst(ctx, sel.telsms || 'input[name="telsms"]', phone);
  await fillFirst(ctx, sel.tel || 'input[name="tel"]', phone);
  await fillFirst(ctx, sel.adr1 || 'input[name="adr1"]', customer.address);
  await fillFirst(ctx, sel.codepostal || 'input[name="codepostal"]', customer.postal_code);
  await fillFirst(ctx, sel.ville || 'input[name="ville"]', customer.city);
  await fillFirst(
    ctx,
    sel.pays || 'input[name="pays"], select[name="pays"]',
    countryLabelForDeciplus(customer.country)
  );

  if (order.utm?.source) await fillFirst(ctx, sel.utm_source || 'input[name="utm_source"]', order.utm.source);
  if (order.utm?.medium) await fillFirst(ctx, sel.utm_medium || 'input[name="utm_medium"]', order.utm.medium);
  if (order.utm?.campaign) {
    await fillFirst(ctx, sel.utm_campaign || 'input[name="utm_campaign"]', order.utm.campaign);
  }

  await fillFirst(ctx, sel.info_compta || 'input[name="info_compta"]', `Commande ${order.order_id}`);
  await fillFirst(ctx, sel.info_admin || 'textarea[name="info_admin"]', internalNote);

  if (gymConfig?.deciplus_zone_id) {
    await fillFirst(ctx, sel.idz || 'select[name="idz"]', gymConfig.deciplus_zone_id);
  }
}

async function submitMemberForm(page) {
  const cfg = getSelectors();
  const ctx = await getMemberFormContext(page);
  const submitSelectors = [
    cfg.member_form_selectors?.submit,
    cfg.member_detail?.validate_button,
    'input[type="submit"].albut_dw',
    'input[type="submit"].albut',
    'input[type="submit"][value="Valider"]',
    'form[name="db1_form"] input[type="submit"]',
  ]
    .filter(Boolean)
    .join(', ');

  const clicked = await clickFirst(ctx, submitSelectors);
  if (!clicked) {
    const form = ctx.locator('form[name="db1_form"]').first();
    if ((await form.count()) > 0) {
      await form.evaluate((f) => f.submit());
    } else {
      throw new Error(`Bouton Valider membre introuvable (${page.url()})`);
    }
  }

  await page.waitForURL(/check\.php\?idj=\d+|select\.php\?idjnew=\d+|joueurs\.php\?idj=\d+/, {
    timeout: 30000,
  }).catch(() => {});
  await randomDelay();
}

function extractMemberId(page) {
  const url = page.url();
  const patterns = [
    /check\.php\?idj=(\d+)/,
    /select\.php\?[^#]*idjnew=(\d+)/,
    /joueurs\.php\?idj=(\d+)/,
  ];
  for (const re of patterns) {
    const m = url.match(re);
    if (m && m[1] !== 'new') return m[1];
  }
  return null;
}

async function detectDuplicateError(page) {
  const err = page.locator('text=/existe déjà|doublon|duplicate|déjà utilisé/i').first();
  if ((await err.count()) > 0 && (await err.isVisible().catch(() => false))) {
    return err.innerText().catch(() => 'Doublon détecté');
  }
  return null;
}

async function findOrCreateMember(page, order, gymConfig) {
  const { customer } = order;

  if (customer.email) {
    const byEmail = await searchMember(page, customer.email);
    if (byEmail.found) return { member_id: byEmail.member_id, action: 'found_email' };
  }

  if (customer.phone) {
    const byPhone = await searchMember(page, customer.phone);
    if (byPhone.found) return { member_id: byPhone.member_id, action: 'found_phone' };
  }

  await openNewMemberForm(page, customer);
  await fillMemberForm(page, customer, gymConfig, order);
  await submitMemberForm(page);

  const duplicateMsg = await detectDuplicateError(page);
  if (duplicateMsg) return { duplicate: true, message: duplicateMsg };

  const memberId = extractMemberId(page);
  logInfo('Membre Deciplus créé', { member_id: memberId, order_id: order.order_id });
  return { member_id: memberId, action: 'created' };
}

module.exports = {
  navigateToMembers,
  searchMember,
  startNewMemberFromSelect,
  openNewMemberForm,
  fillMemberForm,
  submitMemberForm,
  findOrCreateMember,
  extractMemberId,
  detectDuplicateError,
  phoneForDeciplus,
};
