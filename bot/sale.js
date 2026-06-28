/**
 * Ventes Deciplus — toutes offres (DUO, Saison, Badge, Essai)
 * Sans module Caisse → via check.php + nextgen/vente
 */
const { randomDelay } = require('../lib/utils');
const { logInfo, logWarn } = require('../lib/logger');
const { buildInternalNote } = require('../lib/normalize');
const { openMemberCheck, clickFirst, fillFirst, sel, closeGreyboxIfOpen } = require('./wallet');
const { ensureDeciplusSaleZone } = require('./deciplus-zone');

async function togglePaiementComptantOff(page) {
  const toggle = page.locator('text=Paiement Comptant').locator('..').locator('input, button, [role="switch"]').first();
  if ((await toggle.count()) > 0) {
    const checked = await toggle.isChecked?.().catch(() => null);
    if (checked !== false) {
      await toggle.click().catch(async () => {
        await page.locator('text=Paiement Comptant').click();
      });
      await randomDelay();
    }
    return true;
  }
  return false;
}

async function selectProductInCatalog(page, productConfig) {
  const name = productConfig.deciplus_product_name || productConfig.label;
  const search =
    productConfig.deciplus_product_search ||
    name.replace(/\s*€.*$/i, '').trim() ||
    name;

  const searchInput = page
    .locator('input[placeholder*="Rechercher un produit"], input[placeholder*="Rechercher"]')
    .first();
  await searchInput.waitFor({ state: 'visible', timeout: 20000 });
  await searchInput.fill(search);
  await randomDelay(1200, 2000);

  const tile = page.locator('.product-wrapper-title').filter({ hasText: name }).first();
  if ((await tile.count()) > 0 && (await tile.isVisible().catch(() => false))) {
    await tile.click();
    await randomDelay();
    return true;
  }

  const byText = page.getByText(name, { exact: true }).first();
  if ((await byText.count()) > 0 && (await byText.isVisible().catch(() => false))) {
    await byText.click();
    await randomDelay();
    return true;
  }

  const partial = page
    .getByText(new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').slice(0, 18), 'i'))
    .first();
  if ((await partial.count()) > 0 && (await partial.isVisible().catch(() => false))) {
    await partial.click();
    await randomDelay();
    return true;
  }

  throw new Error(`Produit Deciplus introuvable: "${name}"`);
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
  if (productConfig.paiement_comptant === false) {
    await togglePaiementComptantOff(page);
  }

  // Si RIB requis et bouton visible dans la modale
  if (productConfig.requires_iban) {
    await clickFirst(page, sel('sale_config_modal.saisir_rib')).catch(() => {});
  }

  await clickFirst(page, sel('sale_config_modal.appliquer'));

  // Popup "Dernière échéance après la date de fin" (badge)
  const modDateFin = page.locator('button:has-text("Modifier la date de fin")').first();
  if ((await modDateFin.count()) > 0 && (await modDateFin.isVisible().catch(() => false))) {
    await modDateFin.click();
    await randomDelay();
  } else {
    await clickFirst(page, sel('sale_config_modal.ignorer_continuer'));
  }
}

async function finalizePayment(page, productConfig) {
  const mode = productConfig.payment_mode || 'virement';

  if (mode === 'virement') {
    await clickFirst(page, sel('payment_finalize.virement'));
  } else if (mode === 'card' || mode === 'cb') {
    await clickFirst(page, sel('payment_finalize.carte_bancaire'));
  }

  // Note / clôturer si présent
  await clickFirst(page, sel('payment_finalize.cloturer'));
  await clickFirst(page, sel('payment_finalize.terminer'));
  logInfo('Paiement finalisé Deciplus', { mode });
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
      const badgeResult = await buyCarteBadge(page, badgeProductConfig, gymConfig);
      result.badge_action = badgeResult.action;
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

/** Conservé pour usage manuel — non appelé par le bot (annulation manuelle dans Deciplus). */
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
