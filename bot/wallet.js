const { randomDelay, loadJson } = require('../lib/utils');
const { logInfo, logWarn } = require('../lib/logger');
const {
  normalizeIban,
  isValidFrenchIban,
  frenchIbanToRibParts,
  isLikelyBic,
  bicFromFrenchIban,
} = require('../lib/iban');
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

const { ribAddressFields } = require('../lib/fr-address');

async function clickFirst(ctx, selectors, opts = {}) {
  const list = String(selectors).split(',').map((s) => s.trim());
  for (const s of list) {
    const el = ctx.locator(s).first();
    if ((await el.count()) > 0 && (await el.isVisible().catch(() => false))) {
      const clickOpts = { timeout: 15000, ...opts };
      try {
        await el.click(clickOpts);
        await randomDelay();
        return true;
      } catch (err) {
        if (clickOpts.force) {
          logWarn('Clic Deciplus échoué', { selector: s.slice(0, 80), error: err.message });
          continue;
        }
        const forced = await el
          .click({ ...clickOpts, force: true, timeout: 8000 })
          .then(() => true)
          .catch(() => false);
        if (forced) {
          await randomDelay();
          return true;
        }
      }
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

async function ribValiderDisabled(ctx) {
  return ctx
    .evaluate(() => {
      const btn = [...document.querySelectorAll('input[type="submit"], button')].find((el) =>
        /^valider$/i.test(String(el.value || el.textContent || '').trim())
      );
      return Boolean(btn && btn.disabled);
    })
    .catch(() => false);
}

/**
 * True si le formulaire mandat doit encore être validé.
 * Valider grisé / bandeau adresse collé + RUM+IBAN déjà présents = lecture seule Deciplus,
 * pas un RIB manquant (le bandeau fiche rouge reste la source de vérité).
 */
async function ribMandateNeedsSave(ctx) {
  const meta = await readMandateMeta(ctx).catch(() => ({ rum: '', iban: '', bic: '' }));
  const hasRum = Boolean(String(meta.rum || '').trim());
  const hasIban = Boolean(normalizeIban(meta.iban || ''));
  const hasBic = isLikelyBic(meta.bic);
  if (hasIban && !hasBic) return true;
  // Mandat déjà posé (IBAN + BIC + RUM) : ni Valider grisé ni le faux bandeau adresse ne comptent.
  if (hasRum && hasIban && hasBic) return false;
  if (await hasPostalAddressBlocker(ctx)) return true;
  return ribValiderDisabled(ctx);
}

/**
 * Alerte RIB Deciplus = icone banque du bandeau fiche (#icon-list).
 * Ne pas utiliser .payments-mode-icon (souvent Rib-nok meme quand le RIB header est OK).
 */
async function memberAsksToRegisterRib(page) {
  for (const ctx of [page, ...(page.frames?.() || [])]) {
    try {
      const flagged = await ctx.evaluate(() => {
        const text = document.body?.innerText || '';
        // Bandeau texte explicite (rare hors survol)
        if (/veuillez\s+enregistrer\s+le\s+rib(\s+du\s+membre)?/i.test(text)) return true;

        // Source de vérité : icones du header fiche (#icon-list)
        // Ne PAS utiliser title="Alerte Paiement" : Deciplus l'affiche aussi pour les IMPAYES.
        const header = document.querySelector('#icon-list');
        if (header) {
          const nok = header.querySelector('[alt="Rib-nok"], [alt="RIB-nok"], .icon-bank.is-alert');
          if (nok) return true;
          // Si Rib-ok present dans le header → pas d’alerte RIB
          if (header.querySelector('[alt="Rib-ok"], [title="RIB enregistré"]')) return false;
        }

        // Fallback sans #icon-list : Rib-nok hors zone payments-mode
        const loose = [...document.querySelectorAll('[alt="Rib-nok"], [alt="RIB-nok"]')].filter(
          (el) => !el.closest('.payments-mode-wrapper, .payments-mode-rib-wrapper')
        );
        return loose.length > 0;
      });
      if (flagged) return true;
    } catch {
      /* frame */
    }
  }
  return false;
}

/** Attend l’iframe check.php (bloc Mandat + #icon-list) avant de lire Rib-ok/nok. */
async function waitForMemberCheckReady(page, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const ctx of page.frames?.() || []) {
      try {
        const url = ctx.url?.() || '';
        if (!/check\.php/i.test(url)) continue;
        const ready = await ctx.evaluate(() => {
          const header = document.querySelector('#icon-list');
          if (
            header &&
            header.querySelector(
              '[alt="Rib-ok"], [alt="Rib-nok"], [alt="RIB-ok"], [alt="RIB-nok"], .icon-bank'
            )
          ) {
            return true;
          }
          const text = document.body?.innerText || '';
          return (
            /Mandat|Moyens de paiements|Achat Abonnement|Abonnements/i.test(text) ||
            Boolean(document.querySelector('.payments-mode-wrapper, .payments-mode-icon, [alt="Rib-nok"]'))
          );
        });
        if (ready) return true;
      } catch {
        /* frame */
      }
    }
    await page.waitForTimeout(400);
  }
  return false;
}

/**
 * Succès RIB = Rib-ok visible dans #icon-list (pas seulement « pas de Rib-nok »).
 * Sans icone header chargée, on refuse le succès (évite bot_status=success à tort).
 */
async function ficheRibCleared(page, memberId, gymConfig = {}) {
  await closeGreyboxIfOpen(page).catch(() => {});
  await openMemberCheck(page, memberId, gymConfig).catch(() => {});
  await waitForMemberCheckReady(page, 15000);
  await randomDelay(500, 900);

  for (const ctx of [page, ...(page.frames?.() || [])]) {
    try {
      const state = await ctx.evaluate(() => {
        if (/veuillez\s+enregistrer\s+le\s+rib(\s+du\s+membre)?/i.test(document.body?.innerText || '')) {
          return 'asks_text';
        }
        const header = document.querySelector('#icon-list');
        if (!header) return null;
        if (header.querySelector('[alt="Rib-nok"], [alt="RIB-nok"], .icon-bank.is-alert')) {
          return 'nok';
        }
        if (header.querySelector('[alt="Rib-ok"], [title="RIB enregistré"]')) {
          return 'ok';
        }
        return 'header_no_rib';
      });
      if (state === 'ok') return true;
      if (state === 'nok' || state === 'asks_text') return false;
    } catch {
      /* frame */
    }
  }

  // Fallback : si aucune frame n'a #icon-list Rib-ok, ne pas valider.
  if (await memberAsksToRegisterRib(page)) return false;
  logWarn('ficheRibCleared: #icon-list Rib-ok introuvable — non validé', {
    member_id: memberId,
  });
  return false;
}

/** Empreinte carte PayPlug (jamais le PAN complet — PCI). */
function cardFingerprintFromPayplug(payment) {
  const c = payment?.card || payment?.payment_method?.card || {};
  const last4 = c.last4 || c.last_4 || payment?.card_last4 || null;
  const brand = c.brand || c.scheme || c.card_type || payment?.card_brand || null;
  const expMonth = c.exp_month || c.expMonth || null;
  const expYear = c.exp_year || c.expYear || null;
  const country = c.country || null;
  if (!last4 && !brand) return null;
  return {
    card_last4: last4 != null ? String(last4) : null,
    card_brand: brand != null ? String(brand) : null,
    card_exp_month: expMonth != null ? Number(expMonth) || null : null,
    card_exp_year: expYear != null ? Number(expYear) || null : null,
    card_country: country != null ? String(country) : null,
  };
}

/**
 * Deciplus affiche parfois le bandeau alors que adr_line1/CP/ville sont déjà remplis.
 * Dans ce cas le submit UI est disabled, mais le serveur accepte quand même le mandat
 * si on force l'activation (confirmé en local : RUM créé).
 */
async function ribMandateAddressReady(ctx) {
  return ctx
    .evaluate(() => {
      const v = (n) => String(document.querySelector(`input[name="${n}"]`)?.value || '').trim();
      const line1 = v('adr_line1');
      const town = v('adr_town');
      const post = v('adr_postcode').replace(/\D/g, '');
      return Boolean(line1) && Boolean(town) && post.length >= 4;
    })
    .catch(() => false);
}

async function pinFrenchCoordinates(ctx) {
  await ctx
    .evaluate(() => {
      const pays = document.querySelector('[name="pays"], [name="adr_country"]');
      if (pays) {
        if (pays.tagName === 'SELECT') {
          const opt = [...pays.options].find(
            (o) => /france/i.test(o.text || '') || /^(fr|fra|france)$/i.test(o.value || '')
          );
          if (opt) pays.value = opt.value;
        } else if (!/france/i.test(pays.value || '')) {
          pays.value = 'France';
        }
        pays.dispatchEvent(new Event('input', { bubbles: true }));
        pays.dispatchEvent(new Event('change', { bubbles: true }));
      }
      const lat = document.querySelector('[name="latitude"]');
      const lng = document.querySelector('[name="longitude"]');
      if (!lat || !lng) return;
      const rawLat = String(lat.value || '').trim();
      const rawLng = String(lng.value || '').trim();
      const latN = Number(rawLat.replace(',', '.'));
      const lngN = Number(rawLng.replace(',', '.'));
      const inFrance =
        rawLat !== '' &&
        rawLng !== '' &&
        Number.isFinite(latN) &&
        Number.isFinite(lngN) &&
        latN >= 41 &&
        latN <= 51.5 &&
        lngN >= -5.5 &&
        lngN <= 10;
      if (!inFrance) {
        lat.value = '43.6045';
        lng.value = '1.4442';
        lat.dispatchEvent(new Event('input', { bubbles: true }));
        lng.dispatchEvent(new Event('input', { bubbles: true }));
        lat.dispatchEvent(new Event('change', { bubbles: true }));
        lng.dispatchEvent(new Event('change', { bubbles: true }));
      }
    })
    .catch(() => {});
}

async function unlockRibFormForSubmit(ctx) {
  await ctx
    .evaluate(() => {
      document.querySelectorAll('input, select, textarea, button').forEach((el) => {
        el.disabled = false;
        if ('readOnly' in el) el.readOnly = false;
      });
      document.querySelectorAll('.message').forEach((el) => {
        if (/adresse postale est obligatoire/i.test(el.textContent || '')) el.remove();
      });
    })
    .catch(() => {});
}

function navTimeoutMs() {
  return Number(process.env.DECIPLUS_NAV_TIMEOUT || 90000);
}

function memberCheckUrls(memberId) {
  const base = process.env.DECIPLUS_URL || 'https://boxingcenter.deciplus.pro/';
  const origin = new URL(base).origin;
  const qs = `check.php?idj=${encodeURIComponent(memberId)}`;
  return [
    // nextgen/legacy d’abord — plus fiable après résiliation (évite hang check.php brut)
    `${origin}/nextgen/legacy?path=${encodeURIComponent(`/${qs}`)}`,
    `${origin}/${qs}`,
  ];
}

async function openMemberDetail(page, memberId) {
  const base = process.env.DECIPLUS_URL || 'https://boxingcenter.deciplus.pro/';
  const origin = new URL(base).origin;
  const timeout = Math.min(navTimeoutMs(), 60000);
  const urls = [
    `${origin}/nextgen/legacy?path=${encodeURIComponent(`/joueurs.php?idj=${memberId}`)}`,
    new URL(`joueurs.php?idj=${memberId}`, base).href,
  ];
  let lastErr = null;
  for (const target of urls) {
    try {
      await page.goto(target, { waitUntil: 'domcontentloaded', timeout });
      await randomDelay();
      await getMemberFormContext(page, { waitMs: 15000 });
      return;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error(`openMemberDetail failed for ${memberId}`);
}

async function openMemberCheck(page, memberId, gymConfig = {}) {
  const base = process.env.DECIPLUS_URL || 'https://boxingcenter.deciplus.pro/';
  const urls = memberCheckUrls(memberId);
  const timeout = Math.min(navTimeoutMs(), 60000);
  let lastErr = null;
  const { isChooseZoneScreen, ensureDeciplusSaleZone } = require('./deciplus-zone');

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const target = urls[attempt % urls.length];
    try {
      await page.goto(target, {
        waitUntil: attempt === 0 ? 'domcontentloaded' : 'commit',
        timeout,
      });
      await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
      await randomDelay();
      if (await isChooseZoneScreen(page) || /choose-zone/i.test(page.url())) {
        await ensureDeciplusSaleZone(page, gymConfig);
        continue;
      }
      // Fiche membre : bouton Achat Abonnement / iframe nextgen
      const readyDeadline = Date.now() + 12000;
      while (Date.now() < readyDeadline) {
        if (/login\.php/i.test(page.url())) {
          throw new Error(`Session Deciplus expirée (login.php) — check.php idj=${memberId}`);
        }
        if (await isChooseZoneScreen(page) || /choose-zone/i.test(page.url())) {
          break;
        }
        for (const ctx of [page, ...page.frames()]) {
          try {
            if (
              (await ctx
                .locator(
                  'input.fichemembre_button[value*="Achat"], input[value*="Achat Abonnement"], text=/Achat Abonnement/i'
                )
                .count()) > 0
            ) {
              return;
            }
          } catch {
            /* frame détachée */
          }
        }
        if (/check\.php|\/legacy/i.test(page.url()) && !/choose-zone/i.test(page.url())) {
          return;
        }
        await page.waitForTimeout(400);
      }
      if (await isChooseZoneScreen(page) || /choose-zone/i.test(page.url())) {
        await ensureDeciplusSaleZone(page, gymConfig);
        continue;
      }
      return;
    } catch (err) {
      lastErr = err;
      const msg = String(err.message || '');
      // Après résiliation, Deciplus timeout / abort souvent — retry avec autre URL
      const retryable =
        /ERR_ABORTED|interrupted|destroyed|Timeout|timeout|exceeded|Session Deciplus expirée/i.test(
          msg
        );
      logWarn('openMemberCheck — retry', {
        member_id: memberId,
        attempt: attempt + 1,
        url: target,
        error: msg.slice(0, 160),
      });
      if (!retryable && attempt >= 1) break;
      await page.waitForTimeout(700 * (attempt + 1));
      await page
        .goto(new URL('nextgen/home', base).href, {
          waitUntil: 'domcontentloaded',
          timeout: 25000,
        })
        .catch(() => {});
    }
  }
  throw lastErr || new Error(`openMemberCheck failed for ${memberId}`);
}

async function getMemberFormContext(page, { waitMs = 0 } = {}) {
  const deadline = Date.now() + Math.max(0, waitMs);
  do {
    try {
      if ((await page.locator('form[name="db1_form"]').count()) > 0) return page;
      if ((await page.locator('input[name="adr1"]').count()) > 0) return page;
      for (const frame of page.frames()) {
        if (frame === page.mainFrame()) continue;
        try {
          if ((await frame.locator('form[name="db1_form"]').count()) > 0) return frame;
          if ((await frame.locator('input[name="adr1"]').count()) > 0) return frame;
        } catch {
          /* frame détachée pendant le chargement nextgen */
        }
      }
    } catch {
      /* navigation en cours */
    }
    if (Date.now() >= deadline) break;
    await page.waitForTimeout(400);
  } while (Date.now() < deadline);

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
  const ctx = await getMemberFormContext(page, { waitMs: 10000 });
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

async function fetchMemberViaApi(page, memberId) {
  const token = await getAccessToken(page);
  if (!token) return null;
  try {
    const get = await page.context().request.get(`${DECIPLUS_API}/member/${memberId}`, {
      headers: apiHeaders(token),
    });
    if (!get.ok()) return null;
    const body = await get.json();
    return body.response || body || null;
  } catch {
    return null;
  }
}

function addressMatchesMember(member, addr) {
  if (!member || !addr) return false;
  const savedPostal = String(member.postalCode || member.postal_code || '').replace(/\D/g, '');
  const expectedPostal = String(addr.postal_code || '').replace(/\D/g, '');
  const adr = String(member.adr1 || member.address || '').trim();
  const city = String(member.city || member.ville || '').trim();
  return savedPostal === expectedPostal && Boolean(adr) && Boolean(city);
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

  // Deciplus accepte parfois manager_legacy pour les updates
  const headerVariants = [
    apiHeaders(token),
    { ...apiHeaders(token), 'Deciplus-Client-Type': 'manager_legacy' },
  ];

  let updated = false;
  for (const headers of headerVariants) {
    for (const method of ['PUT', 'PATCH']) {
      try {
        const res = await page.context().request.fetch(`${DECIPLUS_API}/member/${memberId}`, {
          method,
          headers,
          data: payload,
        });
        if (res.ok()) {
          logInfo('Adresse membre Deciplus via API', {
            member_id: memberId,
            method,
            status: res.status(),
            client: headers['Deciplus-Client-Type'],
          });
          updated = true;
          break;
        }
        if (res.status() === 404) {
          logInfo('API adresse membre absente (404) — fiche UI suffisante', {
            member_id: memberId,
            method,
            client: headers['Deciplus-Client-Type'],
          });
          continue;
        }
        logWarn('API adresse membre refusée', {
          member_id: memberId,
          method,
          status: res.status(),
          client: headers['Deciplus-Client-Type'],
        });
      } catch (err) {
        logWarn('API adresse membre erreur', { member_id: memberId, method, error: err.message });
      }
    }
    if (updated) break;
  }

  if (!updated) return false;

  const member = await fetchMemberViaApi(page, memberId);
  const ok = addressMatchesMember(member, addr);
  if (ok) {
    logInfo('Adresse membre Deciplus confirmée (API write)', {
      member_id: memberId,
      postal_code: addr.postal_code,
    });
  }
  return ok;
}

async function ribBlockerStillPresent(page, memberId) {
  await closeGreyboxIfOpen(page);
  const ribCtx = await openRibForm(page, memberId, { forceFresh: true });
  const blocked = await hasPostalAddressBlocker(ribCtx);
  await closeGreyboxIfOpen(page);
  return blocked;
}

async function saveMemberAddressViaUi(page, memberId, addr) {
  await closeGreyboxIfOpen(page);
  await openMemberDetail(page, memberId);
  await dismissJqueryUiOverlay(page).catch(() => {});

  // nextgen charge joueurs.php dans un iframe _vue_iframe — attendre le vrai formulaire
  const ctx = await getMemberFormContext(page, { waitMs: 20000 });
  await ctx.locator('input[name="adr1"], input[name="nom"], input[name="prenom"]').first().waitFor({
    state: 'attached',
    timeout: 15000,
  }).catch(() => {});

  const filled = {
    address: await fillFormField(ctx, 'input[name="adr1"]', addr.address),
    postal: await fillFormField(ctx, 'input[name="codepostal"]', addr.postal_code),
    city: await fillFormField(ctx, 'input[name="ville"]', addr.city),
    country: await fillFormField(ctx, 'input[name="pays"], select[name="pays"]', addr.country || 'France'),
  };
  logInfo('Champs adresse UI remplis', { member_id: memberId, filled });

  if (!filled.address || !filled.postal || !filled.city) {
    logWarn('Champs adresse introuvables sur joueurs.php', { member_id: memberId, filled });
    return false;
  }

  await pinFrenchCoordinates(ctx);

  await ctx.evaluate(() => {
    const form = document.querySelector('form[name="db1_form"]');
    if (!form) return;
    const submit = form.querySelector('input[name="alde_submit"]');
    if (submit) submit.value = 'valider';
    const demandeMaj = form.querySelector('input[name="demande_maj"]');
    if (demandeMaj) demandeMaj.value = '1';
  }).catch(() => {});

  await dismissJqueryUiOverlay(page).catch(() => {});
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
  await randomDelay(800, 1500);
  await dismissJqueryUiOverlay(page).catch(() => {});

  // Vérif UI (recharger fiche dans iframe)
  await openMemberDetail(page, memberId);
  await getMemberFormContext(page, { waitMs: 15000 });
  const savedUi = await readMemberAddressFromUi(page);
  const uiOk =
    String(savedUi.postal_code || '').replace(/\D/g, '') === String(addr.postal_code || '').replace(/\D/g, '') &&
    Boolean(savedUi.address) &&
    Boolean(savedUi.city);

  if (uiOk) {
    logInfo('Adresse membre Deciplus confirmée (UI)', {
      member_id: memberId,
      postal_code: savedUi.postal_code,
    });
    return true;
  }

  // Vérif API lecture (sans considérer ça comme un write réussi)
  const member = await fetchMemberViaApi(page, memberId);
  if (addressMatchesMember(member, addr)) {
    logInfo('Adresse membre Deciplus lue OK après UI (API GET)', {
      member_id: memberId,
      postal_code: addr.postal_code,
    });
    return true;
  }

  logWarn('Adresse membre Deciplus non confirmée après sauvegarde UI', {
    member_id: memberId,
    saved: savedUi,
    expected: addr,
  });
  return false;
}

async function ensureMemberPostalAddress(page, memberId, addr) {
  logInfo('Mise à jour adresse membre Deciplus', { member_id: memberId });
  await closeGreyboxIfOpen(page);

  // 1) Toujours sauver via joueurs.php (iframe nextgen)
  const uiOk = await saveMemberAddressViaUi(page, memberId, addr);

  // 2) Tentative API (souvent 404 sur cette install — best effort)
  const apiOk = await updateMemberAddressViaApi(page, memberId, addr);

  // 3) Le bandeau RIB peut rester affiché même si l'adresse est OK (faux positif Deciplus).
  //    On considère l'adresse prête si la fiche UI est OK, OU si le formulaire RIB a déjà
  //    adr_line1 + CP + ville préremplis (le serveur accepte alors le mandat en force-submit).
  const stillBlocked = await ribBlockerStillPresent(page, memberId);
  if (stillBlocked) {
    logWarn('Mandat SEPA bandeau adresse encore visible', { member_id: memberId, uiOk, apiOk });
    if (!uiOk) {
      await saveMemberAddressViaUi(page, memberId, addr);
    }
    const ribCtx = await openRibForm(page, memberId, { forceFresh: true });
    const mandateAddrOk = await ribMandateAddressReady(ribCtx);
    await closeGreyboxIfOpen(page);
    if (mandateAddrOk || uiOk) {
      logInfo('Adresse membre utilisable pour mandat SEPA (force-submit si besoin)', {
        member_id: memberId,
        uiOk,
        apiOk,
        mandateAddrOk,
      });
      return true;
    }
    return false;
  }

  logInfo('Adresse membre prête pour mandat SEPA', { member_id: memberId, uiOk, apiOk });
  return true;
}

async function ribContextHasForm(ctx) {
  try {
    return (await ctx.locator('input[name="iban"], input[name="bic"]').count()) > 0;
  } catch {
    return false;
  }
}

async function getRibFrame(page) {
  // Top page + iframes nextgen (check.php) : la greybox GB_frame est souvent imbriquée.
  const roots = [page, ...(page.frames?.() || [])];
  for (const root of roots) {
    try {
      const iframe = root.locator('#GB_frame, iframe[src*="rib.php"]').first();
      if ((await iframe.count()) > 0) {
        const handle = await iframe.elementHandle();
        const frame = handle ? await handle.contentFrame() : null;
        if (frame && (await ribContextHasForm(frame))) return frame;
      }
    } catch {
      /* frame détachée */
    }
  }
  for (const frame of page.frames()) {
    try {
      const url = frame.url() || '';
      if (!/rib\.php/i.test(url) && !/rib\.php/i.test(decodeURIComponent(url))) continue;
      if (await ribContextHasForm(frame)) return frame;
    } catch {
      /* */
    }
  }
  for (const ctx of [page, ...(page.frames?.() || [])]) {
    if (await ribContextHasForm(ctx)) return ctx;
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

  // IMPORTANT : ouvrir rib.php depuis joueurs.php (pas check.php).
  // Le callback Deciplus ne clique « Mettre à jour » (Rib-nok -> Rib-ok)
  // que si window.parent est joueurs.php?idj=...
  const ribOpenSelectors = [
    'a:has-text("Saisir le mandat")',
    'a:has-text("Saisir mandat")',
    'a:has-text("Saisir le mandat SEPA")',
    'button:has-text("SEPA")',
    'a[href*="rib.php"]',
    'img[title*="RIB" i]',
    'img[alt*="RIB" i]',
    '#icon-list [alt="Rib-nok"]',
    '.payments-mode-icon[alt="Rib-nok"]',
    'span[alt="Rib-nok"]',
  ].join(', ');

  await openMemberDetail(page, memberId).catch(() => {});
  if (await clickFirst(page, sel('member_detail.saisir_rib_button'))) {
    const frame = await waitForRibFrame(page, 10000);
    if (frame) return frame;
  }
  if (await clickFirst(page, ribOpenSelectors)) {
    const frame = await waitForRibFrame(page, 10000);
    if (frame) return frame;
  }
  for (const ctx of page.frames?.() || []) {
    if (!/joueurs\.php/i.test(ctx.url() || '')) continue;
    if (await clickFirst(ctx, ribOpenSelectors)) {
      const frame = await waitForRibFrame(page, 12000);
      if (frame) return frame;
    }
  }

  // Fallback check.php (greybox possible mais sans auto Mettre à jour)
  await openMemberCheck(page, memberId).catch(() => {});
  if (await clickFirst(page, sel('member_check.saisir_mandat_sepa'))) {
    const frame = await waitForRibFrame(page, 10000);
    if (frame) return frame;
  }
  if (await clickFirst(page, ribOpenSelectors)) {
    const frame = await waitForRibFrame(page, 10000);
    if (frame) return frame;
  }
  for (const ctx of page.frames?.() || []) {
    if (!/check\.php/i.test(ctx.url() || '')) continue;
    if (await clickFirst(ctx, ribOpenSelectors)) {
      const frame = await waitForRibFrame(page, 12000);
      if (frame) return frame;
    }
  }

  await page
    .goto(`${new URL(base).origin}/nextgen/legacy?path=${encodeURIComponent(`/rib.php?idj=${memberId}`)}`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    })
    .catch(() => {});
  await randomDelay();
  const wrapped = await waitForRibFrame(page, 8000);
  if (wrapped && (await ribContextHasForm(wrapped))) return wrapped;

  await page.goto(new URL(`rib.php?idj=${memberId}`, base).href, {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });
  await randomDelay();
  const direct = await waitForRibFrame(page, 8000);
  if (direct && (await ribContextHasForm(direct))) return direct;
  if (await ribContextHasForm(page)) return page;

  throw new Error(`Impossible d'ouvrir le formulaire RIB pour membre ${memberId}`);
}

/** Apres Valider rib.php : Deciplus attend souvent un « Mettre à jour » sur joueurs.php. */
async function finalizeRibParentMemberUpdate(page, memberId) {
  try {
    await closeGreyboxIfOpen(page);
    await openMemberDetail(page, memberId);
    const ctx = await getMemberFormContext(page, { waitMs: 12000 });
    await pinFrenchCoordinates(ctx);
    await ctx.evaluate(() => {
      const form = document.querySelector('form[name="db1_form"]');
      if (!form) return;
      const submit = form.querySelector('input[name="alde_submit"]');
      if (submit) submit.value = 'valider';
      const demandeMaj = form.querySelector('input[name="demande_maj"]');
      if (demandeMaj) demandeMaj.value = '1';
    }).catch(() => {});
    const clicked = await clickFirst(
      ctx,
      'input[type="submit"][value="Mettre à jour"], input.albut_dw[value="Mettre à jour"]',
      { force: true }
    );
    if (!clicked) {
      await ctx.evaluate(() => document.querySelector('form[name="db1_form"]')?.submit()).catch(() => {});
    }
    await randomDelay(800, 1400);
    logInfo('Fiche membre Mettre à jour après mandat SEPA', { member_id: memberId });
  } catch (err) {
    logWarn('Mettre à jour fiche après mandat ignore', {
      member_id: memberId,
      error: err.message,
    });
  }
}

async function clickReplaceMandate(ctx) {
  const clicked = await clickFirst(
    ctx,
    [
      'a:has-text("Remplacer le mandat")',
      'button:has-text("Remplacer le mandat")',
      'input[type="submit"][value*="Remplacer le mandat"]',
      'a:has-text("Nouveau mandat")',
      'button:has-text("Nouveau mandat")',
      'a:has-text("Régénérer le mandat")',
      'a:has-text("Regénérer le mandat")',
      'a:has-text("Régénérer ce mandat")',
      'a:has-text("Regénérer ce mandat")',
      'span:has-text("Régénérer ce mandat")',
      'span:has-text("Regénérer ce mandat")',
      'span:has-text("Remplacer ce mandat")',
      'input[value*="nouveau mandat" i]',
    ].join(', ')
  );
  if (clicked) return true;
  return ctx
    .evaluate(() => {
      const nodes = [...document.querySelectorAll('a, button, input, span, u, b')];
      const prefer = [
        /r[eé]g[eé]n[eé]rer ce mandat/i,
        /remplacer ce mandat/i,
        /remplacer le mandat|nouveau mandat|r[eé]g[eé]n[eé]rer le mandat/i,
      ];
      for (const re of prefer) {
        const el = nodes.find((n) =>
          re.test(`${n.textContent || ''} ${n.value || ''}`)
        );
        if (!el) continue;
        el.click();
        return true;
      }
      return false;
    })
    .catch(() => false);
}

async function postCurrentRibForm(ctx) {
  return ctx
    .evaluate(async () => {
      const form = document.querySelector('form');
      if (!form) return { ok: false, error: 'formulaire absent' };
      form.querySelectorAll('input, select, textarea, button').forEach((el) => {
        el.disabled = false;
        if ('readOnly' in el) el.readOnly = false;
      });
      const submit = form.querySelector('input[name="alde_submit"]');
      if (submit) submit.value = 'valider';
      const cb = form.querySelector('input[type="checkbox"]');
      if (cb) cb.checked = true;
      const body = new URLSearchParams();
      form.querySelectorAll('input, select, textarea').forEach((el) => {
        if (!el.name) return;
        if ((el.type === 'checkbox' || el.type === 'radio') && !el.checked) return;
        body.append(el.name, el.value);
      });
      if (!body.has('alde_submit')) body.append('alde_submit', 'valider');
      const action = form.action || location.href;
      const res = await fetch(action, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        credentials: 'include',
      });
      const text = await res.text();
      const flat = text.replace(/\s+/g, ' ').slice(0, 240);
      const rejected = /adresse postale est obligatoire|iban invalide/i.test(text);
      return { ok: res.ok && !rejected, status: res.status, snippet: flat };
    })
    .catch((err) => ({ ok: false, error: err.message }));
}

async function fillRibForm(ctx, iban, customer, gymConfig) {
  const value = normalizeIban(iban);
  const addr = ribAddressFields(customer, gymConfig);

  // Débloquer avant fill si Deciplus a disabled les champs
  await unlockRibFormForSubmit(ctx);

  await fillFirst(ctx, sel('rib_form.iban'), value);
  // Fallback direct si sélecteur config rate
  if (!(await readIbanFromRib(ctx))) {
    await fillFormField(ctx, 'input[name="iban"]', value);
  }

  const titulaire = [customer.first_name, customer.last_name].filter(Boolean).join(' ').trim();
  if (titulaire) {
    await fillFirst(ctx, sel('rib_form.account_holder'), titulaire.toUpperCase());
    await fillFormField(ctx, 'input[name="nom"]', titulaire.toUpperCase());
  }

  await fillFirst(ctx, sel('rib_form.address'), addr.address);
  await fillFormField(ctx, 'input[name="adr_line1"]', addr.address);
  const line2 = String(customer.address2 || customer.adresse2 || '').trim();
  await fillFirst(ctx, sel('rib_form.address2'), line2);
  await fillFormField(ctx, 'input[name="adr_line2"]', line2);
  await fillFirst(ctx, sel('rib_form.city'), addr.city.toUpperCase());
  await fillFormField(ctx, 'input[name="adr_town"]', addr.city.toUpperCase());
  await fillFirst(ctx, sel('rib_form.zip'), addr.postal_code);
  await fillFormField(ctx, 'input[name="adr_postcode"]', addr.postal_code);
  await fillFirst(ctx, sel('rib_form.country'), addr.country);
  await fillFormField(ctx, 'input[name="adr_country"]', addr.country || 'France');
  await pinFrenchCoordinates(ctx);

  const ibanEl = ctx.locator('input[name="iban"]').first();
  if ((await ibanEl.count()) > 0) {
    await ibanEl
      .evaluate((el, v) => {
        el.disabled = false;
        el.readOnly = false;
        el.value = v;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('blur', { bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
        if (typeof window.jQuery === 'function') {
          window.jQuery(el).trigger('input').trigger('change').trigger('blur');
        }
      }, value)
      .catch(() => {});
  }

  // Laisser Deciplus résoudre le BIC (lookup agence) avant de poster.
  const deadline = Date.now() + 3500;
  let bic = '';
  while (Date.now() < deadline) {
    bic = String((await ctx.locator('input[name="bic"]').first().inputValue().catch(() => '')) || '')
      .replace(/\s+/g, '')
      .toUpperCase();
    if (isLikelyBic(bic)) break;
    await ctx.waitForTimeout(200).catch(() => {});
  }
  if (!isLikelyBic(bic)) bic = bicFromFrenchIban(value);
  if (isLikelyBic(bic)) {
    await fillFirst(ctx, sel('rib_form.bic'), bic);
    await fillFormField(ctx, 'input[name="bic"]', bic);
  } else {
    logWarn('BIC mandat introuvable après saisie IBAN', {
      bank: value.slice(4, 9),
    });
  }

  const dateEl = ctx.locator('input[name="date_mandat"]').first();
  if ((await dateEl.count()) > 0) {
    const currentDate = String((await dateEl.inputValue().catch(() => '')) || '').trim();
    if (!currentDate) {
      const now = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const today = `${pad(now.getDate())}/${pad(now.getMonth() + 1)}/${now.getFullYear()}`;
      await fillFormField(ctx, 'input[name="date_mandat"]', today);
    }
  }

  // Deciplus garde parfois un ancien n° de compte RIB incompatible avec l'IBAN saisi.
  const parts = frenchIbanToRibParts(value);
  if (parts) {
    if (isLikelyBic(bic)) parts.bic = bic;
    await ctx
      .evaluate((p) => {
        const form = document.querySelector('form');
        if (!form) return;
        const set = (name, val) => {
          if (!val) return;
          let el = form.querySelector(`input[name="${name}"]`);
          if (!el) {
            el = document.createElement('input');
            el.type = 'hidden';
            el.name = name;
            form.appendChild(el);
          }
          el.disabled = false;
          el.readOnly = false;
          el.value = val;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        };
        set('iban', p.iban);
        set('etablissement', p.etablissement);
        set('guichet', p.guichet);
        set('numero', p.numero);
        set('cle', p.cle);
        set('bic', p.bic);
      }, parts)
      .catch(() => {});
  }
}

async function prepareRibSubmit(ctx) {
  await unlockRibFormForSubmit(ctx);
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
  const clicked = await clickFirst(ctx, sel('rib_form.save'), { force: true });
  if (!clicked) {
    await ctx.evaluate(() => {
      const form = document.querySelector('form');
      if (form) form.submit();
    });
  }
  await randomDelay(800, 1500);
}

async function submitAndFinalizeRib(page, memberId, ribCtx, iban, customer, gymConfig) {
  await fillRibForm(ribCtx, iban, customer, gymConfig);
  const before = await readMandateMeta(ribCtx);
  if (!isLikelyBic(before.bic)) {
    const fallback = bicFromFrenchIban(iban);
    if (isLikelyBic(fallback)) {
      await ribCtx
        .evaluate((bic) => {
          const form = document.querySelector('form');
          if (!form) return;
          let el = form.querySelector('input[name="bic"]');
          if (!el) {
            el = document.createElement('input');
            el.type = 'hidden';
            el.name = 'bic';
            form.appendChild(el);
          }
          el.disabled = false;
          el.value = bic;
        }, fallback)
        .catch(() => {});
    }
  }
  const afterFill = await readMandateMeta(ribCtx);
  if (!isLikelyBic(afterFill.bic)) {
    logWarn('Mandat SEPA sans BIC — pas de POST', { member_id: memberId });
    return { ok: false, error: 'bic_missing' };
  }
  await submitRibForm(ribCtx, page);
  const posted = await postCurrentRibForm(ribCtx);
  await finalizeRibParentMemberUpdate(page, memberId);
  return posted;
}

async function readMandateMeta(ctx) {
  return ctx
    .evaluate(() => ({
      iban: document.querySelector('input[name="iban"]')?.value || '',
      bic: document.querySelector('input[name="bic"]')?.value || '',
      rum: document.querySelector('input[name="rum"]')?.value || '',
      date_mandat: document.querySelector('input[name="date_mandat"]')?.value || '',
      etablissement: document.querySelector('input[name="etablissement"]')?.value || '',
      numero: document.querySelector('input[name="numero"]')?.value || '',
    }))
    .catch(() => ({ iban: '', bic: '', rum: '', date_mandat: '' }));
}

async function verifyIbanOnMandate(page, memberId, expectedIban) {
  const ribCtx = await openRibForm(page, memberId, { forceFresh: true });
  const saved = await readIbanFromRib(ribCtx);
  const meta = await readMandateMeta(ribCtx);
  const needsSave = await ribMandateNeedsSave(ribCtx).catch(() => false);
  const expected = normalizeIban(expectedIban);
  const ibanMatch =
    saved === expected ||
    (saved && expected && saved.startsWith(expected.slice(0, 20)));
  if (!isLikelyBic(meta.bic)) {
    logWarn('Mandat sans BIC — RIB considéré incomplet', {
      member_id: memberId,
      rum: meta.rum || null,
    });
    await closeGreyboxIfOpen(page);
    return false;
  }
  // Mandat créé (RUM) même si l'IBAN affiché est tronqué / reformaté
  const rumLooksOk =
    Boolean(meta.rum) &&
    (ibanMatch ||
      normalizeIban(meta.iban).startsWith(expected.slice(0, 20)) ||
      (saved && normalizeIban(saved).includes(expected.slice(4, 14))));
  if (!ibanMatch && !rumLooksOk) return false;

  await closeGreyboxIfOpen(page);
  // Source de vérité : bandeau fiche (check.php + joueurs.php), pas Valider grisé.
  if (!(await ficheRibCleared(page, memberId, {}))) {
    logWarn('RUM présent mais fiche demande encore le RIB', {
      member_id: memberId,
      rum: meta.rum,
      needs_save: needsSave,
    });
    return false;
  }
  if (needsSave) {
    logWarn('Valider grisé mais fiche sans alerte RIB — considéré OK', {
      member_id: memberId,
      rum: meta.rum,
    });
  } else if (!ibanMatch && rumLooksOk) {
    logWarn('IBAN mandat partiellement affiché — RUM présent et fiche sans alerte RIB', {
      member_id: memberId,
      rum: meta.rum,
      saved: meta.iban,
    });
  }
  return true;
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

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const ribCtx = await openRibForm(page, memberId, { forceFresh: true });
    const existingMeta = await readMandateMeta(ribCtx);
    const existingIban = normalizeIban(existingMeta.iban);
    const ibanAlready =
      existingIban === value ||
      (existingIban && value && existingIban.startsWith(value.slice(0, 20)));
    const needsSave = await ribMandateNeedsSave(ribCtx);
    let ficheAsks = false;
    if (existingMeta.rum && ibanAlready && isLikelyBic(existingMeta.bic) && !needsSave) {
      await closeGreyboxIfOpen(page);
      // check.php seul ne suffit pas : l alerte est souvent sur joueurs.php.
      if (await ficheRibCleared(page, memberId, gymConfig)) {
        logInfo('IBAN déjà enregistré sur le mandat Deciplus', {
          member_id: memberId,
          rum: existingMeta.rum || null,
        });
        return true;
      }
      ficheAsks = true;
      logWarn('Fiche demande encore d enregistrer le RIB — validation SEPA relancée', {
        member_id: memberId,
        rum: existingMeta.rum || null,
        attempt,
      });
    }
    // RUM + IBAN OK mais Valider encore grisé : la fiche (pas le bouton) décide.
    if (existingMeta.rum && ibanAlready && isLikelyBic(existingMeta.bic) && needsSave && !ficheAsks) {
      await closeGreyboxIfOpen(page);
      if (await ficheRibCleared(page, memberId, gymConfig)) {
        logInfo('IBAN + RUM OK — Valider grisé ignoré (fiche sans alerte)', {
          member_id: memberId,
          rum: existingMeta.rum || null,
        });
        return true;
      }
      ficheAsks = true;
    }
    if (ibanAlready && (needsSave || ficheAsks)) {
      logWarn('RIB visible mais mandat non enregistré — adresse + Valider', {
        member_id: memberId,
        rum: existingMeta.rum || null,
        attempt,
      });
      // Alerte Rib-nok avec mandat fantôme : revalider ; si échec, régénérer le RUM.
      if (ficheAsks) {
        await ensureMemberPostalAddress(page, memberId, addr);
        let formCtx = await openRibForm(page, memberId, { forceFresh: true });
        // N° compte RIB désynchronisé de l'IBAN -> régénérer avant Valider.
        const staleRib = await formCtx
          .evaluate((expectedIban) => {
            const iban = String(
              document.querySelector('input[name="iban"]')?.value || ''
            )
              .replace(/\s+/g, '')
              .toUpperCase();
            const numero = String(document.querySelector('input[name="numero"]')?.value || '');
            const want = String(expectedIban || '')
              .replace(/\s+/g, '')
              .toUpperCase();
            if (!/^FR\d{25}$/.test(want) || !numero) return false;
            return numero !== want.slice(14, 25);
          }, value)
          .catch(() => false);
        if (staleRib || attempt >= 2) {
          const regenerated = await clickReplaceMandate(formCtx);
          logWarn('Mandat SEPA régénéré (Rib-nok bloqué)', {
            member_id: memberId,
            stale_rib: Boolean(staleRib),
            regenerated: Boolean(regenerated),
            attempt,
          });
          await closeGreyboxIfOpen(page);
          await randomDelay(500, 900);
          formCtx = await openRibForm(page, memberId, { forceFresh: true });
        }
        const posted = await submitAndFinalizeRib(page, memberId, formCtx, value, customer, gymConfig);
        await closeGreyboxIfOpen(page);
        const ribCheck = await openRibForm(page, memberId, { forceFresh: true });
        const afterNeed = await ribMandateNeedsSave(ribCheck);
        const after = await readMandateMeta(ribCheck);
        await closeGreyboxIfOpen(page);
        if (after.rum && (await ficheRibCleared(page, memberId, gymConfig))) {
          logInfo('RIB validé sur le mandat Deciplus', {
            member_id: memberId,
            rum: after.rum,
            post_ok: Boolean(posted?.ok),
            needs_save: afterNeed,
          });
          return true;
        }
        logWarn('Valider RIB encore bloqué après soumission', {
          member_id: memberId,
          post_ok: posted?.ok || false,
          needs_save: afterNeed,
          attempt,
        });
        continue;
      }
      const formCtx = ribCtx;
      const posted = await submitAndFinalizeRib(page, memberId, formCtx, value, customer, gymConfig);
      await closeGreyboxIfOpen(page);
      const ribCheck = await openRibForm(page, memberId, { forceFresh: true });
      const afterNeed = await ribMandateNeedsSave(ribCheck);
      const after = await readMandateMeta(ribCheck);
      await closeGreyboxIfOpen(page);
      if (after.rum && (await ficheRibCleared(page, memberId, gymConfig))) {
        logInfo('RIB validé sur le mandat Deciplus', {
          member_id: memberId,
          rum: after.rum,
          post_ok: Boolean(posted?.ok),
          needs_save: afterNeed,
        });
        return true;
      }
      logWarn('Valider RIB encore bloqué après soumission', {
        member_id: memberId,
        post_ok: posted?.ok || false,
        needs_save: afterNeed,
        attempt,
      });
      continue;
    }
    if (ibanAlready && !existingMeta.rum) {
      logInfo('IBAN saisi mais mandat non validé — enregistrement', {
        member_id: memberId,
        attempt,
      });
      await submitAndFinalizeRib(page, memberId, ribCtx, value, customer, gymConfig);
      await closeGreyboxIfOpen(page);
      const ribCheck = await openRibForm(page, memberId, { forceFresh: true });
      const after = await readMandateMeta(ribCheck);
      const afterNeed = await ribMandateNeedsSave(ribCheck);
      await closeGreyboxIfOpen(page);
      // RUM seul = insuffisant : la fiche doit perdre l icone Rib-nok.
      // Valider grisé (afterNeed) n empêche pas le succès si l alerte a disparu.
      if (after.rum && (await ficheRibCleared(page, memberId, gymConfig))) {
        logInfo('RIB validé sur le mandat Deciplus', {
          member_id: memberId,
          rum: after.rum,
          needs_save: afterNeed,
        });
        return true;
      }
      continue;
    }

    // Ancien mandat (souvent 0 échéance / IBAN différent) : Deciplus refuse l’édition.
    if (existingMeta.rum && existingIban !== value) {
      const replaced = await clickReplaceMandate(ribCtx);
      if (replaced) {
        logInfo('Mandat SEPA existant — remplacement demandé', {
          member_id: memberId,
          attempt,
        });
        await closeGreyboxIfOpen(page);
        await randomDelay(400, 800);
        continue;
      }
    }

    await fillRibForm(ribCtx, value, customer, gymConfig);

    const blocked = await hasPostalAddressBlocker(ribCtx);
    const mandateAddrOk = await ribMandateAddressReady(ribCtx);
    if (blocked && !mandateAddrOk) {
      logWarn('Blocage adresse postale Deciplus sur mandat — resauvegarde fiche membre', {
        member_id: memberId,
        attempt,
      });
      await closeGreyboxIfOpen(page);
      await ensureMemberPostalAddress(page, memberId, addr);
      continue;
    }
    if (blocked && mandateAddrOk) {
      logWarn('Bandeau adresse Deciplus ignoré — adresse mandat présente, force-submit', {
        member_id: memberId,
        attempt,
      });
    }

    const filledMeta = await readMandateMeta(ribCtx);
    if (!isLikelyBic(filledMeta.bic)) {
      logWarn('Mandat SEPA sans BIC après remplissage — nouvel essai', {
        member_id: memberId,
        attempt,
      });
      await closeGreyboxIfOpen(page);
      continue;
    }

    await submitRibForm(ribCtx, page);
    await finalizeRibParentMemberUpdate(page, memberId);
    await closeGreyboxIfOpen(page);

    const saved = await verifyIbanOnMandate(page, memberId, value);
    await closeGreyboxIfOpen(page);
    if (saved) {
      if (await ficheRibCleared(page, memberId, gymConfig)) {
        logInfo('RIB saisi sur fiche membre', { member_id: memberId, attempt });
        return true;
      }
      logWarn('verifyIban OK mais alerte RIB encore visible — nouvel essai', {
        member_id: memberId,
        attempt,
      });
    }

    logWarn('IBAN non confirmé après soumission mandat', { member_id: memberId, attempt });
    const ribAgain = await openRibForm(page, memberId, { forceFresh: true });
    const posted = await submitAndFinalizeRib(page, memberId, ribAgain, value, customer, gymConfig);
    await closeGreyboxIfOpen(page);
    const savedAfterPost = await verifyIbanOnMandate(page, memberId, value);
    await closeGreyboxIfOpen(page);
    if (savedAfterPost) {
      if (await ficheRibCleared(page, memberId, gymConfig)) {
        logInfo('RIB saisi sur fiche membre (POST mandat)', { member_id: memberId, attempt });
        return true;
      }
      logWarn('POST mandat OK mais alerte RIB encore visible', { member_id: memberId, attempt });
    } else {
      logWarn('POST mandat SEPA non confirmé', {
        member_id: memberId,
        attempt,
        status: posted?.status || null,
        error: posted?.error || null,
      });
    }
    await ensureMemberPostalAddress(page, memberId, addr);
  }

  // Dernière lecture : check.php + joueurs.php sans bandeau + IBAN confirmé.
  await closeGreyboxIfOpen(page);
  if (await ficheRibCleared(page, memberId, gymConfig)) {
    const finalOk = await verifyIbanOnMandate(page, memberId, value).catch(() => false);
    if (finalOk) {
      logInfo('RIB finalement OK sur fiche (alerte disparue)', { member_id: memberId });
      return true;
    }
  }

  throw new Error(
    'RIB Deciplus: échec enregistrement IBAN — la fiche demande encore d enregistrer le RIB'
  );
}

module.exports = {
  openMemberDetail,
  openMemberCheck,
  setMemberIban,
  openRibForm,
  fillRibForm,
  submitRibForm,
  postCurrentRibForm,
  hasPostalAddressBlocker,
  ribMandateNeedsSave,
  memberAsksToRegisterRib,
  ficheRibCleared,
  cardFingerprintFromPayplug,
  getRibFrame,
  ribAddressFields,
  ensureMemberPostalAddress,
  clickFirst,
  fillFirst,
  sel,
  closeGreyboxIfOpen,
};
