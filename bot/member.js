const { randomDelay, loadJson } = require('../lib/utils');
const { logInfo, logWarn } = require('../lib/logger');
const { gotoDeciplus } = require('./auth');
const { dismissJqueryUiOverlay } = require('./ui');
const {
  phoneForDeciplus,
  expandDeciplusUrl,
  extractMemberIdFromUrl,
  isNewMemberUrl,
} = require('../lib/deciplus-member-format');

function navTimeout() {
  return Number(process.env.DECIPLUS_NAV_TIMEOUT || 90000);
}

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

async function getMemberFormContext(page, { waitMs = 15000 } = {}) {
  const deadline = Date.now() + Math.max(0, waitMs);
  do {
    try {
      if ((await page.locator('form[name="db1_form"]').count()) > 0) return page;
      if ((await page.locator('input[name="nom"], input[name="prenom"], input[name="adr1"]').count()) > 0) {
        return page;
      }
      for (const frame of page.frames()) {
        if (frame === page.mainFrame()) continue;
        try {
          if ((await frame.locator('form[name="db1_form"]').count()) > 0) return frame;
          if ((await frame.locator('input[name="adr1"], input[name="nom"]').count()) > 0) return frame;
        } catch {
          /* iframe nextgen en cours de chargement */
        }
      }
    } catch {
      /* navigation */
    }
    if (Date.now() >= deadline) break;
    await page.waitForTimeout(400);
  } while (Date.now() < deadline);
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

/**
 * Force la salle Deciplus (select idz) selon la commande boutique.
 * Sans ça, Deciplus garde la zone de la session (souvent Balma).
 */
async function setMemberGymZone(ctx, gymConfig = {}) {
  const sel = getSelectors().member_form_selectors || {};
  const select = ctx.locator(sel.idz || 'select[name="idz"]').first();
  if ((await select.count()) === 0) return false;

  const zoneId = gymConfig.deciplus_zone_id ? String(gymConfig.deciplus_zone_id) : null;
  const label = gymConfig.deciplus_label || gymConfig.label || null;

  if (zoneId) {
    const byValue = await select.selectOption({ value: zoneId }).then(() => true).catch(() => false);
    if (byValue) {
      logInfo('Zone membre Deciplus (id)', { zone_id: zoneId, gym: gymConfig.key || label });
      return true;
    }
  }

  if (label) {
    const byLabel = await select.selectOption({ label }).then(() => true).catch(() => false);
    if (byLabel) {
      logInfo('Zone membre Deciplus (label)', { site: label });
      return true;
    }

    const options = await select.locator('option').all();
    const pattern = new RegExp(String(label).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    for (const opt of options) {
      const text = ((await opt.textContent().catch(() => '')) || '').trim();
      if (!text || !pattern.test(text)) continue;
      const value = await opt.getAttribute('value');
      if (!value) continue;
      await select.selectOption({ value });
      logInfo('Zone membre Deciplus (match)', { site: text, zone_id: value });
      return true;
    }
  }

  logWarn('Zone membre Deciplus non définie — risque mauvaise salle', {
    gym: gymConfig.key,
    label,
    zone_id: zoneId,
  });
  return false;
}

async function navigateToMembers(page) {
  const onSearchPage =
    page.url().includes('select.php') && !page.url().match(/idj=\d+/);
  if (onSearchPage) return;

  await gotoDeciplus(page, 'select.php').catch(async () => {
    const icon = page.locator('i.icon.fa-solid').first();
    if ((await icon.count()) > 0) await icon.click();
    await gotoDeciplus(page, 'select.php').catch(() => {});
  });
  await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
  await randomDelay();
  await dismissJqueryUiOverlay(page);
}

async function resetMemberSearchContext(page) {
  logInfo('Retour recherche membres Deciplus');
  await navigateToMembers(page);
}

async function searchMember(page, query) {
  if (!query) return { found: false };
  logInfo('Recherche membre Deciplus', { query: query.includes('@') ? query : '***phone***' });

  const sel = getSelectors();
  await navigateToMembers(page);

  // Reset champs pour éviter un filtre résiduel (ex. nom "bora")
  for (const field of ['#i_nom', '#i_prenom', '#i_email', '#i_tel', '#i_code']) {
    const el = page.locator(field).first();
    if ((await el.count()) > 0) await el.fill('').catch(() => {});
  }

  if (query.includes('@')) {
    await fillFirst(page, sel.quick_search_selectors?.email || '#i_email', query);
  } else {
    await fillFirst(page, sel.quick_search_selectors?.tel || '#i_tel', phoneForDeciplus(query));
  }

  await page.keyboard.press('Enter').catch(() => {});
  await randomDelay();
  await dismissJqueryUiOverlay(page);

  const fromUrl = extractMemberIdFromUrl(page.url());
  if (fromUrl) {
    logInfo('Membre Deciplus trouvé', { member_id: fromUrl });
    return { found: true, member_id: fromUrl };
  }

  const fromLink = await clickFirstMemberResult(page);
  if (fromLink) {
    logInfo('Membre Deciplus trouvé (liste)', { member_id: fromLink });
    return { found: true, member_id: fromLink };
  }

  logInfo('Membre Deciplus introuvable', { via: query.includes('@') ? 'email' : 'phone' });
  return { found: false };
}

async function extractMemberIdFromForm(page) {
  const ctx = await getMemberFormContext(page);
  const candidates = [
    'input[name="idj"]',
    'input[name="idj_hidden"]',
    'input#idj',
  ];
  for (const sel of candidates) {
    const el = ctx.locator(sel).first();
    if ((await el.count()) === 0) continue;
    const value = String((await el.inputValue().catch(() => '')) || '').trim();
    if (/^\d+$/.test(value)) return value;
  }
  return null;
}

async function clickFirstMemberResult(page) {
  const links = page.locator(
    'a[href*="idj="], a[href*="check.php?idj="], a[href*="joueurs.php?idj="]'
  );
  const count = await links.count();
  for (let i = 0; i < count; i += 1) {
    const href = (await links.nth(i).getAttribute('href').catch(() => '')) || '';
    const id = extractMemberIdFromUrl(href);
    if (!id) continue;
    await links.nth(i).click().catch(() => {});
    await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
    await randomDelay();
    return extractMemberIdFromUrl(page.url()) || id;
  }
  return null;
}

async function extractMemberId(page) {
  return (
    extractMemberIdFromUrl(page.url()) ||
    (await extractMemberIdFromForm(page)) ||
    null
  );
}

async function resolveCreatedMemberId(page, customer) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const id = await extractMemberId(page);
    if (id) return id;
    await page.waitForTimeout(800);
  }

  if (customer?.email) {
    const byEmail = await searchMember(page, customer.email);
    if (byEmail.found) return byEmail.member_id;
  }
  if (customer?.phone) {
    const byPhone = await searchMember(page, customer.phone);
    if (byPhone.found) return byPhone.member_id;
  }
  return null;
}

async function detectFormValidationError(page) {
  const patterns = [
    /champ.*obligatoire/i,
    /obligatoire/i,
    /date.*invalide/i,
    /email.*invalide/i,
    /erreur/i,
    /impossible/i,
  ];
  const text = ((await page.locator('body').innerText().catch(() => '')) || '').slice(0, 2000);
  for (const re of patterns) {
    if (re.test(text) && /obligatoire|invalide|erreur|impossible/i.test(text)) {
      const loc = page.locator('text=/obligatoire|invalide|erreur/i').first();
      if ((await loc.count()) > 0 && (await loc.isVisible().catch(() => false))) {
        return ((await loc.innerText().catch(() => '')) || '').trim().slice(0, 200);
      }
    }
  }
  return null;
}

async function openNewMemberFormViaSelect(page, customer) {
  const sel = getSelectors();
  await navigateToMembers(page);
  await fillFirst(page, sel.quick_search_selectors?.nom || '#i_nom', customer.last_name);
  await fillFirst(page, sel.quick_search_selectors?.prenom || '#i_prenom', customer.first_name);
  if (customer.email) {
    await fillFirst(page, sel.quick_search_selectors?.email || '#i_email', customer.email);
  }

  const newBtn = page.locator(sel.quick_search_selectors?.new_button || '#buttonNew').first();
  if ((await newBtn.count()) === 0) return null;

  await newBtn.click();
  await page.waitForURL(/joueurs\.php.*idj=new/, { timeout: navTimeout() }).catch(() => {});
  await randomDelay();
  await dismissJqueryUiOverlay(page);

  const ctx = await getMemberFormContext(page);
  if ((await ctx.locator('form[name="db1_form"], input[name="nom"]').count()) > 0) {
    return ctx;
  }
  return null;
}

async function openNewMemberFormViaUrl(page, customer) {
  const params = new URLSearchParams({
    idj: 'new',
    idn: '',
    returntoselect: '',
    jnom: customer.last_name || '',
    jprenom: customer.first_name || '',
  });
  if (customer.email) params.set('jemail', customer.email);

  await gotoDeciplus(page, `joueurs.php?${params}`);
  await randomDelay();
  await dismissJqueryUiOverlay(page);

  const ctx = await getMemberFormContext(page);
  if ((await ctx.locator('form[name="db1_form"], input[name="nom"]').count()) > 0) {
    return ctx;
  }
  return null;
}

async function openNewMemberForm(page, customer) {
  logInfo('Ouverture formulaire nouveau membre Deciplus', {
    last_name: customer.last_name,
    email: customer.email || null,
  });

  let ctx = await openNewMemberFormViaSelect(page, customer);
  if (ctx) return ctx;

  logInfo('Repli création membre — URL directe joueurs.php');
  try {
    ctx = await openNewMemberFormViaUrl(page, customer);
    if (ctx) return ctx;
  } catch (err) {
    logWarn('URL directe joueurs.php en échec', { error: err.message });
  }

  ctx = await openNewMemberFormViaSelect(page, customer);
  if (ctx) return ctx;

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
  const ctx = await getMemberFormContext(page);
  const phone = phoneForDeciplus(customer.phone);
  const lastName = customer.last_name || customer.first_name || 'CLIENT';
  const firstName = customer.first_name || customer.last_name || 'WEB';

  logInfo('Remplissage fiche membre Deciplus', {
    last_name: lastName,
    phone: phone || null,
    email: customer.email || null,
    gym: gymConfig.key || gymConfig.deciplus_label || null,
  });

  await fillFirst(ctx, sel.nom || 'input[name="nom"]', lastName);
  await fillFirst(ctx, sel.prenom || 'input[name="prenom"]', firstName);
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

  await setMemberZone(ctx, gymConfig);
}

/**
 * Force la zone Deciplus du formulaire membre selon la salle choisie en boutique.
 * Ne force jamais une salle par défaut : utilise gymConfig de la commande.
 */
async function setMemberZone(ctx, gymConfig = {}) {
  const selectSel = (getSelectors().member_form_selectors || {}).idz || 'select[name="idz"]';
  const select = ctx.locator(selectSel).first();
  if ((await select.count()) === 0) {
    logWarn('Champ zone Deciplus (idz) introuvable sur formulaire membre');
    return false;
  }

  const label = gymConfig.deciplus_label || gymConfig.label;
  const zoneId = gymConfig.deciplus_zone_id != null ? String(gymConfig.deciplus_zone_id) : null;

  if (zoneId) {
    const byValue = await select.selectOption(zoneId).then(() => true).catch(() => false);
    if (byValue) {
      logInfo('Zone membre Deciplus', { zone_id: zoneId, site: label });
      return true;
    }
  }

  if (label) {
    const byLabel = await select.selectOption({ label }).then(() => true).catch(() => false);
    if (byLabel) {
      logInfo('Zone membre Deciplus', { site: label });
      return true;
    }

    const options = select.locator('option');
    const count = await options.count();
    const pattern = new RegExp(String(label).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    for (let i = 0; i < count; i += 1) {
      const opt = options.nth(i);
      const text = ((await opt.textContent().catch(() => '')) || '').trim();
      if (!pattern.test(text)) continue;
      const value = await opt.getAttribute('value');
      if (value == null || value === '') continue;
      await select.selectOption(value);
      logInfo('Zone membre Deciplus', { site: text, zone_id: value });
      return true;
    }
  }

  logWarn('Impossible de sélectionner la salle Deciplus sur le formulaire membre', {
    gym: gymConfig.key || null,
    site: label || null,
    zone_id: zoneId,
  });
  return false;
}

async function isNewMemberForm(page, ctx) {
  if (isNewMemberUrl(page.url())) return true;

  const mode = ctx.locator('input[name="alde_mode"][value="new"]').first();
  if ((await mode.count()) > 0) return true;

  const aldeMode = ctx.locator('input[name="alde_mode"]').first();
  if ((await aldeMode.count()) > 0) {
    const value = String((await aldeMode.inputValue().catch(() => '')) || '').toLowerCase();
    if (value === 'new') return true;
  }

  const idj = ctx.locator('input[name="idj"]').first();
  if ((await idj.count()) > 0) {
    const value = await idj.inputValue().catch(() => '');
    if (!value || value === 'new') return true;
  }
  return false;
}

async function prepareMemberFormSubmit(ctx, isNew) {
  await ctx.evaluate(({ createMode }) => {
    const form = document.querySelector('form[name="db1_form"]');
    if (!form) return;
    const aldeSubmit = form.querySelector('input[name="alde_submit"]');
    if (aldeSubmit) aldeSubmit.value = 'valider';
    const demandeMaj = form.querySelector('input[name="demande_maj"]');
    if (demandeMaj) demandeMaj.value = createMode ? '0' : '1';
    const aldeMode = form.querySelector('input[name="alde_mode"]');
    if (aldeMode && createMode) aldeMode.value = 'new';
    const idj = form.querySelector('input[name="idj"]');
    if (idj && createMode && (!idj.value || idj.value === 'new')) idj.value = 'new';
  }, { createMode: isNew });
}

async function submitMemberForm(page) {
  const cfg = getSelectors();
  const ctx = await getMemberFormContext(page);
  const isNew = await isNewMemberForm(page, ctx);
  logInfo('Soumission formulaire membre Deciplus', {
    is_new: isNew,
    url: page.url(),
  });

  await dismissJqueryUiOverlay(page);
  await prepareMemberFormSubmit(ctx, isNew);

  // Nouveau membre : TOUJOURS Valider (jamais Mettre à jour)
  const validateSelectors = [
    cfg.member_form_selectors?.submit,
    cfg.member_detail?.validate_button,
    'form[name="db1_form"] input[type="submit"][value="Valider"]',
    'input[type="submit"][value="Valider"]',
    'input.albut_dw[value="Valider"]',
    'input.albut[value="Valider"]',
  ]
    .filter(Boolean)
    .join(', ');

  const updateSelectors = [
    cfg.member_detail?.update_button,
    'input[type="submit"][value="Mettre à jour"]',
  ]
    .filter(Boolean)
    .join(', ');

  const submitSelectors = isNew ? validateSelectors : `${updateSelectors}, ${validateSelectors}`;
  let clicked = await clickFirst(ctx, submitSelectors, { force: true });

  if (!clicked && isNew) {
    // Repli : forcer le submit HTML avec alde_submit=valider
    clicked = await ctx.evaluate(() => {
      const form = document.querySelector('form[name="db1_form"]');
      if (!form) return false;
      const aldeSubmit = form.querySelector('input[name="alde_submit"]');
      if (aldeSubmit) aldeSubmit.value = 'valider';
      const demandeMaj = form.querySelector('input[name="demande_maj"]');
      if (demandeMaj) demandeMaj.value = '0';
      form.submit();
      return true;
    }).catch(() => false);
  }

  if (!clicked) {
    const form = ctx.locator('form[name="db1_form"]').first();
    if ((await form.count()) > 0) {
      await prepareMemberFormSubmit(ctx, isNew);
      await form.evaluate((f) => f.submit());
      clicked = true;
    } else {
      throw new Error(`Bouton Valider membre introuvable (${page.url()})`);
    }
  }

  await page.waitForURL(
    /check\.php|idjnew=\d+|joueurs\.php\?[^#]*idj=\d+|legacy\?path=.*idj/i,
    { timeout: navTimeout() }
  ).catch(() => {});
  await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
  await randomDelay(800, 1500);
  await dismissJqueryUiOverlay(page);

  const afterUrl = page.url();
  logInfo('Après soumission membre', { url: afterUrl, member_id: extractMemberIdFromUrl(afterUrl) });
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

  await resetMemberSearchContext(page);

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
  if (duplicateMsg) {
    logWarn('Doublon à la création — recherche membre existant', { order_id: order.order_id });
    if (customer.email) {
      const retryEmail = await searchMember(page, customer.email);
      if (retryEmail.found) {
        return { member_id: retryEmail.member_id, action: 'found_after_duplicate' };
      }
    }
    if (customer.phone) {
      const retryPhone = await searchMember(page, customer.phone);
      if (retryPhone.found) {
        return { member_id: retryPhone.member_id, action: 'found_after_duplicate' };
      }
    }
    return { duplicate: true, message: duplicateMsg };
  }

  const validationError = await detectFormValidationError(page);
  const memberId = await resolveCreatedMemberId(page, customer);

  if (!memberId) {
    const hint = validationError ? ` — ${validationError}` : '';
    logWarn('Création membre sans ID récupérable', {
      order_id: order.order_id,
      url: page.url(),
      validation: validationError || null,
    });
    throw new Error(
      `Création membre Deciplus: ID introuvable après Valider${hint}. ` +
        'Le membre n’apparaît peut-être pas (formulaire non validé).'
    );
  }

  logInfo('Membre Deciplus créé', { member_id: memberId, order_id: order.order_id });
  return { member_id: memberId, action: 'created' };
}

async function resolvePhotoFile(photoPath, photoBase64) {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');

  if (photoPath && fs.existsSync(photoPath)) return { path: photoPath, cleanup: false };

  if (photoBase64) {
    const raw = String(photoBase64);
    const m = raw.match(/^data:(image\/[\w+.-]+);base64,(.+)$/i);
    const b64 = m ? m[2] : raw.replace(/^data:[^;]+;base64,/, '');
    const ext = m && /png/i.test(m[1]) ? '.png' : m && /webp/i.test(m[1]) ? '.webp' : '.jpg';
    const dest = path.join(os.tmpdir(), `bc-member-photo-${Date.now()}${ext}`);
    fs.writeFileSync(dest, Buffer.from(b64, 'base64'));
    return { path: dest, cleanup: true };
  }

  return null;
}

function fileToDataUrl(filePath) {
  const fs = require('fs');
  const path = require('path');
  const buf = fs.readFileSync(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const mime =
    ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : ext === '.gif' ? 'image/gif' : 'image/jpeg';
  return `data:${mime};base64,${buf.toString('base64')}`;
}

async function getStaffAccessToken(page) {
  return page.evaluate(() => {
    try {
      return JSON.parse(localStorage.getItem('auth') || '{}').token || null;
    } catch {
      return null;
    }
  });
}

/** Upscale / downscale via canvas navigateur (min 200px côté Deciplus). */
async function normalizePhotoDataUrl(page, dataUrl, { min = 200, max = 1000, quality = 0.9 } = {}) {
  return page.evaluate(
    async ({ src, minSize, maxSize, q }) => {
      const img = new Image();
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = () => reject(new Error('image_load_failed'));
        img.src = src;
      });
      let w = img.naturalWidth || img.width;
      let h = img.naturalHeight || img.height;
      if (!w || !h) throw new Error('invalid_image_dimensions');

      if (w < minSize || h < minSize) {
        const scale = Math.max(minSize / w, minSize / h);
        w = Math.max(minSize, Math.round(w * scale));
        h = Math.max(minSize, Math.round(h * scale));
      } else if (w > maxSize || h > maxSize) {
        const scale = Math.min(maxSize / w, maxSize / h);
        w = Math.round(w * scale);
        h = Math.round(h * scale);
      } else if (src.startsWith('data:image/jpeg')) {
        return src;
      }

      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      return canvas.toDataURL('image/jpeg', q);
    },
    { src: dataUrl, minSize: min, maxSize: max, q: quality }
  );
}

async function uploadMemberPhotoViaApi(page, memberId, dataUrl) {
  const token = await getStaffAccessToken(page);
  if (!token) return { ok: false, reason: 'no_staff_token' };
  if (!memberId) return { ok: false, reason: 'no_member_id' };

  const normalized = await normalizePhotoDataUrl(page, dataUrl);
  const url = `https://api.deciplus.pro/staff/v1/member/${memberId}/photo`;
  const res = await page.context().request.fetch(url, {
    method: 'PUT',
    headers: {
      'x-access-token': token,
      'Deciplus-Client-Type': 'manager',
      'Content-Type': 'application/json',
    },
    data: { photo: normalized },
  });
  const status = res.status();
  const text = await res.text().catch(() => '');
  if (status >= 200 && status < 300) {
    logInfo('Photo membre uploadée (API Deciplus)', { member_id: memberId, status });
    return { ok: true, via: 'api', status };
  }
  logWarn('Échec upload photo API', { member_id: memberId, status, body: String(text).slice(0, 200) });
  return { ok: false, reason: `api_${status}`, body: String(text).slice(0, 200) };
}

/** Repli legacy : Greybox photo_upload.php via bouton openUpload. */
async function uploadMemberPhotoViaLegacyUi(page, photoPath, memberId) {
  const fs = require('fs');
  if (!photoPath || !fs.existsSync(photoPath)) return { ok: false, reason: 'missing_file' };

  const contexts = [page, ...page.frames().filter((f) => f !== page.mainFrame())];
  for (const ctx of contexts) {
    const uploadBtn = ctx.locator(
      'input.bouton_upload, input[onclick*="openUpload"], .bouton_upload, a[onclick*="openUpload"]'
    ).first();
    if ((await uploadBtn.count()) === 0) continue;
    try {
      await uploadBtn.click({ force: true });
      await randomDelay(500, 900);
      break;
    } catch {
      /* try next */
    }
  }

  // Ouvrir directement photo_upload.php si Greybox pas ouvert
  const base = process.env.DECIPLUS_URL || page.url();
  let uploadFrame = null;
  for (let i = 0; i < 10; i += 1) {
    for (const frame of page.frames()) {
      const fu = frame.url() || '';
      if (/photo_upload\.php/i.test(fu)) {
        uploadFrame = frame;
        break;
      }
    }
    if (uploadFrame) break;
    if (i === 3 && memberId) {
      await page.goto(new URL(`photo_upload.php?idj=${memberId}`, base).href, {
        waitUntil: 'domcontentloaded',
        timeout: navTimeout(),
      }).catch(() => {});
    }
    await randomDelay(300, 500);
  }

  const target = uploadFrame || page;
  const fileInput = target.locator('input[type="file"]').first();
  if ((await fileInput.count()) === 0) return { ok: false, reason: 'legacy_no_file_input' };
  await fileInput.setInputFiles(photoPath);
  await randomDelay(400, 700);
  await clickFirst(
    target,
    'input[type="submit"], input[value="Valider"], input[value="Envoyer"], button[type="submit"]'
  ).catch(() => false);
  await randomDelay(800, 1200);
  logInfo('Photo membre envoyée (legacy photo_upload)', { member_id: memberId });
  return { ok: true, via: 'legacy_ui' };
}

/**
 * Upload photo membre Deciplus.
 * Priorité : API staff PUT /member/:id/photo (base64, min 200×200).
 * Repli : UI legacy photo_upload.php.
 */
async function uploadMemberPhoto(page, photoPath, photoBase64 = null, memberId = null) {
  const fs = require('fs');
  const resolved = await resolvePhotoFile(photoPath, photoBase64);
  if (!resolved?.path && !photoBase64) {
    return { ok: false, reason: 'missing_file' };
  }

  const cleanup = () => {
    if (resolved?.cleanup && resolved.path) {
      try {
        fs.unlinkSync(resolved.path);
      } catch {
        /* ignore */
      }
    }
  };

  try {
    let dataUrl = null;
    if (photoBase64 && /^data:image\//i.test(String(photoBase64))) {
      dataUrl = String(photoBase64);
    } else if (resolved?.path) {
      dataUrl = fileToDataUrl(resolved.path);
    } else if (photoBase64) {
      dataUrl = `data:image/jpeg;base64,${String(photoBase64).replace(/^data:[^;]+;base64,/, '')}`;
    }

    if (dataUrl && memberId) {
      const api = await uploadMemberPhotoViaApi(page, memberId, dataUrl);
      if (api.ok) {
        cleanup();
        return api;
      }
    }

    if (resolved?.path) {
      const legacy = await uploadMemberPhotoViaLegacyUi(page, resolved.path, memberId);
      cleanup();
      return legacy;
    }

    cleanup();
    return { ok: false, reason: 'upload_failed' };
  } catch (err) {
    cleanup();
    return { ok: false, reason: err.message };
  }
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
  extractMemberIdFromUrl,
  expandDeciplusUrl,
  detectDuplicateError,
  phoneForDeciplus,
  resetMemberSearchContext,
  uploadMemberPhoto,
  resolvePhotoFile,
};
