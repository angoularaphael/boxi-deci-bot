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

/** Contrats « en attente » / qui commencent après aujourd’hui — pas l’abo en cours. */
function isPendingOrFutureContract(label) {
  const t = String(label || '');
  if (/en attente/i.test(t)) return true;
  const dates = parseFrDatesFromLabel(t);
  if (!dates.length) return false;
  const start = dates[0];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return start > today;
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
async function expandContractSections(page) {
  for (const ctx of getScopes(page)) {
    try {
      await ctx
        .locator('div, span, a, button')
        .filter({ hasText: /^en attente$/i })
        .first()
        .click({ force: true, timeout: 1500 })
        .catch(() => {});
    } catch {
      /* frame */
    }
  }
  await page.waitForTimeout(400);
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
        const label = wrapperLabel.length > itemLabel.length ? wrapperLabel : itemLabel;
        if (!label) continue;
        // Déjà résiliés / terminés : pas d’action « Résilier » → évite action_panel_missing.
        // Exception : séance d’essai / coaching « Expiré » le jour même (1 crédit) — c’est la vente.
        const expiredPrestation =
          options.includeExpiredPrestation &&
          /essai|coaching/i.test(label) &&
          /expir[ée]/i.test(label) &&
          !/r[ée]sili[ée]|annul[ée]/i.test(label);
        if (
          !expiredPrestation &&
          /r[ée]sili[ée]|annul[ée]e?|termin[ée]|expir[ée]|inactif|cl[ôo]tur|archiv/i.test(label)
        ) {
          continue;
        }

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
  const labels = (Array.isArray(names) ? names : [names]).map((name) =>
    name instanceof RegExp ? name.source.replace(/^\^|\$$/g, '') : String(name)
  );

  for (const ctx of getScopes(page)) {
    try {
      const hit = await ctx.evaluate((needles) => {
        const nodes = [...document.querySelectorAll('div, span, button, a, li, p')];
        for (const needle of needles) {
          const re = new RegExp(`^${needle}$`, 'i');
          let best = null;
          let bestArea = Infinity;
          for (const el of nodes) {
            const t = String(el.innerText || '').replace(/\s+/g, ' ').trim();
            if (!re.test(t)) continue;
            const r = el.getBoundingClientRect();
            if (r.width < 6 || r.height < 6) continue;
            const style = window.getComputedStyle(el);
            if (style.visibility === 'hidden' || style.display === 'none') continue;
            const area = r.width * r.height;
            if (area < bestArea) {
              best = el;
              bestArea = area;
            }
          }
          if (best) {
            best.scrollIntoView({ block: 'center', inline: 'center' });
            best.click();
            return needle;
          }
        }
        return null;
      }, labels);
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

async function selectResiliationMotif(page) {
  const motifs = [
    /Ne souhaite pas reconduire/i,
    /Ne souhaite plus reconduire/i,
    /ne souhaite pas reconduire/i,
    /pas reconduire/i,
    /changement/i,
    /autre/i,
  ];

  // Ouvrir le select — plusieurs variantes Deciplus / Element UI
  const openers = [
    page
      .locator(
        'xpath=//*[contains(normalize-space(.),"Motif de résiliation")]/following::*[contains(@class,"el-select") or self::select or contains(@class,"ari-select")][1]'
      )
      .first(),
    page.getByText(/Motif de résiliation/i).locator('xpath=following::input[1]').first(),
    page.getByText(/^Choisir$/i).first(),
    page.locator('.el-select .el-input__inner, .el-select .el-input').first(),
  ];
  for (const opener of openers) {
    if ((await opener.count()) > 0 && (await opener.isVisible().catch(() => false))) {
      await opener.click({ force: true }).catch(() => {});
      break;
    }
  }
  await randomDelay(500, 900);

  // Attendre le dropdown
  for (let i = 0; i < 10; i += 1) {
    const open = await page
      .locator('.el-select-dropdown:visible, .el-popper:visible, ul.el-select-dropdown__list:visible')
      .count()
      .catch(() => 0);
    if (open > 0) break;
    await page.waitForTimeout(250);
  }

  for (const re of motifs) {
    for (const ctx of getScopes(page)) {
      try {
        const opt = ctx
          .locator(
            '.el-select-dropdown__item, li.el-select-dropdown__item, li, .el-option, div[role="option"]'
          )
          .filter({ hasText: re })
          .first();
        if ((await opt.count()) > 0 && (await opt.isVisible().catch(() => false))) {
          await opt.click({ force: true });
          logInfo('Motif de résiliation sélectionné', { motif: String(re) });
          await randomDelay(400, 700);
          return true;
        }
      } catch {
        /* ignore */
      }
    }
    const byText = page.getByText(re).first();
    if ((await byText.count()) > 0 && (await byText.isVisible().catch(() => false))) {
      await byText.click({ force: true });
      logInfo('Motif de résiliation sélectionné', { motif: String(re) });
      await randomDelay(400, 700);
      return true;
    }
  }

  // Repli JS : préférer « ne souhaite… », sinon 1ère option non vide
  const picked = await page.evaluate(() => {
    const items = [
      ...document.querySelectorAll(
        '.el-select-dropdown__item, li.el-select-dropdown__item, li[role="option"], [role="option"], .el-option'
      ),
    ].filter((el) => {
      const t = String(el.textContent || '').replace(/\s+/g, ' ').trim();
      const style = window.getComputedStyle(el);
      return t && style.display !== 'none' && style.visibility !== 'hidden';
    });
    const preferred = items.find((el) =>
      /ne souhaite|pas reconduire|changement|autre/i.test(String(el.textContent || ''))
    );
    const hit = preferred || items[0];
    if (!hit) {
      return { ok: false, options: items.map((el) => String(el.textContent || '').trim()).slice(0, 12) };
    }
    hit.click();
    return { ok: true, motif: String(hit.textContent || '').replace(/\s+/g, ' ').trim() };
  });
  if (picked?.ok) {
    logInfo('Motif de résiliation sélectionné', { motif: picked.motif, via: 'evaluate' });
    await randomDelay(400, 700);
    return true;
  }

  logWarn('Motif « Ne souhaite pas reconduire » introuvable', {
    options: picked?.options || [],
  });
  return false;
}

async function clickAppliquerEtQuitter(page) {
  const start = Date.now();
  while (Date.now() - start < 20000) {
    for (const ctx of getScopes(page)) {
      try {
        const btn = ctx.locator('button').filter({ hasText: /^Appliquer et Quitter$/i }).first();
        if ((await btn.count()) === 0 || !(await btn.isVisible().catch(() => false))) continue;
        const disabled = await btn.isDisabled().catch(() => false);
        const ariaDisabled = (await btn.getAttribute('aria-disabled').catch(() => '')) === 'true';
        const cls = (await btn.getAttribute('class').catch(() => '')) || '';
        if (disabled || ariaDisabled || /is-disabled|disabled/i.test(cls)) continue;
        await btn.scrollIntoViewIfNeeded().catch(() => {});
        await btn.click({ force: true, noWaitAfter: true }).catch(() => btn.click({ force: true }));
        logInfo('Clic Appliquer et Quitter');
        return true;
      } catch {
        /* frame */
      }
    }
    await page.waitForTimeout(400);
  }

  const forced = await page.evaluate(() => {
    const hit = [...document.querySelectorAll('button')].find((b) => {
      const t = String(b.textContent || '').replace(/\s+/g, ' ').trim();
      if (!/^Appliquer et Quitter$/i.test(t)) return false;
      return (
        !b.disabled &&
        b.getAttribute('aria-disabled') !== 'true' &&
        !/is-disabled|disabled/i.test(String(b.className || ''))
      );
    });
    if (!hit) return false;
    hit.click();
    return true;
  });
  if (forced) logInfo('Clic Appliquer et Quitter (evaluate)');
  return Boolean(forced);
}

async function confirmAnnulationModal(page) {
  const start = Date.now();
  while (Date.now() - start < 12000) {
    for (const ctx of getScopes(page)) {
      try {
        const dialog = ctx.getByText(/Etes-vous certain de vouloir annuler le contrat/i).first();
        const confirm = ctx.locator('button').filter({ hasText: /^Confirmer$/i }).last();
        if ((await confirm.count()) > 0 && (await confirm.isVisible().catch(() => false))) {
          await confirm.click({ force: true });
          logInfo('Annulation — modale Confirmer');
          await randomDelay(700, 1100);
          return true;
        }
        void dialog;
      } catch {
        /* frame */
      }
    }
    await page.waitForTimeout(300);
  }
  logWarn('Modale Confirmer d’annulation introuvable');
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

async function confirmResiliationModal(page) {
  // Attendre l’apparition de la modale (parfois lente après « Appliquer »)
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    const visible = await page
      .getByText(/Etes-vous certain|Êtes-vous certain|confirmer la résiliation|Envoyer un mail de résiliation/i)
      .first()
      .isVisible()
      .catch(() => false);
    if (visible) break;
    await page.waitForTimeout(350);
  }

  await ensureResiliationEmailChecked(page);
  await randomDelay(200, 400);

  const clickConfirm = async (ctx) => {
    const candidates = [
      ctx.getByRole('button', { name: /^Confirmer$/i }).first(),
      ctx.locator('button:has-text("Confirmer")').first(),
      ctx.locator('.el-button--primary:has-text("Confirmer")').first(),
      ctx.locator('button.el-button--primary').filter({ hasText: /Confirmer/i }).first(),
    ];
    for (const btn of candidates) {
      if ((await btn.count()) > 0 && (await btn.isVisible().catch(() => false))) {
        await btn.click({ force: true, noWaitAfter: true }).catch(() => btn.click({ force: true }));
        return true;
      }
    }
    return false;
  };

  for (let attempt = 0; attempt < 6; attempt += 1) {
    for (const ctx of getScopes(page)) {
      try {
        if (await clickConfirm(ctx)) return true;
      } catch {
        /* ignore */
      }
    }
    const ok = await page.evaluate(() => {
      const buttons = [...document.querySelectorAll('button, .el-button, a')];
      const b = buttons.find((el) => /^Confirmer$/i.test(String(el.textContent || '').trim()));
      if (!b) return false;
      b.click();
      return true;
    });
    if (ok) return true;
    await page.waitForTimeout(400);
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

async function fillLabeledDate(page, labelRe, dateStr) {
  for (const ctx of getScopes(page)) {
    try {
      if (/annulation/i.test(labelRe.source)) {
        const labeled = ctx
          .locator(
            'xpath=//*[contains(normalize-space(.),"Date d") and contains(.,"annulation")]/following::input[1]'
          )
          .first();
        if ((await labeled.count()) > 0 && (await labeled.isVisible().catch(() => false))) {
          await labeled.click({ force: true }).catch(() => {});
          await labeled.fill('').catch(() => {});
          await labeled.type(dateStr, { delay: 25 });
          await labeled.press('Enter').catch(() => {});
          return true;
        }
      }
      const ok = await ctx.evaluate(
        ({ labelSrc, value }) => {
          const re = new RegExp(labelSrc, 'i');
          const inputs = [
            ...document.querySelectorAll(
              '.el-date-editor input, input.el-input__inner, input[placeholder*="date" i], input[type="text"]'
            ),
          ];
          let target = null;
          for (const el of inputs) {
            const block = el.closest('.el-form-item, form, .el-dialog, div');
            const text = String(block?.textContent || '');
            if (re.test(text)) {
              target = el;
              break;
            }
          }
          if (!target) return false;
          const proto = Object.getPrototypeOf(target);
          const desc = Object.getOwnPropertyDescriptor(proto, 'value');
          if (desc?.set) desc.set.call(target, value);
          else target.value = value;
          target.dispatchEvent(new Event('input', { bubbles: true }));
          target.dispatchEvent(new Event('change', { bubbles: true }));
          target.dispatchEvent(new Event('blur', { bubbles: true }));
          return true;
        },
        { labelSrc: labelRe.source, value: dateStr }
      );
      if (ok) return true;
    } catch {
      /* frame */
    }
  }
  return false;
}

async function clickAnnulationRefundMode(page) {
  for (const ctx of getScopes(page)) {
    try {
      const named = ctx.locator('.payment-mode-name').filter({ hasText: /^Virement$/i }).last();
      if ((await named.count()) > 0 && (await named.isVisible().catch(() => false))) {
        await named.click({ force: true });
        return 'Virement';
      }
    } catch {
      /* frame */
    }
    try {
      const hit = await ctx.evaluate(() => {
        const row = [...document.querySelectorAll('div, tr, section, form')].find(
          (n) => /-259/.test(String(n.innerText || '')) && /Mode de paiement/i.test(String(n.innerText || ''))
        );
        const root = row || document.body;
        const modes = [...root.querySelectorAll('div, span, button, li, a')].filter((n) => {
          const t = String(n.innerText || '').replace(/\s+/g, ' ').trim();
          return /^(Espèces|Carte Bancaire|Ch[eè]que|Virement)$/i.test(t);
        });
        const pick =
          modes.find((n) => /^Virement$/i.test(String(n.innerText || '').trim())) ||
          modes.find((n) => /Carte Bancaire/i.test(String(n.innerText || ''))) ||
          modes[0];
        if (!pick) return { ok: false, count: modes.length };
        pick.click();
        return { ok: true, mode: String(pick.innerText || '').trim() };
      });
      if (hit?.ok) return hit.mode;
    } catch {
      /* frame */
    }
  }
  return null;
}

async function waitAppliquerEnabled(page, timeoutMs = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    for (const ctx of getScopes(page)) {
      try {
        const enabled = await ctx.evaluate(() => {
          const btns = [...document.querySelectorAll('button')].filter((b) =>
            /^Appliquer et Quitter$/i.test(String(b.innerText || '').replace(/\s+/g, ' ').trim())
          );
          return btns.some(
            (b) =>
              !b.disabled &&
              b.getAttribute('aria-disabled') !== 'true' &&
              !/is-disabled|disabled/i.test(String(b.className || ''))
          );
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

async function voidPendingSaleIfPossible(page, contract, { allowStarted = false } = {}) {
  if (!allowStarted && !isPendingOrFutureContract(contract?.label)) return false;
  const mode = await clickActionTile(page, [/^Annuler la vente$/i]);
  if (!mode) {
    logWarn('Tuile Annuler la vente introuvable', { idc: contract?.idc || null });
    return false;
  }
  logInfo('Clic Annuler la vente', { idc: contract?.idc || null });
  await randomDelay(900, 1400);

  const dateStr = formatFrDate(new Date());
  const dateOk = await fillLabeledDate(page, /Date d['’]?annulation/i, dateStr);
  if (!dateOk) {
    logWarn('Date d’annulation introuvable', { idc: contract?.idc || null });
  }
  const refundMode = await clickAnnulationRefundMode(page);
  logInfo('Annulation contrat — date et mode', {
    idc: contract?.idc || null,
    date: dateOk,
    refund_mode: refundMode,
  });
  const applyReady = await waitAppliquerEnabled(page);
  if (!applyReady) {
    logWarn('Annuler la vente — Appliquer reste désactivé', {
      idc: contract?.idc || null,
      refund_mode: refundMode,
    });
    return false;
  }
  await randomDelay(400, 700);

  const stillModify = page.getByText(/Modification manuelle/i).first();
  const modifyVisible =
    (await stillModify.count()) > 0 && (await stillModify.isVisible().catch(() => false));
  if (!modifyVisible) {
    const applied = await clickAppliquerEtQuitter(page).catch(() => false);
    if (applied) {
      const confirmed = await confirmAnnulationModal(page);
      logInfo('Contrat en attente — vente annulée (Appliquer et Quitter)', {
        idc: contract?.idc || null,
        confirmed,
      });
      await randomDelay(800, 1200);
      return confirmed;
    }
  }
  logWarn('Annuler la vente cliqué mais pas de confirmation', { idc: contract?.idc || null });
  return false;
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

  if (contract.isBadge || isPendingOrFutureContract(contract.label)) {
    const voided = await voidPendingSaleIfPossible(page, contract, {
      allowStarted: Boolean(contract.isBadge),
    });
    if (voided) {
      return {
        cancelled: true,
        reason: contract.isBadge ? 'badge_voided' : 'pending_voided',
        idc: contract.idc,
      };
    }
    await openContractPage(page, contract).catch(() => {});
    await waitActionPanel(page);
  }

  // IMPORTANT : Résilier — jamais « Annuler la vente » sur un abo déjà commencé
  const mode = await clickActionTile(page, [/^Résilier$/i, /^Résiliation$/i]);
  if (!mode) {
    logWarn('Tuile Résilier introuvable', { idc: contract.idc, url: page.url() });
    return { cancelled: false, reason: 'resilier_missing', idc: contract.idc };
  }
  await randomDelay(1000, 1600);

  if (!(await waitResilierForm(page))) {
    await clickActionTile(page, [/^Résilier$/i]).catch(() => {});
    await page.waitForTimeout(1500);
    if (!(await waitResilierForm(page, 8000))) {
      const voided = await voidPendingSaleIfPossible(page, contract);
      if (voided) return { cancelled: true, reason: 'pending_voided', idc: contract.idc };
      logWarn('Formulaire Résilier le contrat introuvable', {
        idc: contract.idc,
        url: page.url(),
      });
      return { cancelled: false, reason: 'resilier_form_missing', idc: contract.idc };
    }
  }

  const dateOk = await setResiliationDate(page, dateStr);
  if (!dateOk) {
    const voided = await voidPendingSaleIfPossible(page, contract);
    if (voided) return { cancelled: true, reason: 'pending_voided', idc: contract.idc };
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

  const applied = await clickAppliquerEtQuitter(page);
  if (!applied) {
    return { cancelled: false, reason: 'appliquer_quitter_missing', idc: contract.idc };
  }
  await randomDelay(1200, 2000);

  // Modale : email + Confirmer (plusieurs libellés Deciplus)
  let confirmed = await confirmResiliationModal(page);
  if (!confirmed) {
    // Parfois 1er clic Appliquer n’a rien fait — retry
    await clickAppliquerEtQuitter(page).catch(() => {});
    await page.waitForTimeout(1500);
    confirmed = await confirmResiliationModal(page);
  }
  if (!confirmed) {
    // Bouton Confirmer parfois hors modale texte attendue
    const anyConfirm = await page
      .locator('button:has-text("Confirmer"), .el-button--primary:has-text("Confirmer"), .swal2-confirm')
      .first()
      .click({ force: true, noWaitAfter: true })
      .then(() => true)
      .catch(() => false);
    confirmed = anyConfirm;
  }
  if (!confirmed) {
    logWarn('Modale Confirmer résiliation introuvable', { idc: contract.idc, url: page.url() });
    return { cancelled: false, reason: 'confirm_missing', idc: contract.idc };
  }
  await randomDelay(500, 900);

  // Aperçu email Deciplus — parfois absent (contrat déjà clos après Confirmer).
  const mailed = await clickResilierEtEnvoyerMail(page);
  if (!mailed) {
    logWarn('Modale mail de résiliation absente — contrat déjà confirmé, on continue', {
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
    contracts = contracts.filter((c) => !doneIds.has(c.idc));
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

    const result = await cancelOneContract(page, contracts[0], { cancelDate });
    details.push(result);
    doneIds.add(contracts[0].idc);

    if (result.cancelled) {
      total += 1;
      continue;
    }

    if (
      result.reason === 'action_panel_missing' ||
      result.reason === 'resilier_missing' ||
      result.reason === 'contract_nav_failed' ||
      result.reason === 'resiliation_date_missing' ||
      result.reason === 'resilier_form_missing'
    ) {
      logWarn('Contrat sauté — tentative suivante', {
        idc: contracts[0].idc,
        reason: result.reason,
      });
      await randomDelay(600, 1000);
      continue;
    }
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
    if (reason === 'no_active_sale') {
      logInfo('Aucun contrat actif à résilier — déjà clos', {
        member_id: memberId,
      });
      return {
        action: 'sale_cancelled',
        sale_type: 'cancel',
        cancelled_count: 0,
        already: true,
        reason: 'no_active_sale',
        details: outcome.details,
      };
    }
    // Changement d’abo : le but est la vente. Déjà résilié / panneau absent → on continue.
    if (isChange) {
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
  parseFrDatesFromLabel,
};
