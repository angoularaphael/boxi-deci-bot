/**
 * Résiliation Deciplus — abo + badge.
 * Flux exact (pas « Annuler la vente ») :
 *   fiche → Consulter contrat → Résilier
 *   → date de résiliation = aujourd'hui
 *   → motif « Ne souhaite pas reconduire »
 *   → Appliquer et Quitter
 *   → cocher « Envoyer un mail de résiliation »
 *   → Confirmer
 */
const { randomDelay } = require('../lib/utils');
const { logInfo, logWarn } = require('../lib/logger');
const { openMemberCheck, closeGreyboxIfOpen } = require('./wallet');

function deciplusBase() {
  return (process.env.DECIPLUS_URL || 'https://boxingcenter.deciplus.pro/').replace(/\/?$/, '/');
}

function contractUrl(idc) {
  return new URL(`nextgen/contract?idc=${idc}`, deciplusBase()).href;
}

function formatFrDate(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

function parseFrDatesFromLabel(label) {
  return (String(label || '').match(/\d{2}\/\d{2}\/\d{4}/g) || []).map((s) => {
    const [d, m, y] = s.split('/').map(Number);
    return new Date(y, m - 1, d);
  });
}

/** Date de début réelle : après « vendu le JJ/MM/AAAA », le 2e date est le début. */
function contractStartDate(label) {
  const dates = parseFrDatesFromLabel(label);
  if (!dates.length) return null;
  if (/vendu le/i.test(String(label || '')) && dates.length >= 2) return dates[1];
  return dates[0];
}

function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Contrats « en attente » / qui commencent après aujourd’hui — pas l’abo en cours. */
function isPendingOrFutureContract(label) {
  const t = String(label || '');
  if (/en attente/i.test(t)) return true;
  const start = contractStartDate(t);
  if (!start) return false;
  return startOfDay(start).getTime() > startOfDay(new Date()).getTime();
}

/** Vendu / début aujourd’hui. On résilie : Annuler la vente n’existe plus dans ce flux. */
function isSameDayStartContract(label, now = new Date()) {
  const start = contractStartDate(label);
  if (!start) return false;
  return startOfDay(start).getTime() === startOfDay(now).getTime();
}

function isAppliquerQuitterLabel(text) {
  const t = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t || t.length > 48) return false;
  if (/^appliquer et (quitter|fermer)$/i.test(t)) return true;
  if (/^appliquer$/i.test(t)) return true;
  return /appliquer/i.test(t) && /quitter|fermer/i.test(t);
}

function normalizeUiText(text) {
  return String(text || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Tuile d’action « Résilier », pas le bouton mail ni « Annuler la vente ». Autonome (injectée dans la page). */
function isResilierTileLabel(text) {
  const raw = String(text || '').replace(/\u00a0/g, ' ');
  const flat = raw.replace(/\s+/g, ' ').trim();
  if (!flat || flat.length > 48) return false;
  if (/annuler la vente/i.test(flat)) return false;
  if (/mail|e-?mail|envoyer/i.test(flat)) return false;
  if (/^r[ée]silier$/i.test(flat) || /^r[ée]siliation$/i.test(flat)) return true;
  const first = raw
    .split(/\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .find(Boolean);
  if (first && (/^r[ée]silier$/i.test(first) || /^r[ée]siliation$/i.test(first))) return true;
  if (/^r[ée]silier le contrat$/i.test(flat)) return true;
  if (/^r[ée]silier l['’]abonnement$/i.test(flat)) return true;
  return false;
}

/** « Choisir », vide ou une date = le motif n’est pas choisi. */
function motifValueChosen(value) {
  const t = normalizeUiText(value);
  if (!t) return false;
  if (/^choisir$/i.test(t)) return false;
  if (/^\d{1,2}\D+\d{1,2}\D+\d{2,4}$/.test(t)) return false;
  if (/sélectionnez|selectionnez|obligatoire|motif de résiliation/i.test(t)) return false;
  return t.length >= 3;
}

/**
 * Mail absent = succès seulement si Appliquer était actif et la modale
 * « Êtes-vous certain » a été confirmée. Un clic forcé sur un bouton
 * désactivé ne résilie pas.
 */
function resiliationCountsAsDone({ applyEnabled = false, confirmSeen = false } = {}) {
  return Boolean(applyEnabled && confirmSeen);
}

function parseCancelDate(raw) {
  if (!raw) return new Date();
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) return raw;
  const s = String(raw).trim();
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
  const fr = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
  if (fr) return new Date(Number(fr[3]), Number(fr[2]) - 1, Number(fr[1]));
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

function getScopes(page) {
  const scopes = [page, ...(page.frames?.() || [])];
  const seen = new Set();
  return scopes.filter((ctx) => {
    const key = ctx.url?.() || String(ctx);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Liste les contrats actifs via #prestation_XXXX (structure Deciplus réelle).
 */
async function revealHiddenContracts(page) {
  for (const ctx of getScopes(page)) {
    try {
      const toggled = await ctx
        .evaluate(() => {
          const labels = [...document.querySelectorAll('label, span, div')];
          const hit = labels.find((el) =>
            /masquer les contrats inactifs/i.test(String(el.textContent || ''))
          );
          if (!hit) return false;
          const row = hit.closest('label, div, tr, p') || hit.parentElement;
          const input =
            row?.querySelector('input[type="checkbox"]') ||
            hit.previousElementSibling?.querySelector?.('input[type="checkbox"]') ||
            hit.parentElement?.querySelector('input[type="checkbox"]');
          if (!input || input.type !== 'checkbox') return false;
          if (input.checked) {
            input.click();
            return true;
          }
          return false;
        })
        .catch(() => false);
      if (toggled) await page.waitForTimeout(500);
    } catch {
      /* frame */
    }
  }
}

async function expandContractSections(page) {
  await revealHiddenContracts(page);
  for (const ctx of getScopes(page)) {
    try {
      await ctx
        .evaluate(() => {
          const nodes = [...document.querySelectorAll('div, span, a, button, h2, h3, p, label, strong')];
          for (const el of nodes) {
            const t = String(el.textContent || '')
              .replace(/\s+/g, ' ')
              .trim();
            if (!t || t.length > 40) continue;
            if (/\d+\s*en attente/i.test(t) || /^en attente$/i.test(t)) {
              el.click();
            }
          }
        })
        .catch(() => {});
    } catch {
      /* frame */
    }
  }
  await page.waitForTimeout(800);
}

async function findActiveContracts(page, options = {}) {
  await expandContractSections(page);
  for (let attempt = 0; attempt < 12; attempt += 1) {
    let ready = false;
    for (const ctx of getScopes(page)) {
      try {
        if ((await ctx.locator('div.og-product-item[id^="prestation_"]').count()) > 0) {
          ready = true;
          break;
        }
      } catch {
        /* ignore */
      }
    }
    if (ready) break;
    await page.waitForTimeout(500);
  }

  for (const ctx of getScopes(page)) {
    try {
      await ctx
        .evaluate(() => {
          window.scrollTo(0, document.body.scrollHeight / 2);
        })
        .catch(() => {});
    } catch {
      /* ignore */
    }
  }
  await page.waitForTimeout(600);

  const found = [];
  const seen = new Set();

  for (const ctx of getScopes(page)) {
    try {
      const items = ctx.locator('div.og-product-item[id^="prestation_"]');
      const count = await items.count();
      for (let i = 0; i < count; i += 1) {
        const item = items.nth(i);
        const idAttr = (await item.getAttribute('id').catch(() => '')) || '';
        const idc = (idAttr.match(/prestation_(\d+)/i) || [])[1];
        if (!idc || seen.has(idc)) continue;

        const itemLabel = (
          (await item.innerText().catch(() => '')) ||
          (await item.evaluate((el) => (el.textContent || '').replace(/\s+/g, ' ').trim()).catch(() => '')) ||
          ''
        )
          .replace(/\s+/g, ' ')
          .trim();
        const wrapper = item.locator('xpath=ancestor::div[contains(@class,"og-product-wrapper")][1]');
        const wrapperLabel = ((await wrapper.innerText().catch(() => '')) || '')
          .replace(/\s+/g, ' ')
          .trim();
        // Ne pas juger « annulé » sur le bandeau « 1 ANNULÉ, 1 ACTIF, 2 EN ATTENTE »
        // sinon on ignore les vrais contrats en attente.
        const statusLabel = itemLabel || wrapperLabel;
        const { isStaleOrInactiveAbo } = require('../lib/replace-existing-abo');
        const summaryOnly = /\d+\s+annul/i.test(statusLabel) && !/contrat n/i.test(statusLabel);
        const expiredPrestation =
          options.includeExpiredPrestation &&
          /essai|coaching/i.test(`${itemLabel} ${wrapperLabel}`) &&
          /expir/i.test(`${itemLabel} ${wrapperLabel}`) &&
          !/r[eéÉ]sili|annul/i.test(`${itemLabel} ${wrapperLabel}`);
        if (
          !expiredPrestation &&
          !summaryOnly &&
          isStaleOrInactiveAbo(`${itemLabel} ${wrapperLabel}`)
        ) {
          continue;
        }
        const pendingHint = isPendingOrFutureContract(itemLabel);
        const label = `${itemLabel || wrapperLabel.slice(0, 120)}${
          pendingHint && !/en attente/i.test(itemLabel) ? ' EN ATTENTE' : ''
        }`;
        if (!label.trim()) continue;

        let consulter = item
          .locator('xpath=ancestor::div[contains(@class,"og-product-wrapper")][1]')
          .locator('input[value="Consulter"], button:has-text("Consulter")')
          .first();
        if ((await consulter.count()) === 0) {
          consulter = item
            .locator('xpath=ancestor::tr[1]/following::tr[1]//input[@value="Consulter"]')
            .first();
        }
        if ((await consulter.count()) === 0) {
          consulter = item.locator('xpath=ancestor::table[1]//input[@value="Consulter"]').first();
        }

        seen.add(idc);
        found.push({
          ctx,
          item,
          consulter: (await consulter.count()) > 0 ? consulter : null,
          idc,
          label: label.slice(0, 160) || `prestation_${idc}`,
          isBadge:
            (/\bbadge\b/i.test(label) && !/essai|coaching/i.test(label)) ||
            (/pr[ée]-?d[ée]compt/i.test(label) &&
              /0 cr[ée]dit restant/i.test(label) &&
              !/essai|coaching|offre duo|abonnement|12\s*mois|259/i.test(label)),
        });
      }
    } catch {
      /* frame détachée */
    }
  }

  if (!found.length) {
    for (const ctx of getScopes(page)) {
      try {
        const rows = await ctx
          .evaluate(() =>
            [...document.querySelectorAll('[id^="prestation_"]')].map((el) => ({
              idc: (String(el.id || '').match(/prestation_(\d+)/i) || [])[1] || '',
              label: String(el.textContent || '')
                .replace(/\s+/g, ' ')
                .trim(),
            }))
          )
          .catch(() => []);
        for (const row of rows) {
          const idc = String(row.idc || '').trim();
          const label = String(row.label || '').trim();
          if (!idc || seen.has(idc) || !label) continue;
          const { isStaleOrInactiveAbo } = require('../lib/replace-existing-abo');
          if (isStaleOrInactiveAbo(label)) {
            continue;
          }
          seen.add(idc);
          found.push({
            ctx,
            item: null,
            consulter: null,
            idc,
            label: label.slice(0, 160),
            isBadge:
              (/\bbadge\b/i.test(label) && !/essai|coaching/i.test(label)) ||
              (/pr[ée]-?d[ée]compt/i.test(label) &&
                /0 cr[ée]dit restant/i.test(label) &&
                !/essai|coaching|offre duo|abonnement|12\s*mois|259/i.test(label)),
          });
        }
      } catch {
        /* frame */
      }
    }
  }

  found.sort((a, b) => Number(a.isBadge) - Number(b.isBadge));

  // 2e passe : section « N EN ATTENTE » parfois rendue après le clic.
  await page.waitForTimeout(400);
  for (const ctx of getScopes(page)) {
    try {
      const rows = await ctx
        .evaluate(() =>
          [...document.querySelectorAll('[id^="prestation_"], a[href*="idc="]')].map((el) => {
            const idc =
              (String(el.id || '').match(/prestation_(\d+)/i) || [])[1] ||
              (String(el.getAttribute('href') || '').match(/[?&]idc=(\d+)/i) || [])[1] ||
              '';
            const wrap = el.closest('.og-product-wrapper, .og-product-item, li, tr, article') || el;
            return {
              idc,
              label: String(wrap.textContent || '')
                .replace(/\s+/g, ' ')
                .trim(),
            };
          })
        )
        .catch(() => []);
      for (const row of rows) {
        const idc = String(row.idc || '').trim();
        const label = String(row.label || '').trim();
        if (!idc || seen.has(idc) || !label) continue;
        const { isStaleOrInactiveAbo } = require('../lib/replace-existing-abo');
        const expiredPrestation =
          options.includeExpiredPrestation &&
          /essai|coaching/i.test(label) &&
          /expir/i.test(label) &&
          !/r[eéÉ]sili|annul/i.test(label);
        if (!expiredPrestation && isStaleOrInactiveAbo(label)) continue;
        seen.add(idc);
        found.push({
          ctx,
          item: null,
          consulter: null,
          idc,
          label: label.slice(0, 160),
          isBadge:
            (/\bbadge\b/i.test(label) && !/essai|coaching/i.test(label)) ||
            (/pr[ée]-?d[ée]compt/i.test(label) &&
              /0 cr[ée]dit restant/i.test(label) &&
              !/essai|coaching|offre duo|abonnement|12\s*mois|259/i.test(label)),
        });
      }
    } catch {
      /* frame */
    }
  }

  found.sort((a, b) => Number(a.isBadge) - Number(b.isBadge));
  return found;
}

async function openContractPage(page, contract) {
  const target = contractUrl(contract.idc);
  logInfo('Ouverture contrat Deciplus', {
    idc: contract.idc,
    url: target,
    label: contract.label?.slice(0, 80),
  });

  await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  await randomDelay(700, 1100);

  if (/nextgen\/contract|contract\?idc=/i.test(page.url())) {
    return true;
  }

  if (contract.consulter) {
    await contract.item.click({ force: true }).catch(() => {});
    await randomDelay(400, 700);
    await Promise.all([
      page.waitForURL(/nextgen\/contract|contract\?idc=/i, { timeout: 20000 }).catch(() => null),
      contract.consulter.click({ force: true }),
    ]);
    await randomDelay(1000, 1600);
  }

  return /nextgen\/contract|contract\?idc=/i.test(page.url());
}

async function waitActionPanel(page, timeoutMs = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    for (const ctx of getScopes(page)) {
      try {
        const panel = ctx.getByText(/Action souhaitée/i).first();
        if ((await panel.count()) > 0 && (await panel.isVisible().catch(() => false))) {
          return true;
        }
      } catch {
        /* frame */
      }
    }
    await page.waitForTimeout(400);
  }
  return false;
}

async function clickActionTile(page, names) {
  const raw = (Array.isArray(names) ? names : [names]).filter(Boolean);
  const allowed = raw.filter(
    (name) => !/annuler la vente/i.test(name instanceof RegExp ? name.source : String(name))
  );
  if (allowed.length !== raw.length) {
    logWarn('Clic Annuler la vente interdit — Résilier uniquement');
  }
  if (!allowed.length) return null;

  const labels = allowed.map((name) =>
    name instanceof RegExp ? name.source.replace(/^\^|\$$/g, '') : String(name)
  );

  for (const ctx of getScopes(page)) {
    const selects = ctx.locator('select');
    const selectCount = await selects.count().catch(() => 0);
    for (let i = 0; i < selectCount; i += 1) {
      const sel = selects.nth(i);
      if (!(await sel.isVisible().catch(() => false))) continue;
      const options = await sel.locator('option').allTextContents().catch(() => []);
      const idx = options.findIndex((option) => isResilierTileLabel(option));
      if (idx < 0) continue;
      const picked = await sel.selectOption({ index: idx }).then(() => true).catch(() => false);
      if (picked) return normalizeUiText(options[idx]);
    }
  }

  for (const ctx of getScopes(page)) {
    try {
      const hit = await ctx.evaluate(
        ({ needles, tileFn }) => {
          const isResilierTileLabel = eval(`(${tileFn})`);
          const nodes = [...document.querySelectorAll('div, span, button, a, li, p')];
          let best = null;
          let bestArea = Infinity;
          let bestLabel = null;
          for (const el of nodes) {
            const raw = String(el.innerText || '');
            const aria = String(el.getAttribute('aria-label') || el.getAttribute('title') || '');
            const t = (raw || aria).replace(/\s+/g, ' ').trim();
            if (/annuler la vente/i.test(t) || /annuler la vente/i.test(aria)) continue;
            const exact = needles.some((needle) => new RegExp(`^${needle}$`, 'i').test(t));
            if (!exact && !isResilierTileLabel(raw) && !isResilierTileLabel(aria)) continue;
            const r = el.getBoundingClientRect();
            if (r.width < 6 || r.height < 6) continue;
            const style = window.getComputedStyle(el);
            if (style.visibility === 'hidden' || style.display === 'none') continue;
            const area = r.width * r.height;
            if (area < bestArea) {
              best = el;
              bestArea = area;
              bestLabel = t.slice(0, 48);
            }
          }
          if (!best) return null;
          const clickable = best.closest('button, a, [role="button"]') || best;
          clickable.scrollIntoView({ block: 'center', inline: 'center' });
          clickable.click();
          return bestLabel || 'Résilier';
        },
        { needles: labels, tileFn: isResilierTileLabel.toString() }
      );
      if (hit) return hit;
    } catch {
      /* frame détachée */
    }
  }
  return null;
}

async function isResilierFormVisible(page) {
  const re = /Date de r[eé]siliation effective/i;
  for (const ctx of getScopes(page)) {
    try {
      const title = ctx.getByText(re).first();
      if ((await title.count()) > 0 && (await title.isVisible().catch(() => false))) {
        return true;
      }
      const dateField = ctx
        .locator(
          'xpath=//*[contains(normalize-space(.),"Date de résiliation")]/following::input[1]'
        )
        .first();
      if ((await dateField.count()) > 0 && (await dateField.isVisible().catch(() => false))) {
        return true;
      }
    } catch {
      /* frame détachée */
    }
  }
  return false;
}

async function waitResilierForm(page, timeoutMs = 28000) {
  const start = Date.now();
  let lastClickAt = 0;
  while (Date.now() - start < timeoutMs) {
    if (await isResilierFormVisible(page)) return true;

    // Re-clic Résilier toutes les ~4 s si le panneau ne s’ouvre pas
    if (Date.now() - lastClickAt > 4000) {
      lastClickAt = Date.now();
      await clickActionTile(page, [/^Résilier$/i, /^Résiliation$/i]).catch(() => {});
      await page.waitForTimeout(600);
    }
    await page.waitForTimeout(300);
  }
  return false;
}

async function resiliationWorkPage(page) {
  for (const frame of page.frames() || []) {
    try {
      const n = await frame.getByText(/Date de r[eé]siliation effective/i).count();
      if (n > 0) return frame;
    } catch {
      /* frame detached */
    }
  }
  return page;
}

async function setResiliationDate(page, dateStr) {
  const ctx = await resiliationWorkPage(page);
  // Fermer un éventuel calendrier déjà ouvert
  await page.keyboard.press('Escape').catch(() => {});
  await randomDelay(200, 400);

  const labeled = ctx
    .locator(
      'xpath=//*[contains(normalize-space(.),"Date de résiliation effective")]/following::input[1]'
    )
    .first();
  const editors = ctx.locator(
    '.el-date-editor input, input[placeholder*="date" i], .ari-datepicker input, input.el-input__inner'
  );

  let input = labeled;
  if ((await input.count()) === 0 || !(await input.isVisible().catch(() => false))) {
    input = ctx
      .locator('div')
      .filter({ hasText: /^Date de résiliation effective/i })
      .locator('input, .el-date-editor')
      .first();
  }
  if ((await input.count()) === 0 || !(await input.isVisible().catch(() => false))) {
    input = editors.first();
  }

  if ((await input.count()) === 0) {
    logWarn('Champ date de résiliation introuvable');
    return false;
  }

  // Si on a un wrapper date-editor, cibler l'input interne
  const tag = await input.evaluate((el) => el.tagName).catch(() => '');
  if (tag && tag.toLowerCase() !== 'input') {
    const nested = input.locator('input').first();
    if ((await nested.count()) > 0) input = nested;
  }

  await input.click({ force: true }).catch(() => {});
  await randomDelay(200, 400);
  await input.press('Control+a').catch(() => {});
  await input.fill('').catch(() => {});
  await input.type(dateStr, { delay: 35 });
  await input.press('Enter').catch(() => {});
  await randomDelay(300, 500);

  // Repli calendrier : aujourd’hui d’abord, sinon jour du mois
  const todayCell = ctx
    .locator(
      '.el-date-table td.available.today, .el-date-table td.today, ' +
        '.el-picker-panel td.available.current, td.today span'
    )
    .first();
  if ((await todayCell.count()) > 0 && (await todayCell.isVisible().catch(() => false))) {
    await todayCell.click({ force: true }).catch(() => {});
    await randomDelay(300, 500);
  } else {
    const day = String(Number(dateStr.split('/')[0]));
    const calDay = ctx
      .locator(
        `.el-date-table td.available:not(.prev-month):not(.next-month) >> text="${day}", ` +
          `.el-picker-panel td.available >> text="${day}", ` +
          `td.available span:text-is("${day}")`
      )
      .first();
    if ((await calDay.count()) > 0 && (await calDay.isVisible().catch(() => false))) {
      await calDay.click({ force: true }).catch(() => {});
      await randomDelay(300, 500);
    } else {
      await page.keyboard.press('Escape').catch(() => {});
    }
  }

  // Forcer la valeur native si le v-model n'a pas suivi
  const current = ((await input.inputValue().catch(() => '')) || '').trim();
  const sameDate = (a, b) => {
    const norm = (v) => {
      const m = String(v || '')
        .trim()
        .match(/(\d{1,2})\D+(\d{1,2})\D+(\d{2,4})/);
      if (!m) return '';
      const y = m[3].length === 2 ? `20${m[3]}` : m[3];
      return `${Number(m[1])}/${Number(m[2])}/${Number(y)}`;
    };
    const na = norm(a);
    const nb = norm(b);
    return Boolean(na && nb && na === nb);
  };
  if (!sameDate(current, dateStr)) {
    await ctx
      .evaluate(
        ({ selectorHint, value }) => {
          const candidates = [
            ...document.querySelectorAll(
              '.el-dialog .el-date-editor input, .el-drawer .el-date-editor input, ' +
                '.el-date-editor input, input.el-input__inner, input[type="text"]'
            ),
          ];
          let target = null;
          for (const el of candidates) {
            const block = el.closest('.el-form-item, .el-dialog, form, div');
            const text = String(block?.textContent || '');
            if (/Date de résiliation/i.test(text)) {
              target = el;
              break;
            }
          }
          if (!target && candidates[0]) target = candidates[0];
          if (!target) return false;
          const proto = Object.getPrototypeOf(target);
          const desc = Object.getOwnPropertyDescriptor(proto, 'value');
          if (desc?.set) desc.set.call(target, value);
          else target.value = value;
          target.dispatchEvent(new Event('input', { bubbles: true }));
          target.dispatchEvent(new Event('change', { bubbles: true }));
          target.dispatchEvent(new Event('blur', { bubbles: true }));
          void selectorHint;
          return true;
        },
        { selectorHint: 'resiliation-date', value: dateStr }
      )
      .catch(() => false);
  }

  const finalValue = ((await input.inputValue().catch(() => '')) || '').trim();
  // Accepte date attendue OU toute date FR déjà présente (Deciplus reformate parfois)
  const ok =
    !finalValue ||
    sameDate(finalValue, dateStr) ||
    /\d{1,2}\D+\d{1,2}\D+\d{2,4}/.test(finalValue);
  logInfo('Date de résiliation effective', { expected: dateStr, value: finalValue || '(non lisible)', ok });
  return ok;
}

async function readMotifDisplayed(page) {
  for (const ctx of getScopes(page)) {
    try {
      const value = await ctx.evaluate(() => {
        const clean = (v) => String(v || '').replace(/\s+/g, ' ').trim();
        const prime = document.querySelector('.reason-container .p-select-label');
        if (prime) return clean(prime.innerText || prime.textContent);
        const items = [...document.querySelectorAll('.el-form-item, .ari-form-item, .reason-container')];
        for (const el of items) {
          const own = clean(el.innerText);
          if (!/Motif de résiliation/i.test(own) || own.length > 220) continue;
          const selected = el.querySelector(
            '.p-select-label, .el-select__selected-item, .el-input__inner, select, input'
          );
          if (!selected) continue;
          const fromSelect =
            selected.tagName === 'SELECT' ? selected.selectedOptions?.[0]?.text || '' : '';
          return clean(fromSelect || selected.value || selected.textContent);
        }
        return '';
      });
      if (value) return value;
    } catch {
      /* frame */
    }
  }
  return '';
}

async function selectResiliationMotif(page) {
  const motifs = [
    /Ne souhaite pas reconduire/i,
    /Ne souhaite plus reconduire/i,
    /ne souhaite pas reconduire/i,
    /pas reconduire/i,
    /changement/i,
    /autre/i,
  ];

  const chosenAlready = motifValueChosen(await readMotifDisplayed(page));
  if (chosenAlready) {
    logInfo('Motif de résiliation déjà renseigné', { motif: await readMotifDisplayed(page) });
    return true;
  }

  // Ouvrir le select du champ motif — pas le premier select de la page
  const openers = [
    page.locator('.reason-container .p-select').first(),
    page
      .locator(
        'xpath=//*[contains(normalize-space(.),"Motif de résiliation")]/following::*[contains(@class,"el-select") or self::select or contains(@class,"ari-select")][1]'
      )
      .first(),
    page.getByText(/Motif de résiliation/i).locator('xpath=following::input[1]').first(),
    page.locator('.el-form-item:has-text("Motif de résiliation") .el-select, .el-form-item:has-text("Motif de résiliation") select').first(),
  ];
  for (const opener of openers) {
    if ((await opener.count()) > 0 && (await opener.isVisible().catch(() => false))) {
      await opener.click({ force: true }).catch(() => {});
      break;
    }
  }
  await randomDelay(300, 500);

  // Attendre le dropdown
  for (let i = 0; i < 10; i += 1) {
    const open = await page
      .locator('.el-select-dropdown:visible, .el-popper:visible, ul.el-select-dropdown__list:visible')
      .count()
      .catch(() => 0);
    if (open > 0) break;
    await page.waitForTimeout(250);
  }

  const optionSelector =
    '.p-select-option, .el-select-dropdown__item, li.el-select-dropdown__item, [role="option"], .el-option';

  for (const re of motifs) {
    for (const ctx of getScopes(page)) {
      try {
        const opt = ctx.locator(optionSelector).filter({ hasText: re }).first();
        if ((await opt.count()) > 0 && (await opt.isVisible().catch(() => false))) {
          await opt.click({ force: true });
          await randomDelay(200, 400);
          const shown = await readMotifDisplayed(page);
          if (motifValueChosen(shown)) {
            logInfo('Motif de résiliation sélectionné', { motif: shown });
            return true;
          }
        }
      } catch {
        /* ignore */
      }
    }
  }

  // Repli : clic souris sur l’option du menu (Element UI ignore parfois un click JS nu)
  const picked = await page.evaluate(() => {
    const items = [...document.querySelectorAll(
      '.p-select-option, .el-select-dropdown__item, li.el-select-dropdown__item, [role="option"], .el-option, select option'
    )].filter((el) => {
      const t = String(el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!t || /^choisir$/i.test(t)) return false;
      if (el.tagName === 'OPTION') return true;
      const style = window.getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden';
    });
    const preferred = items.find((el) =>
      /ne souhaite|pas reconduire|changement|^autre$/i.test(String(el.textContent || ''))
    );
    const hit = preferred || items.find((el) => el.tagName !== 'OPTION') || null;
    if (!hit) {
      return { ok: false, options: items.map((el) => String(el.textContent || '').trim()).slice(0, 12) };
    }
    if (hit.tagName === 'OPTION' && hit.parentElement) {
      hit.parentElement.value = hit.value;
      hit.parentElement.dispatchEvent(new Event('input', { bubbles: true }));
      hit.parentElement.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      hit.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      hit.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      hit.click();
    }
    return { ok: true, motif: String(hit.textContent || '').replace(/\s+/g, ' ').trim() };
  });
  await randomDelay(200, 400);
  const shown = await readMotifDisplayed(page);
  if (motifValueChosen(shown)) {
    logInfo('Motif de résiliation sélectionné', { motif: shown, via: 'evaluate' });
    return true;
  }

  logWarn('Motif « Ne souhaite pas reconduire » introuvable', {
    options: picked?.options || [],
    shown: shown || null,
  });
  return false;
}

async function clickAppliquerEtQuitter(page, { timeoutMs = 25000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    for (const ctx of getScopes(page)) {
      try {
        const clicked = await ctx.evaluate(() => {
          const nodes = [
            ...document.querySelectorAll(
              'button, a, [role="button"], .ari-button, input[type="submit"], input[type="button"]'
            ),
          ];
          const candidates = nodes.filter((b) => {
            const t = String(b.innerText || b.value || b.textContent || '')
              .replace(/\s+/g, ' ')
              .trim();
            if (!t || t.length > 48) return false;
            return (
              /^appliquer et (quitter|fermer)$/i.test(t) ||
              /^appliquer$/i.test(t) ||
              (/appliquer/i.test(t) && /quitter|fermer/i.test(t))
            );
          });
          if (!candidates.length) return { ok: false };
          const enabled = candidates.find(
            (b) =>
              !b.disabled &&
              b.getAttribute('aria-disabled') !== 'true' &&
              !/is-disabled|disabled/i.test(String(b.className || ''))
          );
          if (!enabled) return { ok: false, reason: 'disabled' };
          enabled.scrollIntoView({ block: 'center', inline: 'center' });
          enabled.click();
          return {
            ok: true,
            forced: false,
            label: String(enabled.innerText || enabled.value || '').replace(/\s+/g, ' ').trim(),
          };
        });
        if (clicked?.ok) {
          logInfo('Clic Appliquer et Quitter', {
            label: clicked.label || null,
          });
          return true;
        }
      } catch {
        /* frame */
      }
    }
    await page.keyboard.press('Tab').catch(() => {});
    await page.locator('body').click({ position: { x: 8, y: 8 } }).catch(() => {});
    await page.waitForTimeout(500);
  }
  return false;
}

async function ensureResiliationEmailChecked(page) {
  for (const ctx of getScopes(page)) {
    try {
      const label = ctx
        .locator('label, div, span')
        .filter({ hasText: /Envoyer un mail de résiliation/i })
        .first();
      if ((await label.count()) === 0) continue;

      const checkbox = label.locator('input[type="checkbox"]').first();
      if ((await checkbox.count()) > 0) {
        const checked = await checkbox.isChecked().catch(() => false);
        if (!checked) await checkbox.check({ force: true }).catch(() => checkbox.click({ force: true }));
        return true;
      }

      // Checkbox Element-UI / custom
      const box = label.locator('.el-checkbox, .el-checkbox__input, input').first();
      if ((await box.count()) > 0) {
        const cls = (await box.getAttribute('class').catch(() => '')) || '';
        const parentCls =
          (await label.locator('.el-checkbox').first().getAttribute('class').catch(() => '')) || '';
        if (!/is-checked|checked/i.test(`${cls} ${parentCls}`)) {
          await label.click({ force: true }).catch(() => {});
        }
        return true;
      }

      await label.click({ force: true }).catch(() => {});
      return true;
    } catch {
      /* ignore */
    }
  }

  // Repli : cliquer le texte
  const mailText = page.getByText(/Envoyer un mail de résiliation/i).first();
  if ((await mailText.count()) > 0 && (await mailText.isVisible().catch(() => false))) {
    await mailText.click({ force: true }).catch(() => {});
    return true;
  }
  return false;
}

async function confirmResiliationModal(page, { timeoutMs = 12000 } = {}) {
  const certainty = /Êtes-vous certain|Etes-vous certain|confirmer la résiliation/i;
  const deadline = Date.now() + timeoutMs;
  let prompt = null;
  while (Date.now() < deadline) {
    for (const ctx of getScopes(page)) {
      const candidate = ctx.getByText(certainty).first();
      if ((await candidate.count().catch(() => 0)) > 0 && (await candidate.isVisible().catch(() => false))) {
        prompt = candidate;
        break;
      }
    }
    if (prompt) break;
    await page.waitForTimeout(250);
  }
  if (!prompt) return false;

  await ensureResiliationEmailChecked(page);
  await randomDelay(150, 300);

  const dialog = prompt.locator(
    'xpath=ancestor::*[self::div or self::section or self::form][.//button][1]'
  );
  const buttons = [
    dialog.getByRole('button', { name: /^(Confirmer|Valider)$/i }).first(),
    dialog.locator('button').filter({ hasText: /^(Confirmer|Valider)$/i }).first(),
  ];
  for (const btn of buttons) {
    if ((await btn.count()) > 0 && (await btn.isVisible().catch(() => false))) {
      await btn.click({ force: true }).catch(() => {});
      return true;
    }
  }
  return false;
}

/**
 * Modale finale « Résiliation de contrat - envoi d'un e-mail »
 * → cliquer « Résilier le contrat et envoyer le mail »
 */
async function clickResilierEtEnvoyerMail(page, { timeoutMs = 15000 } = {}) {
  const start = Date.now();
  const buttonRe =
    /Résilier le contrat et envoyer le mail|Résilier le contrat et l['’]?envoyer|Résilier et envoyer|Envoyer le mail|Envoyer un e-?mail/i;

  while (Date.now() - start < timeoutMs) {
    for (const ctx of getScopes(page)) {
      try {
        const title = ctx.getByText(/Résiliation de contrat\s*[-–]?\s*envoi d['’]?un e-?mail/i).first();
        const hasTitle =
          (await title.count()) > 0 && (await title.isVisible().catch(() => false));

        const btn = ctx.getByRole('button', { name: buttonRe }).first();
        const btnAlt = ctx.locator('button, a, [role="button"]').filter({ hasText: buttonRe }).first();
        const target =
          (await btn.count()) > 0 && (await btn.isVisible().catch(() => false))
            ? btn
            : (await btnAlt.count()) > 0 && (await btnAlt.isVisible().catch(() => false))
              ? btnAlt
              : null;

        if (target) {
          await target.click({ force: true });
          logInfo('Résiliation — mail envoyé (modale finale)');
          return true;
        }

        // Si la modale titre est visible mais bouton pas encore prêt
        if (hasTitle) {
          await page.waitForTimeout(300);
          continue;
        }
      } catch {
        /* frame détachée */
      }
    }

    const viaEval = await page
      .evaluate(() => {
        const hit = [...document.querySelectorAll('button, a, [role="button"]')].find((el) =>
          /Résilier le contrat et envoyer le mail|Résilier le contrat et l['’]envoyer|Résilier et envoyer|Envoyer le mail/i.test(
            String(el.textContent || '').replace(/\s+/g, ' ').trim()
          )
        );
        if (!hit) return false;
        hit.click();
        return true;
      })
      .catch(() => false);
    if (viaEval) {
      logInfo('Résiliation — mail envoyé (modale finale, evaluate)');
      return true;
    }

    await page.waitForTimeout(350);
  }

  logWarn('Modale « Résilier le contrat et envoyer le mail » introuvable');
  return false;
}

async function waitAppliquerEnabled(page, timeoutMs = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    for (const ctx of getScopes(page)) {
      try {
        const enabled = await ctx.evaluate(() => {
          const nodes = [
            ...document.querySelectorAll(
              'button, a, [role="button"], .ari-button, input[type="submit"], input[type="button"]'
            ),
          ];
          return nodes.some((b) => {
            const t = String(b.innerText || b.value || b.textContent || '')
              .replace(/\s+/g, ' ')
              .trim();
            if (!t || t.length > 48) return false;
            const ok =
              /^appliquer et (quitter|fermer)$/i.test(t) ||
              /^appliquer$/i.test(t) ||
              (/appliquer/i.test(t) && /quitter|fermer/i.test(t));
            if (!ok) return false;
            return (
              !b.disabled &&
              b.getAttribute('aria-disabled') !== 'true' &&
              !/is-disabled|disabled/i.test(String(b.className || ''))
            );
          });
        });
        if (enabled) return true;
      } catch {
        /* frame */
      }
    }
    await page.waitForTimeout(350);
  }
  return false;
}

/** Toujours Résilier. Aucun chemin n’annule une vente. */
function resolveCancelNeverVoid(_options = {}, _cancelReason = '') {
  return true;
}

async function cancelOneContract(page, contract, { cancelDate = null } = {}) {
  const dateStr = formatFrDate(parseCancelDate(cancelDate));
  const opened = await openContractPage(page, contract);
  if (!opened) {
    logWarn('Navigation contrat échouée', { idc: contract.idc, url: page.url() });
    return { cancelled: false, reason: 'contract_nav_failed', idc: contract.idc };
  }

  if (!(await waitActionPanel(page))) {
    logWarn('Panneau Action souhaitée introuvable', { idc: contract.idc, url: page.url() });
    return { cancelled: false, reason: 'action_panel_missing', idc: contract.idc };
  }

  // IMPORTANT : Résilier — jamais « Annuler la vente ».
  // Le titre « Action souhaitée » arrive souvent avant les tuiles.
  let mode = null;
  const tileDeadline = Date.now() + 8000;
  while (!mode && Date.now() < tileDeadline) {
    mode = await clickActionTile(page, [/^Résilier$/i, /^Résiliation$/i]);
    if (!mode) await page.waitForTimeout(400);
  }
  if (!mode) {
    const seen = await page
      .evaluate(() =>
        [...document.querySelectorAll('button, a, [role="button"], select option, [aria-label]')]
          .map((el) =>
            String(el.innerText || el.getAttribute('aria-label') || el.textContent || '')
              .replace(/\s+/g, ' ')
              .trim()
          )
          .filter((t) => t && t.length < 60 && /résili|resili|annul|action/i.test(t))
          .slice(0, 12)
      )
      .catch(() => []);
    const expiredOnly = await page
      .evaluate(() => {
        const labels = [...document.querySelectorAll('.contract-action-tabs__label')].map((el) =>
          String(el.innerText || '').replace(/\s+/g, ' ').trim()
        );
        const hasResilier = labels.some((t) => /^r[eé]sili/i.test(t));
        const body = String(document.body?.innerText || '');
        return !hasResilier && /expir/i.test(body);
      })
      .catch(() => false);
    logWarn('Tuile Résilier introuvable', {
      idc: contract.idc,
      url: page.url(),
      labels: seen,
      expired_only: expiredOnly,
    });
    if (expiredOnly) {
      return { cancelled: false, reason: 'expired_not_resiliable', idc: contract.idc, already: true };
    }
    return { cancelled: false, reason: 'resilier_missing', idc: contract.idc };
  }
  await randomDelay(1000, 1600);

  if (!(await waitResilierForm(page))) {
    await clickActionTile(page, [/^Résilier$/i]).catch(() => {});
    await page.waitForTimeout(1500);
    if (!(await waitResilierForm(page, 8000))) {
      logWarn('Formulaire Résilier le contrat introuvable', {
        idc: contract.idc,
        url: page.url(),
      });
      return { cancelled: false, reason: 'resilier_form_missing', idc: contract.idc };
    }
  }

  const dateOk = await setResiliationDate(page, dateStr);
  if (!dateOk) {
    return { cancelled: false, reason: 'resiliation_date_missing', idc: contract.idc };
  }

  const motifOk = await selectResiliationMotif(page);
  if (!motifOk) {
    return { cancelled: false, reason: 'resiliation_motif_missing', idc: contract.idc };
  }

  // S'assurer que l'erreur « motif obligatoire » a disparu
  await randomDelay(500, 900);
  const motifError = page.getByText(/motif de résiliation est obligatoire/i).first();
  if ((await motifError.count()) > 0 && (await motifError.isVisible().catch(() => false))) {
    await selectResiliationMotif(page);
    await randomDelay(400, 700);
  }

  // Le select motif laisse souvent « Appliquer et Quitter » disabled tant qu’on n’a pas blur.
  await page.keyboard.press('Tab').catch(() => {});
  await page.locator('body').click({ position: { x: 8, y: 8 } }).catch(() => {});
  await randomDelay(300, 500);
  let applyReady = await waitAppliquerEnabled(page, 8000);
  if (!applyReady) {
    await selectResiliationMotif(page);
    await page.keyboard.press('Tab').catch(() => {});
    applyReady = await waitAppliquerEnabled(page, 5000);
  }
  if (!applyReady) {
    logWarn('Appliquer et Quitter encore désactivé après motif', { idc: contract.idc });
    return { cancelled: false, reason: 'appliquer_disabled', idc: contract.idc };
  }

  const applied = await clickAppliquerEtQuitter(page);
  if (!applied) {
    return { cancelled: false, reason: 'appliquer_quitter_missing', idc: contract.idc };
  }
  await randomDelay(800, 1200);

  let confirmed = await confirmResiliationModal(page);
  if (!confirmed) {
    await clickAppliquerEtQuitter(page, { timeoutMs: 4000 }).catch(() => {});
    confirmed = await confirmResiliationModal(page, { timeoutMs: 6000 });
  }
  if (!confirmed || !resiliationCountsAsDone({ applyEnabled: true, confirmSeen: confirmed })) {
    logWarn('Modale Confirmer résiliation introuvable', { idc: contract.idc, url: page.url() });
    return { cancelled: false, reason: 'confirm_missing', idc: contract.idc };
  }
  await randomDelay(400, 700);

  // Aperçu email Deciplus — parfois absent une fois la modale « certain » confirmée.
  const mailed = await clickResilierEtEnvoyerMail(page);
  if (!mailed) {
    logWarn('Modale mail de résiliation absente — confirmation déjà faite, on continue', {
      idc: contract.idc,
    });
    return {
      cancelled: true,
      reason: 'ok_mail_skipped',
      mode: 'resilier',
      idc: contract.idc,
      label: contract.label,
      cancel_date: dateStr,
      mail_skipped: true,
    };
  }

  await randomDelay(800, 1200);
  await closeGreyboxIfOpen(page);

  logInfo('Contrat résilié Deciplus', {
    idc: contract.idc,
    mode: 'resilier',
    date: dateStr,
    motif: 'Ne souhaite pas reconduire',
    label: contract.label?.slice(0, 80),
  });
  return {
    cancelled: true,
    reason: 'ok',
    mode: 'resilier',
    idc: contract.idc,
    label: contract.label,
    cancel_date: dateStr,
  };
}

async function reopenMemberAfterCancel(page, memberId) {
  await randomDelay(700, 1100);
  await closeGreyboxIfOpen(page).catch(() => {});
  try {
    await openMemberCheck(page, memberId);
  } catch (err) {
    logWarn('Retour fiche membre après résiliation — retry', {
      member_id: memberId,
      error: err.message,
    });
    await page.waitForTimeout(1000);
    await openMemberCheck(page, memberId);
  }
  await randomDelay(600, 1000);
}

async function cancelAllMemberSales(page, memberId, { maxSales = 15, cancelDate = null, filter = null } = {}) {
  let total = 0;
  const details = [];
  const doneIds = new Set();
  const failCount = new Map();

  for (let i = 0; i < maxSales; i += 1) {
    try {
      await reopenMemberAfterCancel(page, memberId);
    } catch (err) {
      // Si au moins un contrat a déjà été résilié, ne pas faire échouer tout le job
      if (total > 0) {
        logWarn('Impossible de recharger la fiche — on s’arrête avec les résiliations déjà OK', {
          member_id: memberId,
          cancelled_count: total,
          error: err.message,
        });
        break;
      }
      throw err;
    }

    let contracts = await findActiveContracts(page);
    contracts = contracts.filter((c) => !doneIds.has(String(c.idc)));
    if (typeof filter === 'function') {
      contracts = contracts.filter((c) => {
        try {
          return filter(c);
        } catch {
          return false;
        }
      });
    }

    logInfo('Contrats actifs à résilier', {
      member_id: memberId,
      count: contracts.length,
      labels: contracts.map((c) => `${c.idc}:${c.label?.slice(0, 50)}`),
      already_done: [...doneIds],
    });

    if (contracts.length === 0) {
      if (total === 0) details.push({ cancelled: false, reason: 'no_active_sale' });
      break;
    }

    const target = contracts[0];
    const idcKey = String(target.idc);
    const result = await cancelOneContract(page, target, { cancelDate });
    details.push(result);

    if (result.cancelled) {
      doneIds.add(idcKey);
      total += 1;
      continue;
    }

    if (result.reason === 'expired_not_resiliable') {
      doneIds.add(idcKey);
      continue;
    }

    const skippable = [
      'action_panel_missing',
      'resilier_missing',
      'contract_nav_failed',
      'resiliation_date_missing',
      'resilier_form_missing',
      'appliquer_quitter_missing',
      'appliquer_disabled',
      'confirm_missing',
      'resiliation_motif_missing',
    ].includes(result.reason);

    if (skippable) {
      const tries = (failCount.get(idcKey) || 0) + 1;
      failCount.set(idcKey, tries);
      logWarn('Contrat sauté — tentative suivante', {
        idc: target.idc,
        reason: result.reason,
        attempt: tries,
      });
      if (tries >= 3) doneIds.add(idcKey);
      await randomDelay(600, 1000);
      continue;
    }

    doneIds.add(idcKey);
    break;
  }

  return { member_id: memberId, cancelled_count: total, details };
}

function looksLikeComptantContract(label) {
  const t = String(label || '');
  if (/pr[ée]l[èe]vement|4\s*semaines|sans\s*engagement|iban|sepa/i.test(t)) return false;
  return /comptant|259\s*€|12\s*mois|promo\s*12|baby\s*boxe|boxe\s*[eé]ducative|1\s*[x×]\s*ou\s*4|forfait\s*annuel/i.test(
    t
  );
}

async function cancelSale(page, memberId, options = {}) {
  if (!memberId) throw new Error('member_id requis pour résilier');
  const cancelDate = options.cancelDate || options.cancel_date || null;
  const cancelReason = String(options.cancelReason || options.cancel_reason || '').toLowerCase();
  const isChange =
    cancelReason === 'change_to_comptant' || cancelReason.startsWith('change_');

  const extraFilter = typeof options.filter === 'function' ? options.filter : null;

  if (options.pendingOnly) {
    const outcome = await cancelAllMemberSales(page, memberId, {
      maxSales: 15,
      cancelDate,
      filter: (c) =>
        !c.isBadge &&
        isPendingOrFutureContract(c.label) &&
        (!extraFilter || extraFilter(c)),
    });
    return {
      action: 'sale_cancelled',
      sale_type: 'cancel',
      pending_only: true,
      ...outcome,
    };
  }

  if (!isChange) {
    try {
      await reopenMemberAfterCancel(page, memberId);
      const contracts = await findActiveContracts(page);
      const abo = contracts.filter((c) => !c.isBadge);
      if (abo.length > 0 && abo.every((c) => looksLikeComptantContract(c.label))) {
        logInfo('Résiliation web refusée — formule comptant détectée', {
          member_id: memberId,
          labels: abo.map((c) => c.label?.slice(0, 80)),
        });
        return {
          action: 'sale_cancelled',
          sale_type: 'cancel',
          refused: true,
          reason: 'comptant_refused',
          cancelled_count: 0,
          details: [{ cancelled: false, reason: 'comptant_refused' }],
        };
      }
    } catch (err) {
      logWarn('Contrôle comptant avant résiliation — poursuite', {
        member_id: memberId,
        error: err.message,
      });
    }
  }

  const outcome = await cancelAllMemberSales(page, memberId, {
    maxSales: 15,
    cancelDate,
    filter: extraFilter,
  });
  if (outcome.cancelled_count === 0) {
    const reason = outcome.details[0]?.reason || 'inconnu';
    const closedReasons = new Set(['no_active_sale', 'expired_not_resiliable']);
    const onlyClosed = (outcome.details || []).every((d) => !d.reason || closedReasons.has(d.reason));
    if (onlyClosed && closedReasons.has(reason)) {
      logInfo('Aucun contrat actif à résilier — déjà clos', {
        member_id: memberId,
        reason,
      });
      return {
        action: 'sale_cancelled',
        sale_type: 'cancel',
        cancelled_count: 0,
        already: true,
        reason,
        details: outcome.details,
      };
    }
    // Changement d’abo : déjà clos / panneau absent → on laisse recordSale décider.
    // Si Appliquer et Quitter a échoué, le contrat est encore là : ne pas faire semblant.
    if (isChange && reason !== 'appliquer_quitter_missing' && reason !== 'confirm_missing') {
      logInfo('Changement abo — résiliation non bloquante, on continue la vente', {
        member_id: memberId,
        reason,
        detail_reasons: (outcome.details || []).map((d) => d.reason).filter(Boolean),
      });
      return {
        action: 'sale_cancelled',
        sale_type: 'cancel',
        cancelled_count: 0,
        skipped: true,
        skip_reason: reason,
        details: outcome.details,
      };
    }
    throw new Error(`Résiliation impossible — ${reason}`);
  }
  logInfo('Résiliation Deciplus terminée', {
    member_id: memberId,
    cancelled_count: outcome.cancelled_count,
    labels: (outcome.details || []).filter((d) => d.cancelled).map((d) => d.label || d.idc),
  });
  return {
    action: 'sale_cancelled',
    sale_type: 'cancel',
    cancelled_count: outcome.cancelled_count,
    details: outcome.details,
  };
}

module.exports = {
  contractUrl,
  findActiveContracts,
  findActiveContractBlocks: findActiveContracts,
  cancelOneContract,
  cancelAllMemberSales,
  cancelSale,
  formatFrDate,
  isPendingOrFutureContract,
  isSameDayStartContract,
  resolveCancelNeverVoid,
  isAppliquerQuitterLabel,
  isResilierTileLabel,
  motifValueChosen,
  resiliationCountsAsDone,
  clickActionTile,
  selectResiliationMotif,
  clickAppliquerEtQuitter,
  waitAppliquerEnabled,
  confirmResiliationModal,
  clickResilierEtEnvoyerMail,
  parseFrDatesFromLabel,
  contractStartDate,
  openContractPage,
  waitActionPanel,
};
