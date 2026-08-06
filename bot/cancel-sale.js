/**
 * Annulation / résiliation Deciplus — abo + badge.
 * Flux : fiche membre → #prestation_XXXX → Consulter → Annuler la vente|Résilier
 *        → Virement → Appliquer et Quitter → Confirmer
 * Boucle jusqu'à plus aucun contrat actif.
 */
const { randomDelay } = require('../lib/utils');
const { logInfo, logWarn } = require('../lib/logger');
const { openMemberCheck, clickFirst, sel, closeGreyboxIfOpen } = require('./wallet');

function deciplusBase() {
  return (process.env.DECIPLUS_URL || 'https://boxingcenter.deciplus.pro/').replace(/\/?$/, '/');
}

function contractUrl(idc) {
  return new URL(`nextgen/contract?idc=${idc}`, deciplusBase()).href;
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
async function findActiveContracts(page) {
  // Attendre le chargement legacy/iframe fiche membre
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

  // Déplier éventuelles sections Cartes / Abonnements
  for (const ctx of getScopes(page)) {
    try {
      await ctx.evaluate(() => {
        window.scrollTo(0, document.body.scrollHeight / 2);
      }).catch(() => {});
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
        if (!(await item.isVisible().catch(() => false))) continue;
        const idAttr = (await item.getAttribute('id').catch(() => '')) || '';
        const idc = (idAttr.match(/prestation_(\d+)/i) || [])[1];
        if (!idc || seen.has(idc)) continue;

        const label = ((await item.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
        if (!label) continue;

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
          isBadge: /badge|carte/i.test(label),
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
  await randomDelay(1200, 2000);

  if (/nextgen\/contract|contract\?idc=/i.test(page.url())) {
    return true;
  }

  // Repli : Consulter depuis la fiche
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

async function waitActionPanel(page, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const panel = page.getByText(/Action souhaitée/i).first();
    if ((await panel.count()) > 0 && (await panel.isVisible().catch(() => false))) {
      return true;
    }
    await page.waitForTimeout(400);
  }
  return false;
}

async function clickActionTile(page, names) {
  const patterns = Array.isArray(names) ? names : [names];
  for (const name of patterns) {
    const re = name instanceof RegExp ? name : new RegExp(`^${name}$`, 'i');
    // Tuiles iconify (structure Deciplus nextgen)
    const tile = page.locator('div.iconify.ari-cursor-pointer, div.ari-flex.niceRow div.item').filter({ hasText: re }).first();
    if ((await tile.count()) > 0 && (await tile.isVisible().catch(() => false))) {
      await tile.click({ force: true });
      return String(name);
    }
    const byText = page.getByText(re).first();
    if ((await byText.count()) > 0 && (await byText.isVisible().catch(() => false))) {
      await byText.click({ force: true });
      return String(name);
    }
  }

  // Repli JS exact
  return page.evaluate((labels) => {
    const nodes = [...document.querySelectorAll('div.iconify, div.item, div, button, a, span')];
    for (const label of labels) {
      const re = new RegExp(`^${label}$`, 'i');
      for (const el of nodes) {
        const t = String(el.textContent || '').replace(/\s+/g, ' ').trim();
        if (re.test(t)) {
          el.click();
          return label;
        }
      }
    }
    return null;
  }, patterns.map((p) => (p instanceof RegExp ? p.source.replace(/^\^|\$$/g, '') : String(p))));
}

async function selectVirement(page) {
  const hit = await clickActionTile(page, [/^Virement$/i]);
  if (hit) return true;
  return clickFirst(page, sel('payment_finalize.virement'));
}

async function clickAppliquerQuitter(page) {
  const btn = page
    .locator('button.ari-button-filled:has-text("Appliquer et Quitter"), button:has-text("Appliquer et Quitter")')
    .first();
  if ((await btn.count()) > 0 && (await btn.isVisible().catch(() => false))) {
    await btn.click({ force: true });
    return true;
  }
  const apply = page.locator('button:has-text("Appliquer")').first();
  if ((await apply.count()) > 0 && (await apply.isVisible().catch(() => false))) {
    await apply.click({ force: true });
    return true;
  }
  return page.evaluate(() => {
    const hit = [...document.querySelectorAll('button')].find((b) =>
      /Appliquer et Quitter|^Appliquer$/i.test(String(b.textContent || '').trim())
    );
    if (!hit) return false;
    hit.click();
    return true;
  });
}

async function confirmModal(page) {
  for (const ctx of getScopes(page)) {
    try {
      const btn = ctx.getByRole('button', { name: /^Confirmer$/i }).first();
      if ((await btn.count()) > 0 && (await btn.isVisible().catch(() => false))) {
        await btn.click({ force: true });
        return true;
      }
    } catch {
      /* ignore */
    }
  }
  return page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((el) =>
      /^Confirmer$/i.test(String(el.textContent || '').trim())
    );
    if (!b) return false;
    b.click();
    return true;
  });
}

async function cancelOneContract(page, contract) {
  const opened = await openContractPage(page, contract);
  if (!opened) {
    logWarn('Navigation contrat échouée', { idc: contract.idc, url: page.url() });
    return { cancelled: false, reason: 'contract_nav_failed', idc: contract.idc };
  }

  if (!(await waitActionPanel(page))) {
    logWarn('Panneau Action souhaitée introuvable', { idc: contract.idc, url: page.url() });
    return { cancelled: false, reason: 'action_panel_missing', idc: contract.idc };
  }

  // Préférer Annuler la vente ; sinon Résilier
  let mode = await clickActionTile(page, [/Annuler la vente/i, /^Annuler la ver/i]);
  if (!mode) {
    mode = await clickActionTile(page, [/^Résilier$/i]);
    if (mode) mode = 'resilier';
  } else {
    mode = 'annuler_vente';
  }

  if (!mode) {
    logWarn('Annuler/Résilier introuvable', { idc: contract.idc, url: page.url() });
    return { cancelled: false, reason: 'annuler_vente_missing', idc: contract.idc };
  }
  await randomDelay(800, 1200);

  if (mode === 'annuler_vente') {
    const virement = await selectVirement(page);
    if (!virement) {
      return { cancelled: false, reason: 'virement_missing', idc: contract.idc };
    }
    await randomDelay(600, 1000);
  }

  const applied = await clickAppliquerQuitter(page);
  if (!applied) {
    return { cancelled: false, reason: 'appliquer_quitter_missing', idc: contract.idc };
  }
  await randomDelay(800, 1200);

  if (mode === 'annuler_vente') {
    await confirmModal(page);
  }

  await randomDelay(1500, 2200);
  await closeGreyboxIfOpen(page);

  logInfo('Vente annulée Deciplus', {
    idc: contract.idc,
    mode,
    label: contract.label?.slice(0, 80),
  });
  return {
    cancelled: true,
    reason: 'ok',
    mode,
    idc: contract.idc,
    label: contract.label,
  };
}

async function cancelAllMemberSales(page, memberId, { maxSales = 15 } = {}) {
  let total = 0;
  const details = [];
  const doneIds = new Set();

  for (let i = 0; i < maxSales; i += 1) {
    await openMemberCheck(page, memberId);
    await randomDelay(1200, 1800);

    let contracts = await findActiveContracts(page);
    contracts = contracts.filter((c) => !doneIds.has(c.idc));

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

    const result = await cancelOneContract(page, contracts[0]);
    details.push(result);
    doneIds.add(contracts[0].idc);

    if (result.cancelled) {
      total += 1;
      await randomDelay(800, 1400);
      continue;
    }

    // Contrat déjà annulé / panneau absent → passer au suivant
    if (
      result.reason === 'action_panel_missing' ||
      result.reason === 'annuler_vente_missing' ||
      result.reason === 'contract_nav_failed'
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

async function cancelSale(page, memberId) {
  if (!memberId) throw new Error('member_id requis pour annuler la vente');
  const outcome = await cancelAllMemberSales(page, memberId, { maxSales: 15 });
  if (outcome.cancelled_count === 0) {
    throw new Error(`Annulation vente impossible — ${outcome.details[0]?.reason || 'inconnu'}`);
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
  findActiveContracts,
  findActiveContractBlocks: findActiveContracts,
  cancelOneContract,
  cancelAllMemberSales,
  cancelSale,
};
