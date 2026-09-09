#!/usr/bin/env node
/**
 * Phase 2 — Bot RPA Deciplus : traite la file d'attente BOXPLUS.
 */
require('dotenv').config();
// Même si lancé sans start.js (BotHosting) — installer imapflow/mailparser
try {
  const { ensureOtpDeps } = require('../lib/ensure-deps');
  const otp = ensureOtpDeps();
  if (!otp.ok) {
    console.warn('[BOXPLUS] WARN: IMAP OTP deps absentes — login 2FA échouera jusqu’à npm install');
  }
} catch (err) {
  console.warn('[BOXPLUS] WARN: ensure-deps:', err.message);
}
// Mode rapide par défaut (vérif / résiliation / changement) — désactiver avec DECIPLUS_FAST=0
if (process.env.DECIPLUS_FAST == null || process.env.DECIPLUS_FAST === '') {
  process.env.DECIPLUS_FAST = '1';
}

const { login, isMfaAuthError, isSessionRecoverableError, isAuthBlocked } = require('./auth');
const {
  runWithSession,
  closeBrowser,
  sessionFileChanged,
  syncLoadedStorageMtime,
  hasActiveBrowser,
} = require('./browser-pool');
const { findOrCreateMember, detectMemberGymConfig, resetMemberSearchContext, uploadMemberPhoto, findMemberByIdentity, defaultSeancePhotoPath } = require('./member');
const { createGymConfig, isEtatsUnisDeciplusSite } = require('../lib/deciplus-sites');
const { recordSale } = require('./sale');
const { setMemberIban, openMemberCheck } = require('./wallet');
const { isValidFrenchIban } = require('../lib/iban');
const {
  listPending,
  updateJob,
  removeJob,
  markProcessed,
  isProcessed,
  getProcessedRecord,
  STATUS,
  getQueueStats,
  requeueInterruptedJobs,
  finalizeExhaustedJobs,
} = require('../lib/queue');
const {
  normalizeOrder,
  validateOrder,
  getGymConfig,
} = require('../lib/normalize');
const { fetchDeciplusCatalog, resolveProductConfig, resolveBadgeProductConfig } = require('./catalog');
const {
  applyBillingPlanToProductConfig,
  isPayplug4xPrelevementOrder,
  orderNeedsAutoBadge,
} = require('../lib/billing-plan');
const { isCartePrestationConfig } = require('../lib/catalog-sale');
const { logInfo, logError, logWarn, sendAlert, logJobEvent } = require('../lib/logger');
const { getBotId, wrongSalesBotReject } = require('../lib/sales-bot');
const { sleep } = require('../lib/utils');
const idempotency = require('../lib/persistent-idempotency');
const { STATES } = require('../lib/job-lifecycle');
const { classifyError, backoffMs } = require('../lib/retry-policy');
const {
  failoverAfterAttempts,
  shouldFailoverSale,
  handoffFailedSale,
} = require('../lib/bot-failover');
const {
  maybeKeepSessionAlive,
  forceRefreshSession,
  touchKeepAliveClock,
} = require('./session-keepalive');

const MAX_RETRIES = Number(process.env.BOT_MAX_RETRIES || 3);
const POLL_MS = Number(process.env.BOT_POLL_MS || 5000);
const CATALOG_PUSH_MS = Number(process.env.BOT_CATALOG_PUSH_MS || 6 * 60 * 60 * 1000);
const CATALOG_TTL_MS = Number(process.env.BOT_CATALOG_TTL_MS || 10 * 60 * 1000);
const STALE_PROCESSING_MS = Number(process.env.BOT_STALE_PROCESSING_MS || 3 * 60 * 1000);

let catalogCache = { at: 0, data: null };

async function getCachedCatalog(page) {
  if (catalogCache.data && Date.now() - catalogCache.at < CATALOG_TTL_MS) {
    return catalogCache.data;
  }
  const data = await fetchDeciplusCatalog(page);
  catalogCache = { at: Date.now(), data };
  return data;
}

async function maybePushCatalog() {
  if (String(process.env.BOT_CATALOG_PUSH_ENABLED || 'true').toLowerCase() === 'false') return;
  if (listPending().length > 0) {
    logWarn('Sync catalogue reportée — jobs en cours (une seule session Deciplus)');
    return;
  }
  try {
    await runWithSession('catalog-sync', async (page, context) => {
      await login(page);
      const { syncAndPushCatalog } = require('../lib/catalog-sync');
      await syncAndPushCatalog({ page, context, force: true, saveFile: true });
    });
  } catch (err) {
    logWarn('Sync/push catalogue en échec', { error: err.message });
  }
}

async function processCancelJob(page, order) {
  const { cancelSale } = require('./cancel-sale');
  const { searchMember } = require('./member');

  const identity = {
    first_name: order.customer?.first_name || order.first_name,
    last_name: order.customer?.last_name || order.last_name,
    birthdate: order.customer?.birthdate || order.birthdate,
    phone: order.customer?.phone || order.phone,
    email: order.customer?.email || order.email,
    address: order.customer?.address || order.address,
    postal_code: order.customer?.postal_code || order.postal_code,
    city: order.customer?.city || order.city,
  };

  const storeBase = (
    order.status_callback_base ||
    process.env.BOXPLUS_STORE_URL ||
    process.env.STORE_URL ||
    ''
  ).replace(/\/$/, '');
  const storeSecret = process.env.SYNC_SECRET || process.env.ADMIN_SECRET || '';

  const pushCancelStatus = async (
    status,
    { reason = null, mismatchFields = [], cancelledCount = null, memberId = null } = {}
  ) => {
    if (!storeBase || !storeSecret) return false;
    try {
      const res = await fetch(`${storeBase}/api/internal/cancel-status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-sync-secret': storeSecret },
        body: JSON.stringify({
          order_id: order.order_id,
          status,
          reason,
          mismatch_fields: mismatchFields,
          cancelled_count: cancelledCount,
          deciplus_member_id: memberId,
          customer: identity,
        }),
      });
      if (!res.ok) {
        const bodyText = await res.text().catch(() => '');
        logWarn('Statut résiliation boutique échoué', {
          status: res.status,
          body: String(bodyText).slice(0, 240),
        });
      }
      return res.ok;
    } catch (err) {
      logWarn('Statut résiliation boutique non envoyé', { error: err.message });
      return false;
    }
  };

  // Fallback autonome (BotHosting n'a pas le module storefront)
  const sendMismatchEmailDirect = async (mismatchFields = []) => {
    const apiKey = String(process.env.BREVO_API_KEY || '').trim().replace(/^["']|["']$/g, '');
    if (!identity.email || !apiKey.startsWith('xkeysib-')) return false;
    const labels = { last_name: 'Nom', first_name: 'Prénom', phone: 'Téléphone', birthdate: 'Date de naissance' };
    const fields = mismatchFields.map((f) => labels[f]).filter(Boolean);
    const html = `<p>Bonjour ${identity.first_name || ''},</p>
      <p>Nous avons bien reçu votre demande de résiliation, mais <strong>les informations renseignées ne correspondent pas</strong> à celles enregistrées sur votre fiche adhérent Boxing Center.</p>
      <p>Pour des raisons de sécurité, une seule information incorrecte (nom, prénom, téléphone ou date de naissance) empêche le traitement automatique.</p>
      ${fields.length ? `<p>Champ(s) en cause : <strong>${fields.join(', ')}</strong>.</p>` : ''}
      <p>Merci de vérifier vos informations puis de renouveler la demande depuis <a href="https://boutique.boxingcenter.fr/gerer-abonnement">Gérer mon abonnement</a>.</p>
      <p>Sportivement,<br/>Boxing Center</p>`;
    try {
      const res = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'api-key': apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          sender: {
            name: process.env.BREVO_SENDER_NAME || 'Boxing Center',
            email: process.env.BREVO_SENDER_EMAIL || 'suzinabot@gmail.com',
          },
          to: [{ email: identity.email }],
          subject: 'Résiliation — informations à vérifier — Boxing Center',
          htmlContent: html,
        }),
      });
      return res.ok;
    } catch {
      return false;
    }
  };

  const notifyMismatch = async (reason, mismatchFields = []) => {
    try {
      // Le storefront envoie l'email + met à jour le statut (spinner front)
      let sent = await pushCancelStatus('mismatch', { reason, mismatchFields });
      if (!sent) {
        sent = await sendMismatchEmailDirect(mismatchFields);
        if (sent) logInfo('Email mismatch résiliation envoyé (Brevo direct)', { email: identity.email });
      }
      if (!sent) {
        logWarn('Email mismatch résiliation — aucun canal disponible', { reason });
      }
    } catch (err) {
      logWarn('Email mismatch résiliation non envoyé', { error: err.message, reason });
    }
  };

  let memberId = order.deciplus_member_id || null;
  if (!memberId && (identity.first_name || identity.last_name)) {
    const { CHANGE_MATCH_FIELDS } = require('./member');
    const { findMemberOnBoxingCenterGyms } = require('./search-bc-gyms');
    const { resolveSearchGymSlug } = require('../lib/gym-slugs');
    const cancelReason = String(order.cancel_reason || '').toLowerCase();
    // Changement d’abo : même règle que verify_identity (nom/prénom/naissance, pas téléphone)
    const matchFields =
      cancelReason === 'change_to_comptant' || cancelReason.startsWith('change_')
        ? CHANGE_MATCH_FIELDS
        : undefined;
    const match = await findMemberOnBoxingCenterGyms(page, identity, {
      matchFields,
      preferredGym: resolveSearchGymSlug(order.gym),
      allowBalmaLookup: false,
    });
    if (!match.found) {
      await notifyMismatch(match.reason || 'identity_mismatch', match.mismatch_fields || []);
      return {
        status: STATUS.MANUAL_REVIEW,
        action: 'cancel',
        error:
          'Les informations renseignées ne correspondent pas à la fiche adhérent. Un e-mail a été envoyé pour demander de vérifier les données.',
        cancel_reason: order.cancel_reason,
        mismatch: true,
        mismatch_reason: match.reason || 'identity_mismatch',
        mismatch_fields: match.mismatch_fields || [],
      };
    }
    memberId = match.member_id;
  }
  if (!memberId && identity.email) {
    const byEmail = await searchMember(page, identity.email);
    if (byEmail.found) memberId = byEmail.member_id;
  }
  if (!memberId && identity.phone) {
    const byPhone = await searchMember(page, identity.phone);
    if (byPhone.found) memberId = byPhone.member_id;
  }
  if (!memberId) {
    // Pas de champs ciblés : on n’a pas pu comparer à une fiche
    await notifyMismatch('not_found', []);
    return {
      status: STATUS.MANUAL_REVIEW,
      action: 'cancel',
      error:
        'Les informations renseignées ne correspondent pas à la fiche adhérent. Un e-mail a été envoyé pour demander de vérifier les données.',
      cancel_reason: order.cancel_reason,
      mismatch: true,
    };
  }

  // Identité OK → le front peut afficher « résiliation sera traitée » sans attendre Deciplus
  await pushCancelStatus('verified', { memberId });

  try {
    const result = await cancelSale(page, memberId, {
      cancelDate: order.cancel_date || order.effective_date || null,
      cancelReason: order.cancel_reason || null,
    });
    if (result?.refused && result.reason === 'comptant_refused') {
      await pushCancelStatus('error', {
        reason:
          'Formule comptant détectée — résiliation web réservée aux prélèvements. Contactez votre manager en salle.',
        memberId,
      });
      return {
        status: STATUS.MANUAL_REVIEW,
        action: 'cancel',
        error:
          'Résiliation refusée : formule comptant. Contactez le manager de votre salle en présentiel.',
        cancel_reason: order.cancel_reason,
        refused: true,
        reason: 'comptant_refused',
      };
    }
    await pushCancelStatus('done', { cancelledCount: result?.cancelled_count ?? null, memberId });
    try {
      const { reconcileActiveBadges } = require('./sale');
      const { resolveSaleGymConfig } = require('../lib/gym-slugs');
      const gymConfig = resolveSaleGymConfig(getGymConfig(order.gym || 'minimes'));
      await reconcileActiveBadges(page, memberId, gymConfig, { keepOne: true });
    } catch (err) {
      logWarn('Badges orphelins non alignés après résiliation', {
        member_id: memberId,
        error: err.message,
      });
    }
    return {
      status: STATUS.SUCCESS,
      action: 'cancel',
      deciplus_member_id: memberId,
      cancel_reason: order.cancel_reason,
      ...result,
    };
  } catch (err) {
    await pushCancelStatus('error', { reason: err.message, memberId });
    throw err;
  }
}

function memberZonesMatch(memberSite, gymConfig) {
  const memberZone = String(memberSite?.deciplus_zone_id || '').trim();
  const wantZone = String(gymConfig?.deciplus_zone_id || '').trim();
  if (memberZone && wantZone) return memberZone === wantZone;
  const memberLabel = String(memberSite?.deciplus_label || '').trim().toLowerCase();
  const wantLabel = String(gymConfig?.deciplus_label || '').trim().toLowerCase();
  return Boolean(memberLabel && wantLabel && memberLabel === wantLabel);
}

async function alignMemberGymForSale(page, memberId, order, memberSite) {
  const { isBalmaSaleTarget, resolveSaleGymConfig } = require('../lib/gym-slugs');
  const { migrateMemberToGym } = require('./migrate-gym');
  const orderGymConfig = resolveSaleGymConfig(getGymConfig(order.gym), order);
  let gymConfig = orderGymConfig;

  if (memberSite && isBalmaSaleTarget(memberSite, {})) {
    gymConfig = createGymConfig('minimes');
    await migrateMemberToGym(page, memberId, gymConfig);
    logInfo('Migration Balma → Minimes obligatoire avant vente', {
      order_id: order.order_id,
      member_id: memberId,
      ordered_gym: order.gym || null,
    });
    return gymConfig;
  }

  if (String(order.gym || '').toLowerCase() === 'etats-unis') {
    gymConfig = createGymConfig('etats-unis');
    if (memberSite && isEtatsUnisDeciplusSite(memberSite)) {
      await migrateMemberToGym(page, memberId, gymConfig);
      logInfo('Migration États-Unis → Minimes avant vente', {
        order_id: order.order_id,
        member_id: memberId,
        from_zone: memberSite.deciplus_zone_id || null,
      });
    }
    return gymConfig;
  }

  if (memberSite && !memberZonesMatch(memberSite, orderGymConfig)) {
    await migrateMemberToGym(page, memberId, orderGymConfig);
    logWarn('Fiche Deciplus migrée vers la salle commandée', {
      order_id: order.order_id,
      member_id: memberId,
      ordered: orderGymConfig.deciplus_label,
      from: memberSite.deciplus_label,
      from_zone: memberSite.deciplus_zone_id || null,
      to_zone: orderGymConfig.deciplus_zone_id || null,
    });
  } else if (
    memberSite?.deciplus_label &&
    memberSite.deciplus_label !== orderGymConfig.deciplus_label
  ) {
    logWarn('Fiche Deciplus sur un autre club que la commande — vente sur la salle commandée', {
      order_id: order.order_id,
      member_id: memberId,
      ordered: orderGymConfig.deciplus_label,
      fiche: memberSite.deciplus_label,
      zone: memberSite.deciplus_zone_id || null,
    });
  }

  return orderGymConfig;
}

async function processSaleJob(page, order, jobMeta = {}) {
  const t0 = Date.now();
  const mark = (label) => logInfo(`Timing bot · ${label}`, { order_id: order.order_id, ms: Date.now() - t0 });
  const filePath = jobMeta.file || null;
  const checkpoint = jobMeta.checkpoint || order.checkpoint || {};

  const saveCheckpoint = async (patch) => {
    try {
      const next = { ...(checkpoint || {}), ...patch, at: new Date().toISOString() };
      Object.assign(checkpoint, next);
      if (filePath) updateJob(filePath, { checkpoint: next });
      await idempotency.checkpoint(order.order_id, 'sale', {
        status: 'processing',
        lifecycle_state: patch.lifecycle_state || null,
        attempt: Number(jobMeta.attempt || 1),
        member_id: next.deciplus_member_id || null,
        sale_id: next.deciplus_sale_id || null,
        metadata: {
          step: next.step || null,
          photo_done: Boolean(next.photo_done),
          iban_done: Boolean(next.iban_done),
          sale_done: Boolean(next.sale_done),
        },
      });
    } catch (err) {
      err.message = `Checkpoint persistant requis — ${err.message}`;
      throw err;
    }
  };

  const catalog = await getCachedCatalog(page);
  mark('catalog');
  const productConfig = applyBillingPlanToProductConfig(
    resolveProductConfig(order, catalog),
    order
  );
  if (!order.gym) {
    return {
      status: STATUS.MANUAL_REVIEW,
      error: 'Salle (gym) manquante sur la commande',
    };
  }
  let gymConfig = getGymConfig(order.gym);
  const { isBalmaSaleTarget, resolveSaleGymConfig } = require('../lib/gym-slugs');
  if (isBalmaSaleTarget(gymConfig, order)) {
    logWarn('Commande Balma — vente forcée Minimes (Balma n’est plus une salle Boxing Center)', {
      order_id: order.order_id,
      requested_gym: order.gym || null,
    });
    order.gym = 'minimes';
  }
  gymConfig = resolveSaleGymConfig(gymConfig, order);

  if (isPayplug4xPrelevementOrder(order)) {
    productConfig.auto_badge = false;
    productConfig.paiement_comptant = false;
  }

  const { isAnnualPromoProduct } = require('../lib/sale-contract-match');
  if (isAnnualPromoProduct(productConfig) || isAnnualPromoProduct(order)) {
    productConfig.auto_badge = false;
    if (!isPayplug4xPrelevementOrder(order)) {
      productConfig.paiement_comptant = true;
      productConfig.requires_iban = false;
      productConfig.skip_rib_prompt = true;
    }
  }

  productConfig.auto_badge =
    !isCartePrestationConfig(productConfig) && orderNeedsAutoBadge(order, productConfig);

  let badgeProductConfig = null;
  if (productConfig.auto_badge && !isCartePrestationConfig(productConfig)) {
    try {
      badgeProductConfig = resolveBadgeProductConfig(catalog, {
        badge_timing: order.badge_timing || order.payment?.badge_timing || 'deferred',
        badge_method: order.badge_method || order.payment?.badge_method || 'iban',
      });
    } catch (err) {
      logWarn('Badge non ajouté automatiquement', { order_id: order.order_id, error: err.message });
    }
  }

  // Changement d’abo / reprise : l’id membre est déjà connu — ne pas re-chercher
  let memberId =
    checkpoint.deciplus_member_id ||
    order.deciplus_member_id ||
    order.customer?.deciplus_member_id ||
    null;
  let memberResult = {
    member_id: memberId,
    action: memberId ? (checkpoint.deciplus_member_id ? 'checkpoint_resume' : 'order_member_id') : null,
  };

  if (!memberId) {
    const { boutiqueSaleDispatchAllowed } = require('../lib/sale-dispatch-policy');
    if (!boutiqueSaleDispatchAllowed(order)) {
      const err =
        'Dispatch refusé — signature ou ready_for_dispatch requis avant création membre Deciplus';
      logWarn('Création membre bloquée (commande non signée)', {
        order_id: order.order_id,
        signed_at: order.signature?.signed_at || null,
        ready_for_dispatch: Boolean(order.ready_for_dispatch),
      });
      return {
        status: STATUS.REJECTED,
        error: err,
      };
    }
    // Toujours rechercher une fiche strictement concordante avant création.
    // Un crash entre la création Deciplus et le checkpoint ne doit jamais créer un second membre.
    if (order.force_new_member !== true) order.force_new_member = false;
    memberResult = await findOrCreateMember(page, order, gymConfig);
    mark('member');

    if (memberResult.duplicate) {
      await sendAlert(`Doublon Deciplus — commande ${order.order_id}`, {
        order_id: order.order_id,
        message: memberResult.message,
      });
      return {
        status: STATUS.MANUAL_REVIEW,
        error: memberResult.message,
        deciplus_member_id: memberResult.member_id || null,
      };
    }

    memberId = memberResult.member_id;
    if (memberResult.gymConfig && memberResult.gymConfig.deciplus_label !== gymConfig.deciplus_label) {
      logWarn('Fiche existante sur un autre club Deciplus — la commande garde sa salle', {
        order_id: order.order_id,
        ordered: gymConfig.deciplus_label,
        found: memberResult.gymConfig.deciplus_label,
        member_id: memberId,
      });
    }
    if (!memberId) {
      return {
        status: STATUS.MANUAL_REVIEW,
        error: 'member_id Deciplus manquant après création — membre non visible / non finalisé',
        member_action: memberResult.action,
      };
    }
    await saveCheckpoint({
      step: 'member',
      lifecycle_state: STATES.MEMBER_CREATED,
      deciplus_member_id: memberId,
    });
    if (memberResult.action === 'created') {
      logInfo('Nouveau membre Deciplus créé — pas d’alerte admin', {
        order_id: order.order_id,
        member_id: memberId,
      });
    }
  } else {
    logInfo('Reprise job — membre déjà créé', { order_id: order.order_id, member_id: memberId });
    mark('member_resume');
  }

  const orderGymConfig = getGymConfig(order.gym);
  const { resolveMemberSiteConfig } = require('./member');
  await openMemberCheck(page, memberId, orderGymConfig).catch(() => {});
  let memberSite = await resolveMemberSiteConfig(page, memberId, orderGymConfig);
  gymConfig = await alignMemberGymForSale(page, memberId, order, memberSite);
  await openMemberCheck(page, memberId, gymConfig).catch(() => {});
  memberSite = await resolveMemberSiteConfig(page, memberId, gymConfig);

  if (isBalmaSaleTarget(memberSite, order)) {
    return {
      status: STATUS.MANUAL_REVIEW,
      error: 'Fiche adhérent encore sur Balma après migration — reprise manuelle',
      deciplus_member_id: memberId,
    };
  }

  let photoResult = null;
  const gratuit =
    String(order.product_id || '').includes('offerte') ||
    /GRATUITE WEB/i.test(String(order.product_name || '')) ||
    (Number(order.payment?.amount || 0) === 0 && /essai/i.test(String(order.product_name || '')));
  if (gratuit) {
    const fallback = defaultSeancePhotoPath();
    if (fallback) {
      const fs = require('fs');
      order.photo_path = fallback;
      order.photo_base64 = `data:image/jpeg;base64,${fs.readFileSync(fallback).toString('base64')}`;
      order.photo_url = 'https://seance-offerte.boxingcenter.fr/seance-essai-photo.jpg';
    }
  }
  if (!checkpoint.photo_done && (order.photo_path || order.photo_base64 || order.photo_url)) {
    // Attendre la fin des redirections de création membre avant l'appel API photo.
    // Ne pas rouvrir la fiche ici : cela détruisait le contexte pendant page.evaluate.
    await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(600);
    photoResult = await uploadMemberPhoto(
      page,
      order.photo_path,
      order.photo_base64,
      memberId,
      order.photo_url
    ).catch((err) => ({
      ok: false,
      reason: err.message,
    }));
    mark('photo');
    if (!photoResult?.ok) {
      logWarn('Photo non uploadée dans Deciplus', {
        order_id: order.order_id,
        reason: photoResult?.reason,
        body: photoResult?.body,
      });
    } else {
      await saveCheckpoint({ step: 'photo', deciplus_member_id: memberId, photo_done: true });
      if (memberId) {
        await openMemberCheck(page, memberId).catch(() => {});
      }
    }
  }

  let saleResult = { sale_id: checkpoint.deciplus_sale_id || null };
  let ibanError = null;

  const needsIban =
    productConfig.requires_iban === true && productConfig.paiement_comptant !== true;
  const iban = order.payment.iban;
  const paidFirstMonth = order.payment?.status === 'paid';

  const deferIbanIfPaid = (error) => {
    if (!paidFirstMonth) return false;
    ibanError = error;
    logWarn('RIB Deciplus non enregistré — vente quand même (1er mois déjà payé)', {
      order_id: order.order_id,
      member_id: memberId,
      error,
    });
    return true;
  };

  if (!checkpoint.iban_done) {
    if (needsIban && productConfig.sale_type !== 'none') {
      if (!iban) {
        if (!deferIbanIfPaid('IBAN requis pour cette offre')) {
          return {
            status: STATUS.MANUAL_REVIEW,
            error: 'IBAN requis pour cette offre',
            deciplus_member_id: memberId,
          };
        }
      } else if (!isValidFrenchIban(iban)) {
        if (!deferIbanIfPaid('IBAN français invalide')) {
          return {
            status: STATUS.MANUAL_REVIEW,
            error: 'IBAN français invalide',
            deciplus_member_id: memberId,
          };
        }
      } else if (memberId) {
        try {
          await setMemberIban(page, memberId, iban, order.customer, gymConfig);
          mark('iban');
          await saveCheckpoint({
            step: 'iban',
            lifecycle_state: STATES.MANDATE_SET,
            deciplus_member_id: memberId,
            iban_done: true,
          });
        } catch (err) {
          if (!deferIbanIfPaid(err.message)) throw err;
        }
      }
    } else if (iban && memberId) {
      if (!isValidFrenchIban(iban)) {
        if (!deferIbanIfPaid('IBAN français invalide')) {
          return {
            status: STATUS.MANUAL_REVIEW,
            error: 'IBAN français invalide',
            deciplus_member_id: memberId,
          };
        }
      } else {
        try {
          await setMemberIban(page, memberId, iban, order.customer, gymConfig);
          mark('iban');
          await saveCheckpoint({
            step: 'iban',
            lifecycle_state: STATES.MANDATE_SET,
            deciplus_member_id: memberId,
            iban_done: true,
          });
        } catch (err) {
          if (!deferIbanIfPaid(err.message)) throw err;
        }
      }
    }
  }

  const paid = String(order.payment?.status || '').toLowerCase() === 'paid';
  const needsSale =
    productConfig.create_sale !== false && String(productConfig.sale_type || '').toLowerCase() !== 'none';

  const badgeDone =
    !badgeProductConfig ||
    /created|already_on_file/i.test(String(checkpoint.badge_action || saleResult?.badge_action || ''));
  if (checkpoint.sale_done && checkpoint.deciplus_sale_id && badgeDone) {
    logInfo('Reprise job — vente déjà enregistrée', {
      order_id: order.order_id,
      sale_id: checkpoint.deciplus_sale_id,
    });
    saleResult = {
      sale_id: checkpoint.deciplus_sale_id,
      action: 'checkpoint_resume',
      badge_action: checkpoint.badge_action || null,
    };
  } else if (productConfig.requires_payment !== false && paid) {
    if (ibanError) {
      const { shouldFallbackToComptantOnIbanError } = require('../lib/billing-plan');
      if (shouldFallbackToComptantOnIbanError(order, productConfig)) {
        productConfig.paiement_comptant = true;
        productConfig.requires_iban = false;
        productConfig.skip_rib_prompt = true;
        logWarn('IBAN absent — vente Deciplus en comptant (1er mois déjà payé)', {
          order_id: order.order_id,
          member_id: memberId,
        });
      } else {
        logWarn('IBAN absent — vente Deciplus en prélèvement (échéancier requis, 1er mois déjà payé)', {
          order_id: order.order_id,
          member_id: memberId,
        });
      }
    }
    if (checkpoint.sale_done && checkpoint.deciplus_sale_id && !order.deciplus_sale_id) {
      order.deciplus_sale_id = checkpoint.deciplus_sale_id;
    }
    saleResult = await recordSale(page, order, productConfig, memberId, gymConfig, {
      badgeProductConfig,
    });
    const saleOk = Boolean(saleResult.sale_id);
    mark('sale');
    await saveCheckpoint({
      step: 'sale',
      lifecycle_state: saleOk ? STATES.SALE_CREATED : null,
      deciplus_member_id: memberId,
      sale_done: saleOk,
      deciplus_sale_id: saleResult.sale_id || null,
      badge_action: saleResult.badge_action || null,
    });
    if (needsSale && !saleOk && !saleResult.manual_review) {
      throw new Error('Vente Deciplus non confirmée (sale_id manquant)');
    }
  } else if (productConfig.sale_type === 'none') {
    saleResult = await recordSale(page, order, productConfig, memberId, gymConfig, {
      badgeProductConfig,
    });
    mark('sale');
    await saveCheckpoint({
      step: 'sale',
      lifecycle_state: STATES.VERIFIED,
      deciplus_member_id: memberId,
      sale_done: true,
      deciplus_sale_id: null,
    });
  }

  if (paid && needsSale && !saleResult.sale_id && !saleResult.manual_review && !ibanError) {
    throw new Error('Vente Deciplus non confirmée (sale_id manquant)');
  }

  const finalStatus =
    saleResult.manual_review || ibanError ? STATUS.MANUAL_REVIEW : STATUS.SUCCESS;

  if (
    finalStatus === STATUS.SUCCESS &&
    (order.notify_change_complete || order.raw?.notify_change_complete)
  ) {
    await notifyMembershipChangeComplete(order, memberId).catch((err) => {
      logWarn('Notification fin changement abo échouée', {
        order_id: order.order_id,
        error: err.message,
      });
    });
  }

  await resetMemberSearchContext(page).catch((err) => {
    logWarn('Retour select.php après job ignoré', { order_id: order.order_id, error: err.message });
  });

  mark('done');
  return {
    status: finalStatus,
    action: 'sale',
    error: ibanError || saleResult.error || null,
    deciplus_member_id: memberId || null,
    deciplus_sale_id: saleResult.sale_id || null,
    member_action: memberResult.action,
    sale_action: saleResult.action,
    badge_action: saleResult.badge_action || null,
    badge_error: saleResult.badge_error || null,
    photo_uploaded: Boolean(photoResult?.ok || checkpoint.photo_done),
    iban_error: ibanError || null,
  };
}

/** E-mail client à la fin du job changement prélèvement → comptant. */
async function notifyMembershipChangeComplete(order, memberId) {
  const email = order.customer?.email || order.email;
  if (!email || /@boxplus-test\.local$/i.test(String(email))) {
    logInfo('Email changement abo ignoré (test / sans email)', { order_id: order.order_id });
    return;
  }
  const productName =
    order.change_product_name || order.product_name || order.raw?.change_product_name || 'abonnement comptant';
  const payload = {
    order_id: order.order_id,
    member_id: memberId,
    email,
    first_name: order.customer?.first_name,
    last_name: order.customer?.last_name,
    product_name: productName,
    gym: order.gym,
  };

  // 1) Brevo direct (BotHosting)
  const apiKey = String(process.env.BREVO_API_KEY || '').trim().replace(/^["']|["']$/g, '');
  if (apiKey.startsWith('xkeysib-')) {
    const html = `<p>Bonjour ${payload.first_name || ''},</p>
      <p>Bonne nouvelle : votre passage en <strong>${productName}</strong> est <strong>bien enregistré et actif</strong>.</p>
      <p>Votre ancien prélèvement a été coupé et le nouvel abonnement comptant est en place. Il peut mettre <strong>quelques minutes</strong> à apparaître partout côté club.</p>
      <p>À bientôt sur le ring,<br/>Boxing Center</p>`;
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        sender: {
          name: process.env.BREVO_SENDER_NAME || 'Boxing Center',
          email: process.env.BREVO_SENDER_EMAIL || 'suzinabot@gmail.com',
        },
        to: [{ email }],
        subject: 'Votre abonnement comptant est actif — Boxing Center',
        htmlContent: html,
      }),
    });
    if (res.ok) {
      logInfo('Email changement abo envoyé (Brevo direct)', { order_id: order.order_id });
      return;
    }
    logWarn('Brevo direct changement abo échoué', { status: res.status });
  }

  // 2) Relais boutique
  const base = (process.env.BOXPLUS_STORE_URL || process.env.STORE_URL || '').replace(/\/$/, '');
  const secret = process.env.SYNC_SECRET || process.env.ADMIN_SECRET || '';
  if (!base || !secret) return;
  const res = await fetch(`${base}/api/internal/change-complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-sync-secret': secret },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    logWarn('Relais email changement abo boutique échoué', { status: res.status });
  } else {
    logInfo('Email changement abo relayé via boutique', { order_id: order.order_id });
  }
}

/** Relance dossier payé mais non terminé — email boxe, sans Deciplus. */
async function processInscriptionNudgeJob(order) {
  const email = order.customer?.email || order.raw?.email || '';
  if (!email || /@boxplus-test\.local$/i.test(email)) {
    logInfo('Relance inscription ignorée (test / sans email)', { order_id: order.order_id });
    return { status: STATUS.SUCCESS, action: 'inscription_nudge', skipped: true };
  }
  const first = order.customer?.first_name || '';
  const resumeUrl = order.raw?.resume_url || '';
  const subject =
    order.raw?.email_subject ||
    'Dernière étape : validez votre inscription Boxing Center';
  const html =
    order.raw?.email_html ||
    `<p>Bonjour ${first || ''},</p>
     <p>Votre règlement est bien reçu. Il reste le dossier et la signature. Tant que ce n’est pas validé, vous n’êtes pas encore inscrit en salle.</p>
     <p><a href="${resumeUrl}">Terminer mon inscription</a></p>
     <p>Si le bouton ne s’affiche pas, copiez ce lien : ${resumeUrl}</p>
     <p>Sportivement,<br/>L’équipe Boxing Center</p>`;

  const apiKey = String(process.env.BREVO_API_KEY || '').trim().replace(/^["']|["']$/g, '');
  if (apiKey.startsWith('xkeysib-')) {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        sender: {
          name: process.env.BREVO_SENDER_NAME || 'Boxing Center',
          email: process.env.BREVO_SENDER_EMAIL || 'suzinabot@gmail.com',
        },
        to: [{ email }],
        subject,
        htmlContent: html,
      }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Brevo relance inscription HTTP ${res.status} ${errText}`.trim());
    }
    logInfo('Relance inscription envoyée (Brevo)', { order_id: order.order_id, email });
  } else {
    logWarn('Relance inscription : BREVO_API_KEY manquante', { order_id: order.order_id });
  }

  const storeBase = (
    order.status_callback_base ||
    process.env.BOXPLUS_STORE_URL ||
    process.env.STORE_URL ||
    ''
  ).replace(/\/$/, '');
  const storeSecret = process.env.SYNC_SECRET || process.env.ADMIN_SECRET || '';
  if (storeBase && storeSecret) {
    await fetch(`${storeBase}/api/internal/inscription-nudges/${encodeURIComponent(order.order_id)}/sent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-sync-secret': storeSecret },
    }).catch(() => {});
  }
  return { status: STATUS.SUCCESS, action: 'inscription_nudge' };
}

async function processMemberPhotoJob(page, order) {
  let memberId = order.deciplus_member_id || order.customer?.deciplus_member_id || null;
  if (!memberId) {
    const match = await findMemberByIdentity(
      page,
      {
        first_name: order.customer?.first_name || order.first_name,
        last_name: order.customer?.last_name || order.last_name,
        birthdate: order.customer?.birthdate || order.birthdate,
        phone: order.customer?.phone || order.phone,
        email: order.customer?.email || order.email,
      },
      { matchFields: ['last_name', 'first_name', 'birthdate'] }
    );
    if (!match.found) {
      return {
        status: STATUS.MANUAL_REVIEW,
        action: 'member_photo',
        error: match.reason || 'membre introuvable',
        mismatch_fields: match.mismatch_fields || [],
        deciplus_member_id: match.member_id || null,
      };
    }
    memberId = match.member_id;
  }

  const gratuit =
    String(order.product_id || '').includes('offerte') ||
    /GRATUITE WEB/i.test(String(order.product_name || '')) ||
    (Number(order.payment?.amount || 0) === 0 && /essai/i.test(String(order.product_name || '')));
  if (gratuit || (!order.photo_path && !order.photo_base64 && !order.photo_url)) {
    const fallback = defaultSeancePhotoPath();
    if (fallback) {
      const fs = require('fs');
      order.photo_path = fallback;
      order.photo_base64 = `data:image/jpeg;base64,${fs.readFileSync(fallback).toString('base64')}`;
      order.photo_url = order.photo_url || 'https://seance-offerte.boxingcenter.fr/seance-essai-photo.jpg';
    }
  }

  await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(400);
  const photoResult = await uploadMemberPhoto(
    page,
    order.photo_path,
    order.photo_base64,
    memberId,
    order.photo_url
  ).catch((err) => ({ ok: false, reason: err.message }));

  if (!photoResult?.ok) {
    logWarn('Photo membre (job dédié) non uploadée', {
      order_id: order.order_id,
      member_id: memberId,
      reason: photoResult?.reason,
    });
    return {
      status: STATUS.MANUAL_REVIEW,
      action: 'member_photo',
      error: photoResult?.reason || 'upload_failed',
      deciplus_member_id: memberId,
    };
  }

  logInfo('Photo membre (job dédié) uploadée', {
    order_id: order.order_id,
    member_id: memberId,
    via: photoResult.via,
  });
  return {
    status: STATUS.SUCCESS,
    action: 'member_photo',
    deciplus_member_id: memberId,
    photo_uploaded: true,
  };
}

async function maybeTriggerInscriptionNudges() {
  // Vercel Hobby n'autorise qu'un cron/jour : le bot ops appelle l'endpoint à la place.
  const role = String(process.env.BOT_ROLE || 'all').toLowerCase();
  if (role === 'sales') return;
  const storeBase = (
    process.env.BOXPLUS_STORE_URL ||
    process.env.STORE_URL ||
    ''
  ).replace(/\/$/, '');
  const secret = process.env.SYNC_SECRET || process.env.ADMIN_SECRET || '';
  if (!storeBase || !secret) return;
  try {
    const res = await fetch(`${storeBase}/api/cron/inscription-nudges`, {
      method: 'GET',
      headers: { 'x-sync-secret': secret },
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) {
      logWarn('Poll relances inscription HTTP', { status: res.status });
    }
  } catch (err) {
    logWarn('Poll relances inscription', { error: err.message });
  }
}

async function maybeTriggerEssaiFollowup() {
  const role = String(process.env.BOT_ROLE || 'all').toLowerCase();
  if (role === 'sales') return;
  const storeBase = (
    process.env.BOXPLUS_STORE_URL ||
    process.env.STORE_URL ||
    ''
  ).replace(/\/$/, '');
  const secret = process.env.SYNC_SECRET || process.env.ADMIN_SECRET || '';
  if (!storeBase || !secret) return;
  try {
    const res = await fetch(`${storeBase}/api/cron/essai-followup`, {
      method: 'GET',
      headers: { 'x-sync-secret': secret },
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) {
      logWarn('Poll essai 10 € followup HTTP', { status: res.status });
    }
  } catch (err) {
    logWarn('Poll essai 10 € followup', { error: err.message });
  }
}

async function maybeTriggerDeciplusSaleReconcile() {
  // Vercel Hobby n’exécute pas le cron */15 — le bot ventes relance les fiches absentes.
  const storeBase = (
    process.env.BOXPLUS_STORE_URL ||
    process.env.STORE_URL ||
    ''
  ).replace(/\/$/, '');
  const secret = process.env.SYNC_SECRET || process.env.ADMIN_SECRET || '';
  if (!storeBase || !secret) return;
  try {
    const res = await fetch(`${storeBase}/api/cron/deciplus-sale-reconcile`, {
      method: 'GET',
      headers: { 'x-sync-secret': secret },
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) {
      logWarn('Poll ventes Deciplus HTTP', { status: res.status });
    }
  } catch (err) {
    logWarn('Poll ventes Deciplus', { error: err.message });
  }
}

let lastNudgePollAt = 0;
const NUDGE_POLL_MS = Number(process.env.BOT_NUDGE_POLL_MS || 60 * 1000);
let lastEssaiFollowupPollAt = 0;
const ESSAI_FOLLOWUP_POLL_MS = Number(process.env.BOT_ESSAI_FOLLOWUP_POLL_MS || 2 * 60 * 1000);
let lastSaleReconcilePollAt = 0;
const SALE_RECONCILE_POLL_MS = Number(process.env.BOT_SALE_RECONCILE_POLL_MS || 10 * 60 * 1000);

async function processCheckSaleJob(page, order) {
  const { findActiveContracts } = require('./cancel-sale');
  const { isMembershipContract } = require('../lib/sale-contract-match');
  const essaiFollowup =
    Boolean(order.essai_followup) ||
    String(order.check_kind || '') === 'abo' ||
    /#essai-abo$/i.test(String(order.order_id || ''));

  let memberId = order.deciplus_member_id || null;
  if (!memberId) {
    const found = await findMemberByIdentity(page, {
      first_name: order.customer?.first_name,
      last_name: order.customer?.last_name,
      birthdate: order.customer?.birthdate,
      phone: order.customer?.phone,
      email: order.customer?.email,
    }).catch(() => null);
    memberId = found?.found ? found.member_id : found?.member_id || null;
  }

  const storeBase = String(
    order.status_callback_base ||
      (essaiFollowup
        ? process.env.BOXPLUS_STORE_URL || process.env.STORE_URL
        : process.env.SEANCE_OFFERTE_URL) ||
      ''
  ).replace(/\/$/, '');
  const secret = process.env.SYNC_SECRET || process.env.BRIDGE_SECRET || '';
  const callbackPath = essaiFollowup ? '/api/internal/essai-followup' : '/api/internal/relance-check';

  const postCheck = async (payload) => {
    if (!storeBase || !secret) return;
    await fetch(`${storeBase}${callbackPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-sync-secret': secret },
      body: JSON.stringify(payload),
    }).catch((err) => {
      logWarn('Callback vérif abo/vente échoué', {
        error: err.message,
        order_id: order.order_id,
        path: callbackPath,
      });
    });
  };

  if (!memberId) {
    if (essaiFollowup) {
      await postCheck({
        order_id: order.order_id,
        deciplus_member_id: null,
        has_abo: false,
        has_sale: false,
        contracts: [],
        reason: 'membre introuvable',
      });
    }
    return { status: STATUS.MANUAL_REVIEW, action: 'check_sale', error: 'membre introuvable', has_sale: false };
  }

  await openMemberCheck(page, memberId).catch(() => {});
  const contracts = await findActiveContracts(page).catch(() => []);
  const hasAbo = contracts.some((c) => isMembershipContract(c));
  const hasSale = essaiFollowup ? hasAbo : contracts.some((c) => c && !c.isBadge);
  const paidLike = contracts.length > 0;
  const converted = essaiFollowup ? hasAbo : hasSale || paidLike;

  await postCheck({
    order_id: order.order_id,
    deciplus_member_id: memberId,
    has_abo: hasAbo,
    has_sale: converted,
    contracts: contracts.map((c) => c.label).slice(0, 8),
  });

  logInfo(essaiFollowup ? 'Vérif abo après essai 10 €' : 'Vérif vente séance offerte', {
    order_id: order.order_id,
    member_id: memberId,
    has_abo: hasAbo,
    has_sale: converted,
    contracts: contracts.length,
  });
  return {
    status: STATUS.SUCCESS,
    action: 'check_sale',
    deciplus_member_id: memberId,
    has_abo: hasAbo,
    has_sale: converted,
  };
}

async function processJob(page, job) {
  const order = normalizeOrder(job);
  const errors = validateOrder(order);
  if (errors.length) {
    throw new Error(`Validation: ${errors.join(', ')}`);
  }

  const jobId = order.job_id;
  if (isProcessed(jobId)) {
    return { status: STATUS.DUPLICATE, duplicate: true, action: order.action };
  }

  const role = String(process.env.BOT_ROLE || 'all').toLowerCase();
  const action = String(order.action || 'sale').toLowerCase();
  const isChangeSale =
    action === 'sale' &&
    (order.notify_change_complete || String(order.source || '').includes('change'));
  const salesAllowed = (action === 'sale' && !isChangeSale) || action === 'member_photo';

  if (role === 'sales' && !salesAllowed) {
    throw new Error(`Bot ventes refuse « ${action} » — utiliser BOXPLUS_BOT_URL_OPS`);
  }
  if (role === 'ops' && salesAllowed) {
    throw new Error(`Bot maintenance refuse les ventes inscription — utiliser BOXPLUS_BOT_URL`);
  }

  if (order.action === 'inscription_nudge') {
    return processInscriptionNudgeJob(order);
  }

  if (order.action === 'member_photo') {
    return processMemberPhotoJob(page, order);
  }

  if (order.action === 'cancel') {
    return processCancelJob(page, order);
  }

  if (order.action === 'verify_identity') {
    return processVerifyIdentityJob(page, order);
  }

  if (order.action === 'check_sale') {
    return processCheckSaleJob(page, order);
  }

  if (order.action === 'balma_switch') {
    if (role === 'sales') {
      throw new Error('Bot ventes refuse « balma_switch » — utiliser BOXPLUS_BOT_URL_OPS');
    }
    const { runBalmaSwitch } = require('./aventure-clone');
    return runBalmaSwitch(page, order);
  }

  if (order.action === 'encaisser' || order.action === 'echeancier') {
    throw new Error(
      `Action « ${order.action} » — utiliser BOXPLUS_BOT_URL_OPS (bot échéancier / résiliation)`
    );
  }

  return processSaleJob(page, order, {
    file: job.file,
    checkpoint: job.checkpoint || {},
  });
}

/** Vérif identité seule (changement d’abo / pré-check) — même statut mismatch que résiliation. */
async function processVerifyIdentityJob(page, order) {
  const { CHANGE_MATCH_FIELDS } = require('./member');
  const identity = {
    first_name: order.customer?.first_name || order.first_name,
    last_name: order.customer?.last_name || order.last_name,
    birthdate: order.customer?.birthdate || order.birthdate,
    phone: order.customer?.phone || order.phone,
    email: order.customer?.email || order.email,
  };
  const storeBase = (
    order.status_callback_base ||
    process.env.BOXPLUS_STORE_URL ||
    process.env.STORE_URL ||
    ''
  ).replace(/\/$/, '');
  const storeSecret = process.env.SYNC_SECRET || process.env.ADMIN_SECRET || '';

  const pushStatus = async (status, { mismatchFields = [], reason = null, memberId = null } = {}) => {
    if (!storeBase || !storeSecret) return false;
    try {
      const res = await fetch(`${storeBase}/api/internal/cancel-status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-sync-secret': storeSecret },
        body: JSON.stringify({
          order_id: order.order_id,
          status,
          reason,
          mismatch_fields: mismatchFields,
          deciplus_member_id: memberId,
          customer: identity,
        }),
      });
      return res.ok;
    } catch {
      return false;
    }
  };

  const matchMode = String(order.verify_mode || order.match_mode || 'change').toLowerCase();
  // Changement d’abo : nom + prénom + date de naissance (pas le téléphone)
  const matchFields =
    matchMode === 'cancel' || matchMode === 'full' ? undefined : CHANGE_MATCH_FIELDS;
  const { findMemberOnBoxingCenterGyms } = require('./search-bc-gyms');
  const { resolveSearchGymSlug } = require('../lib/gym-slugs');
  const match = await findMemberOnBoxingCenterGyms(page, identity, {
    matchFields,
    preferredGym: resolveSearchGymSlug(order.gym),
    allowBalmaLookup: false,
  });
  if (!match.found) {
    await pushStatus('mismatch', {
      mismatchFields: match.mismatch_fields || [],
      reason: match.reason || 'identity_mismatch',
      memberId: match.member_id || null,
    });
    return {
      status: STATUS.MANUAL_REVIEW,
      action: 'verify_identity',
      mismatch: true,
      mismatch_reason: match.reason || 'identity_mismatch',
      mismatch_fields: match.mismatch_fields || [],
    };
  }
  await pushStatus('verified', { memberId: match.member_id });
  return {
    status: STATUS.SUCCESS,
    action: 'verify_identity',
    deciplus_member_id: match.member_id,
    verified: true,
  };
}

function rejectJob(job, filePath, error) {
  const jobId = job.job_id || job.order_id;
  markProcessed(jobId, { status: STATUS.REJECTED, error, action: job.action || 'sale' });
  removeJob(filePath);
  logWarn('Job rejeté (données invalides, pas de connexion Deciplus)', {
    job_id: jobId,
    order_id: job.order_id,
    error,
  });
}

/** Pousse fiche / vente / erreur vers la boutique — sinon l’admin ne voit pas l’échec IBAN. */
async function pushBotSaleStatus(order, outcome = {}) {
  const action = String(order?.action || outcome.action || 'sale').toLowerCase();
  if (
    action === 'inscription_nudge' ||
    action === 'cancel' ||
    action === 'verify_identity' ||
    action === 'echeancier' ||
    action === 'encaisser'
  ) {
    return;
  }
  const base = String(
    order.status_callback_base || process.env.BOXPLUS_STORE_URL || process.env.STORE_URL || ''
  ).replace(/\/$/, '');
  const secret = process.env.SYNC_SECRET || process.env.ADMIN_SECRET || '';
  if (!base || !secret || !order?.order_id) return;
  try {
    const res = await fetch(`${base}/api/internal/sale-status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-sync-secret': secret },
      body: JSON.stringify({
        order_id: order.order_id,
        status: outcome.status || null,
        error: outcome.error || outcome.sale?.error || null,
        deciplus_member_id: outcome.deciplus_member_id || null,
        deciplus_sale_id: outcome.deciplus_sale_id || outcome.sale?.sale_id || null,
        action,
        source_bot: getBotId() || null,
        sales_bot: outcome.sales_bot || order.sales_bot || null,
        attempts: Number(outcome.attempts || order.attempts || 0),
        error_classification: outcome.error_classification || null,
        failover_count: Number(outcome.failover_count || order.failover_count || 0),
        failover_from: outcome.failover_from || order.failover_from || null,
      }),
    });
    if (!res.ok) {
      logWarn('Callback sale-status boutique échoué', {
        status: res.status,
        order_id: order.order_id,
      });
    }
  } catch (err) {
    logWarn('Callback sale-status boutique ignoré', {
      error: err.message,
      order_id: order.order_id,
    });
  }
}

async function failoverExhaustedJob(job, filePath, { policy, error, attempts } = {}) {
  const order = normalizeOrder(job);
  if (
    !shouldFailoverSale(order, policy, {
      action: order.action,
      deciplus_sale_id: job.checkpoint?.deciplus_sale_id || null,
    })
  ) {
    return null;
  }

  const handoff = await handoffFailedSale(order, { error });
  if (!handoff.handed_off) return null;
  const transferred = {
    status: STATUS.FAILED_OVER,
    error: `Relais automatique vers ${handoff.target}`,
    action: order.action || 'sale',
    sales_bot: handoff.target,
    failover_count: handoff.failover_count,
    failover_from: getBotId() || order.sales_bot || null,
    error_classification: policy.classification,
    attempts: Number(attempts || 0),
    deciplus_member_id: job.checkpoint?.deciplus_member_id || null,
    deciplus_sale_id: job.checkpoint?.deciplus_sale_id || null,
  };
  markProcessed(job.job_id || job.order_id, transferred);
  removeJob(filePath);
  await pushBotSaleStatus(job, {
    ...transferred,
    status: 'failover',
    error: null,
  });
  logWarn('Job transféré au bot de secours', {
    job_id: job.job_id || job.order_id,
    order_id: order.order_id,
    from: transferred.failover_from,
    to: handoff.target,
    classification: policy.classification,
  });
  return {
    ok: false,
    handed_off: true,
    target: handoff.target,
    failover_count: handoff.failover_count,
  };
}

async function processOneJob(job) {
  const processStartedAt = Date.now();
  const filePath = job.file;
  const jobId = job.job_id || job.order_id;
  const priorAttempts = Number(job.attempts || 0);

  if (isProcessed(jobId)) {
    removeJob(filePath);
    logWarn('Fichier orphelin supprimé (job déjà traité)', { job_id: jobId });
    return { ok: true, skipped: true };
  }

  if (priorAttempts >= MAX_RETRIES) {
    const error =
      job.last_error && /impossible à traiter/i.test(job.last_error)
        ? job.last_error
        : `Job impossible à traiter après ${priorAttempts} tentatives${job.last_error ? ` — ${job.last_error}` : ''}`;
    const exhaustedOutcome = {
      status: STATUS.MANUAL_REVIEW,
      error,
      action: job.action || 'sale',
      deciplus_member_id: job.checkpoint?.deciplus_member_id || null,
      deciplus_sale_id: job.checkpoint?.deciplus_sale_id || null,
    };
    const policy = classifyError(error);
    try {
      const handedOff = await failoverExhaustedJob(job, filePath, {
        policy,
        error,
        attempts: priorAttempts,
      });
      if (handedOff) return handedOff;
    } catch (failoverErr) {
      logError('Relais vers le second bot échoué', {
        job_id: jobId,
        order_id: job.order_id,
        error: failoverErr.message,
      });
    }
    markProcessed(jobId, exhaustedOutcome);
    removeJob(filePath);
    await pushBotSaleStatus(job, exhaustedOutcome);
    logWarn('Job impossible à traiter — stop', { job_id: jobId, attempts: priorAttempts });
    await sendAlert(`Job impossible à traiter après ${priorAttempts} tentatives — ${jobId}`, {
      job_id: jobId,
      order_id: job.order_id,
      error,
    });
    return { ok: false, impossible: true, error };
  }

  const order = normalizeOrder(job);
  if (
    job.skip_bot ||
    job.manual_migration ||
    String(job.bot_status || '').toLowerCase() === 'manual_ok'
  ) {
    const skipOutcome = {
      status: STATUS.SUCCESS,
      action: job.action || 'sale',
      skipped: 'manual_migration',
      deciplus_member_id: job.deciplus_member_id || order.deciplus_member_id || null,
      deciplus_sale_id: job.deciplus_sale_id || null,
    };
    markProcessed(jobId, skipOutcome);
    removeJob(filePath);
    logInfo('Job ignoré — migration déjà faite à la main', {
      job_id: jobId,
      order_id: order.order_id,
    });
    return { ok: true, skipped: true };
  }
  const wrongBot = wrongSalesBotReject(order);
  if (wrongBot) {
    removeJob(filePath);
    logWarn('Job retiré — destiné à un autre bot ventes', {
      job_id: jobId,
      order_id: order.order_id,
      sales_bot: wrongBot.sales_bot,
      bot_id: wrongBot.bot_id,
    });
    return { ok: false, skipped: true, reason: 'wrong_bot' };
  }
  const validationErrors = validateOrder(order);
  if (validationErrors.length) {
    rejectJob(job, filePath, validationErrors.join(', '));
    return { ok: false, rejected: true, error: validationErrors.join(', ') };
  }

  const action = String(order.action || job.action || 'sale').toLowerCase();
  const requiresDistributedLease = action === 'sale' || action === 'balma_switch';
  let lease = null;
  if (requiresDistributedLease) {
    try {
      lease = await idempotency.acquire(order.order_id, action);
    } catch (err) {
      const policy = classifyError(err);
      const outcome = {
        status: STATUS.MANUAL_REVIEW,
        error: `${err.message}. Déployer la migration 008 avant de relancer.`,
        action,
        error_classification: policy.classification,
      };
      updateJob(filePath, { status: STATUS.MANUAL_REVIEW, last_error: outcome.error });
      markProcessed(jobId, outcome);
      removeJob(filePath);
      await pushBotSaleStatus(job, outcome);
      await sendAlert(`Écriture Deciplus bloquée — registre idempotence indisponible`, {
        job_id: jobId,
        order_id: order.order_id,
        action,
        error: outcome.error,
      });
      return { ok: false, impossible: true, error: outcome.error };
    }
    if (!lease.acquired) {
      const resume = idempotency.resumeDecision(lease);
      if (resume.disposition === 'completed') {
        const outcome = {
          status: STATUS.SUCCESS,
          action,
          deciplus_member_id: resume.member_id,
          deciplus_sale_id: resume.sale_id,
          duplicate: true,
        };
        markProcessed(jobId, outcome);
        removeJob(filePath);
        await pushBotSaleStatus(job, outcome);
        return { ok: true, skipped: true, result: outcome };
      }
      const nextAttemptAt = resume.retry_at || new Date(Date.now() + 30000).toISOString();
      updateJob(filePath, {
        status: STATUS.ERROR,
        last_error: `Action ${action} déjà louée par un autre worker`,
        next_attempt_at: nextAttemptAt,
      });
      return { ok: false, skipped: true, reason: 'distributed_lease_active' };
    }
    if (lease.member_id || lease.sale_id) {
      job.checkpoint = {
        ...(job.checkpoint || {}),
        deciplus_member_id: lease.member_id || job.checkpoint?.deciplus_member_id,
        deciplus_sale_id: lease.sale_id || job.checkpoint?.deciplus_sale_id,
        sale_done: Boolean(lease.sale_id),
      };
      job.deciplus_member_id = lease.member_id || job.deciplus_member_id;
      job.deciplus_sale_id = lease.sale_id || job.deciplus_sale_id;
      order.deciplus_member_id = lease.member_id || order.deciplus_member_id;
      order.deciplus_sale_id = lease.sale_id || order.deciplus_sale_id;
    }
  }

  updateJob(filePath, { status: STATUS.PROCESSING, started_at: new Date().toISOString() });
  logJobEvent('started', {
    order_id: order.order_id,
    action,
    phase: 'processing',
    attempt: priorAttempts + 1,
  });

  if (action === 'inscription_nudge') {
    try {
      const role = String(process.env.BOT_ROLE || 'all').toLowerCase();
      if (role === 'sales') {
        throw new Error('Bot ventes refuse « inscription_nudge » — utiliser BOXPLUS_BOT_URL_OPS');
      }
      const outcome = await processInscriptionNudgeJob(order);
      markProcessed(jobId, outcome);
      removeJob(filePath);
      logInfo('Relance inscription traitée', { job_id: jobId, order_id: order.order_id });
      return { ok: true, result: outcome };
    } catch (err) {
      updateJob(filePath, {
        status: STATUS.ERROR,
        last_error: err.message,
        attempts: priorAttempts + 1,
      });
      logError('Erreur relance inscription', { job_id: jobId, error: err.message });
      return { ok: false, error: err.message };
    }
  }

  try {
    if (!order.gym) {
      throw new Error('Validation: salle (gym) manquante sur la commande — impossible de choisir le site Deciplus');
    }
    const gymConfig = getGymConfig(order.gym);
    const siteLabel = gymConfig.deciplus_label || gymConfig.label;
    logInfo('Salle commande → Deciplus', {
      job_id: jobId,
      order_id: order.order_id,
      gym: order.gym,
      site: siteLabel,
    });

    if (sessionFileChanged()) {
      logWarn('Session changée avant job — rechargement navigateur');
      await closeBrowser();
      syncLoadedStorageMtime();
    }

    const outcome = await runWithSession('job', async (page) => {
      await login(page, { siteLabel });
      return processJob(page, { ...job, attempts: priorAttempts, checkpoint: job.checkpoint || {} });
    });

    if (requiresDistributedLease) {
      await idempotency.checkpoint(order.order_id, action, {
        status: outcome.status === STATUS.SUCCESS ? 'completed' : 'manual_review',
        lifecycle_state: outcome.deciplus_sale_id ? STATES.VERIFIED : STATES.MANUAL_REVIEW,
        attempt: Number(lease?.attempt || priorAttempts + 1),
        member_id: outcome.deciplus_member_id || null,
        sale_id: outcome.deciplus_sale_id || null,
        error_message: outcome.error || null,
      });
    }
    markProcessed(jobId, outcome);
    removeJob(filePath);
    await pushBotSaleStatus(job, outcome);

    logInfo('Job Deciplus traité', {
      job_id: jobId,
      order_id: job.order_id,
      action: outcome.action || job.action || 'sale',
      status: outcome.status,
    });

    touchKeepAliveClock();
    logJobEvent('completed', {
      order_id: order.order_id,
      action,
      phase: 'verified',
      attempt: priorAttempts + 1,
      duration_ms: Date.now() - processStartedAt,
      member_id: outcome.deciplus_member_id,
      sale_id: outcome.deciplus_sale_id,
    });
    return { ok: true, result: outcome };
  } catch (err) {
    if (err.message.startsWith('Validation:')) {
      rejectJob(job, filePath, err.message.replace(/^Validation:\s*/, ''));
      return { ok: false, rejected: true, error: err.message };
    }

    const policy = classifyError(err);
    // Les erreurs de données/conflit sont immédiatement placées en revue manuelle.
    const attempts = priorAttempts + 1;
    const sessionErr = isSessionRecoverableError(err.message);
    const browserGone = /browser has been closed|Target page, context or browser/i.test(err.message);
    const mfaErr = isMfaAuthError(err.message);
    const fastFailover =
      attempts >= failoverAfterAttempts() &&
      shouldFailoverSale(order, policy, {
        action,
        deciplus_sale_id: job.checkpoint?.deciplus_sale_id || null,
      });

    // Erreur liée session → refresh immédiat (sans attendre le ping 1h30) puis retry job
    let sessionRecovered = false;
    if ((sessionErr || browserGone) && !fastFailover) {
      logWarn('Erreur liée session — refresh immédiat puis reprise du job', {
        job_id: jobId,
        error: err.message,
        auth_cooldown: isAuthBlocked(),
      });
      await closeBrowser().catch(() => {});
      // Si cooldown MFA déjà actif (IMAP KO), ne pas spammer un nouveau login
      if (!isAuthBlocked() || !mfaErr) {
        sessionRecovered = await forceRefreshSession().catch(() => false);
      }
    }

    // MFA/IMAP : plus de noRetry immédiat — le cooldown évite le spam OTP ; on retente jusqu’à MAX
    const exhausted = !policy.retryable || attempts >= MAX_RETRIES;
    const status = exhausted ? STATUS.MANUAL_REVIEW : STATUS.ERROR;
    const lastError = exhausted
      ? `Job impossible à traiter après ${attempts} tentatives — ${err.message}`
      : err.message;

    updateJob(filePath, {
      status,
      last_error: lastError,
      attempts,
      error_classification: policy.classification,
      human_action: policy.action,
      next_attempt_at: exhausted
        ? null
        : new Date(Date.now() + backoffMs(attempts)).toISOString(),
      ...(sessionRecovered ? { session_refreshed_at: new Date().toISOString() } : {}),
    });

    if (requiresDistributedLease) {
      await idempotency.checkpoint(order.order_id, action, {
        status: exhausted ? 'manual_review' : 'failed',
        lifecycle_state: exhausted ? STATES.MANUAL_REVIEW : STATES.FAILED,
        attempt: Number(lease?.attempt || attempts),
        member_id: job.checkpoint?.deciplus_member_id || null,
        sale_id: job.checkpoint?.deciplus_sale_id || null,
        error_classification: policy.classification,
        error_message: lastError,
        human_action: policy.action,
      }).catch((checkpointErr) => {
        logError('Échec checkpoint erreur', { order_id: order.order_id, error: checkpointErr.message });
      });
    }

    if (exhausted || fastFailover) {
      try {
        const handedOff = await failoverExhaustedJob(job, filePath, {
          policy,
          error: lastError,
          attempts,
        });
        if (handedOff) return handedOff;
      } catch (failoverErr) {
        logError('Relais vers le second bot échoué', {
          job_id: jobId,
          order_id: order.order_id,
          error: failoverErr.message,
        });
      }
    }

    if (status === STATUS.MANUAL_REVIEW) {
      await sendAlert(`Job impossible à traiter après ${attempts} tentatives — ${jobId}`, {
        job_id: jobId,
        order_id: job.order_id,
        action: job.action,
        error: lastError,
      });
      const failed = {
        status,
        error: lastError,
        action: job.action || 'sale',
        deciplus_member_id: job.checkpoint?.deciplus_member_id || null,
        deciplus_sale_id: job.checkpoint?.deciplus_sale_id || null,
      };
      markProcessed(jobId, failed);
      removeJob(filePath);
      await pushBotSaleStatus(job, failed);
    } else if (sessionRecovered) {
      logInfo('Session renouvelée — job remis en file pour retry', {
        job_id: jobId,
        attempts,
      });
    }

    logError('Erreur traitement job', { job_id: jobId, order_id: job.order_id, error: lastError });
    logJobEvent('failed', {
      order_id: order.order_id,
      action,
      phase: exhausted ? 'manual_review' : 'retry_scheduled',
      attempt: attempts,
      classification: policy.classification,
      duration_ms: Date.now() - processStartedAt,
      member_id: job.checkpoint?.deciplus_member_id,
      sale_id: job.checkpoint?.deciplus_sale_id,
    });

    return { ok: false, error: lastError, impossible: exhausted, session_recovered: sessionRecovered };
  }
}

async function runLoop(once = false) {
  const { startBotServer } = require('./server');
  startBotServer();

  const recovered = requeueInterruptedJobs(Number(process.env.BOT_REQUEUE_MS || 0), {
    includeSessionErrors: true,
  });
  if (recovered) {
    logInfo('Jobs non terminés repris au démarrage', { count: recovered });
  }

  const exhausted = finalizeExhaustedJobs(MAX_RETRIES);
  if (exhausted) {
    logWarn('Jobs impossibles à traiter finalisés', { count: exhausted });
  }

  logInfo('Bot Deciplus démarré', getQueueStats());

  const catalogDelay = Number(process.env.BOT_CATALOG_PUSH_DELAY_MS || 120000);
  setTimeout(() => {
    maybePushCatalog().catch(() => {});
  }, catalogDelay);

  const catalogTimer = setInterval(() => {
    maybePushCatalog().catch(() => {});
  }, CATALOG_PUSH_MS);
  if (catalogTimer.unref) catalogTimer.unref();

  const keepaliveTimer = setInterval(() => {
    maybeKeepSessionAlive().catch(() => {});
  }, Number(process.env.BOT_KEEPALIVE_CHECK_MS || 60000));
  if (keepaliveTimer.unref) keepaliveTimer.unref();

  do {
    // Jobs restés « processing » (crash, kill, changement session) → reprise
    requeueInterruptedJobs(STALE_PROCESSING_MS);

    if (sessionFileChanged()) {
      if (hasActiveBrowser()) {
        logWarn('storage-state.json modifié — fermeture navigateur pour charger la nouvelle session');
        await closeBrowser();
      }
      // Aligner l'horloge même sans navigateur ouvert — sinon spam WARN à chaque poll
      syncLoadedStorageMtime();
    }

    const pending = listPending();
    if (Date.now() - lastNudgePollAt >= NUDGE_POLL_MS) {
      lastNudgePollAt = Date.now();
      await maybeTriggerInscriptionNudges();
    }
    if (Date.now() - lastEssaiFollowupPollAt >= ESSAI_FOLLOWUP_POLL_MS) {
      lastEssaiFollowupPollAt = Date.now();
      await maybeTriggerEssaiFollowup();
    }
    if (Date.now() - lastSaleReconcilePollAt >= SALE_RECONCILE_POLL_MS) {
      lastSaleReconcilePollAt = Date.now();
      void maybeTriggerDeciplusSaleReconcile().catch((err) => {
        logWarn('Poll ventes Deciplus (async)', { error: err.message });
      });
    }
    if (pending.length === 0) {
      if (once) break;
      await maybeKeepSessionAlive();
      await sleep(POLL_MS);
      continue;
    }

    const job = pending[0];
    logInfo('Traitement job', {
      job_id: job.job_id,
      order_id: job.order_id,
      action: job.action || 'sale',
      checkpoint: job.checkpoint?.step || null,
    });
    try {
      await processOneJob(job);
    } catch (err) {
      logError('Erreur fatale boucle bot', { error: err.message, order_id: job.order_id });
      await sendAlert(`Erreur fatale boucle bot — ${job.order_id || job.job_id}`, {
        job_id: job.job_id,
        order_id: job.order_id,
        action: job.action,
        error: err.message,
      }).catch(() => {});
      await closeBrowser();
    }
  } while (!once);

  await closeBrowser();
  logInfo('Bot Deciplus arrêté', getQueueStats());
}

function installCrashGuards() {
  if (installCrashGuards.done) return;
  installCrashGuards.done = true;
  process.on('uncaughtException', (err) => {
    logError('uncaughtException — bot continue', { error: err.message });
    sendAlert('uncaughtException — bot continue', { error: err.message }).catch(() => {});
    closeBrowser().catch(() => {});
  });
  process.on('unhandledRejection', (reason) => {
    const error = reason && reason.message ? reason.message : String(reason);
    logError('unhandledRejection — bot continue', { error });
    sendAlert('unhandledRejection — bot continue', { error }).catch(() => {});
  });
}

async function main() {
  const once = process.argv.includes('--once');
  installCrashGuards();
  const { bootstrapAuthTokenFromStorage } = require('./auth');
  bootstrapAuthTokenFromStorage();
  console.log('[BOXPLUS] Lancement boucle bot Deciplus');
  for (;;) {
    try {
      await runLoop(once);
      if (once) return;
      await sendAlert('Boucle bot arrêtée inattendue — reprise', {
        error: 'runLoop ended',
        bot_id: getBotId() || null,
      }).catch(() => {});
    } catch (err) {
      console.error(err);
      await sendAlert('Bot crash — reprise automatique dans 5s', {
        error: err.message,
        bot_id: getBotId() || null,
      }).catch(() => {});
      await closeBrowser().catch(() => {});
      if (once) return;
    }
    await sleep(5000);
  }
}

if (require.main === module) {
  main();
}

module.exports = { processJob, processOneJob, runLoop, main, processCancelJob, processSaleJob, processMemberPhotoJob, processCheckSaleJob };
