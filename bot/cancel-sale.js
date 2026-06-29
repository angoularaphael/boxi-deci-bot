/**
 * Annulation vente Deciplus — flux coach :
 * prestation → Consulter → Annuler la vente → Virement → Appliquer et Quitter → Confirmer
 */
const { randomDelay } = require('../lib/utils');
const { logInfo } = require('../lib/logger');
const { openMemberCheck, clickFirst, sel, closeGreyboxIfOpen } = require('./wallet');

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

async function findActiveContractBlocks(page) {
  await page
    .waitForSelector(
      'div.og-product-wrapper, div.og-product-item, table.tb-prestation input[value="Consulter"]',
      { timeout: 12000 }
    )
    .catch(() => {});

  const blocks = [];
  for (const ctx of getScopes(page)) {
    try {
      const wrappers = ctx.locator('div.og-product-wrapper');
      const wrapperCount = await wrappers.count();
      for (let w = 0; w < wrapperCount; w += 1) {
        const wrapper = wrappers.nth(w);
        if (!(await wrapper.isVisible().catch(() => false))) continue;

        const item = wrapper.locator('div.og-product-item[id^="prestation_"], div.og-product-item').first();
        const consulter = wrapper
          .locator(
            'input.fichemembre_button_grey[value="Consulter"], input[value="Consulter"], button:has-text("Consulter")'
          )
          .first();

        if ((await item.count()) === 0 || (await consulter.count()) === 0) continue;
        if (!(await consulter.isVisible().catch(() => false))) continue;

        blocks.push({ ctx, item, consulter, wrapper });
      }

      if (blocks.length > 0) continue;

      const consulters = ctx.locator(
        'table.tb-prestation input[value="Consulter"], table.prestacontrat input[value="Consulter"]'
      );
      const count = await consulters.count();
      for (let i = 0; i < count; i += 1) {
        const consulter = consulters.nth(i);
        if (!(await consulter.isVisible().catch(() => false))) continue;
        const table = consulter.locator('xpath=ancestor::table[1]');
        const item = table
          .locator('xpath=preceding::div[contains(@class,"og-product-item")][1]')
          .first();
        blocks.push({
          ctx,
          item: (await item.count()) > 0 ? item : table,
          consulter,
        });
      }
    } catch {
      /* frame détachée */
    }
  }
  return blocks;
}

async function waitForActionPanel(page, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    for (const ctx of getScopes(page)) {
      try {
        const panel = ctx.getByText(/Action souhaitée/i).first();
        if ((await panel.count()) > 0 && (await panel.isVisible().catch(() => false))) {
          return ctx;
        }
      } catch {
        /* ignore */
      }
    }
    await page.waitForTimeout(400);
  }
  return null;
}

async function clickAnnulerLaVente(ctx) {
  const candidates = [
    ctx.getByText('Annuler la vente').first(),
    ctx.locator('[aria-label="Annuler la vente"]').first(),
    ctx.locator('text=Annuler la vente').first(),
  ];
  for (const el of candidates) {
    if ((await el.count()) === 0 || !(await el.isVisible().catch(() => false))) continue;
    await el.click({ force: true });
    return true;
  }
  return clickFirst(ctx, sel('contract_actions.annuler_vente'));
}

async function selectVirementPayment(ctx) {
  const candidates = [
    ctx.getByText(/^Virement$/i).first(),
    ctx.locator('text=Virement').first(),
  ];
  for (const el of candidates) {
    if ((await el.count()) === 0 || !(await el.isVisible().catch(() => false))) continue;
    await el.click({ force: true });
    return true;
  }
  return clickFirst(ctx, sel('payment_finalize.virement'));
}

async function clickAppliquerEtQuitter(ctx) {
  const btn = ctx
    .locator('button.ari-button-filled:has-text("Appliquer et Quitter"), button:has-text("Appliquer et Quitter")')
    .first();
  if ((await btn.count()) > 0 && (await btn.isVisible().catch(() => false))) {
    await btn.click({ force: true });
    return true;
  }
  return clickFirst(ctx, sel('contract_actions.appliquer_quitter'));
}

async function confirmCancelSaleModal(page) {
  for (const ctx of getScopes(page)) {
    try {
      const btn = ctx
        .locator('button:has-text("Confirmer"), button.ari-button:has-text("Confirmer")')
        .filter({ hasText: /^Confirmer$/i })
        .first();
      if ((await btn.count()) > 0 && (await btn.isVisible().catch(() => false))) {
        await btn.click({ force: true });
        return true;
      }
      const textBtn = ctx.getByRole('button', { name: /^Confirmer$/i }).first();
      if ((await textBtn.count()) > 0 && (await textBtn.isVisible().catch(() => false))) {
        await textBtn.click({ force: true });
        return true;
      }
    } catch {
      /* ignore */
    }
  }
  return clickFirst(page, sel('contract_actions.confirmer_annulation'));
}

async function cancelOneContract(page, block) {
  const { item, consulter } = block;

  await item.scrollIntoViewIfNeeded().catch(() => {});
  await item.click({ force: true });
  await randomDelay(500, 800);

  await consulter.scrollIntoViewIfNeeded().catch(() => {});
  await consulter.click({ force: true });
  await randomDelay(1500, 2200);

  const actionCtx = (await waitForActionPanel(page)) || page;

  const annuler = await clickAnnulerLaVente(actionCtx);
  if (!annuler) {
    await closeGreyboxIfOpen(page);
    return { cancelled: false, reason: 'annuler_vente_missing' };
  }
  await randomDelay(800, 1200);

  const virement = await selectVirementPayment(actionCtx);
  if (!virement) {
    await closeGreyboxIfOpen(page);
    return { cancelled: false, reason: 'virement_missing' };
  }
  await randomDelay(600, 1000);

  const applied = await clickAppliquerEtQuitter(actionCtx);
  if (!applied) {
    await closeGreyboxIfOpen(page);
    return { cancelled: false, reason: 'appliquer_quitter_missing' };
  }
  await randomDelay(800, 1200);

  const confirmed = await confirmCancelSaleModal(page);
  if (!confirmed) {
    await closeGreyboxIfOpen(page);
    return { cancelled: false, reason: 'confirmer_missing' };
  }

  await randomDelay(1500, 2200);
  await closeGreyboxIfOpen(page);
  return { cancelled: true, reason: 'ok' };
}

async function memberHasActiveContracts(page) {
  const blocks = await findActiveContractBlocks(page);
  return blocks.length > 0;
}

async function cancelNextMemberSale(page, memberId) {
  await openMemberCheck(page, memberId);
  await randomDelay(800, 1200);

  const blocks = await findActiveContractBlocks(page);
  if (blocks.length === 0) {
    return { cancelled: false, reason: 'no_active_sale' };
  }

  const result = await cancelOneContract(page, blocks[0]);
  if (result.cancelled) {
    logInfo('Vente test annulée', { member_id: memberId });
  }
  return result;
}

async function cancelAllMemberSales(page, memberId, { maxSales = 15 } = {}) {
  let total = 0;
  const details = [];

  for (let i = 0; i < maxSales; i += 1) {
    const result = await cancelNextMemberSale(page, memberId);
    details.push(result);
    if (!result.cancelled) break;
    total += 1;
  }

  return { member_id: memberId, cancelled_count: total, details };
}

async function cancelSale(page, memberId) {
  if (!memberId) throw new Error('member_id requis pour annuler la vente');
  const outcome = await cancelAllMemberSales(page, memberId, { maxSales: 1 });
  if (outcome.cancelled_count === 0) {
    throw new Error(`Annulation vente impossible — ${outcome.details[0]?.reason || 'inconnu'}`);
  }
  logInfo('Vente annulée Deciplus', { member_id: memberId });
  return { action: 'sale_cancelled', sale_type: 'cancel' };
}

module.exports = {
  findActiveContractBlocks,
  memberHasActiveContracts,
  cancelOneContract,
  cancelNextMemberSale,
  cancelAllMemberSales,
  cancelSale,
};
