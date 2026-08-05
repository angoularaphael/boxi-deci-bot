#!/usr/bin/env node
/**
 * Phase 2 — Bot RPA Deciplus : traite la file d'attente BOXPLUS.
 */
require('dotenv').config();

const { login, isMfaAuthError, isSessionRecoverableError } = require('./auth');
const { runWithSession, closeBrowser, sessionFileChanged } = require('./browser-pool');
const { findOrCreateMember, resetMemberSearchContext, uploadMemberPhoto } = require('./member');
const { recordSale } = require('./sale');
const { setMemberIban } = require('./wallet');
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
} = require('../lib/queue');
const {
  normalizeOrder,
  validateOrder,
  getGymConfig,
} = require('../lib/normalize');
const { fetchDeciplusCatalog, resolveProductConfig, resolveBadgeProductConfig } = require('./catalog');
const { applyBillingPlanToProductConfig } = require('../lib/billing-plan');
const { logInfo, logError, logWarn, sendAlert } = require('../lib/logger');
const { sleep } = require('../lib/utils');
const { maybeKeepSessionAlive, touchKeepAliveClock } = require('./session-keepalive');

const MAX_RETRIES = Number(process.env.BOT_MAX_RETRIES || 3);
const POLL_MS = Number(process.env.BOT_POLL_MS || 5000);
const CATALOG_PUSH_MS = Number(process.env.BOT_CATALOG_PUSH_MS || 6 * 60 * 60 * 1000);
const CATALOG_TTL_MS = Number(process.env.BOT_CATALOG_TTL_MS || 10 * 60 * 1000);
const STALE_PROCESSING_MS = Number(process.env.BOT_STALE_PROCESSING_MS || 15 * 60 * 1000);

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

async function processCancelJob(_page, order) {
  logWarn('Annulation / résiliation — traitement manuel dans Deciplus', {
    order_id: order.order_id,
    cancel_reason: order.cancel_reason,
  });
  return {
    status: STATUS.MANUAL_REVIEW,
    action: 'cancel',
    error: 'Annulation ou résiliation : effectuer manuellement dans Deciplus',
    deciplus_member_id: order.deciplus_member_id || getProcessedRecord(order.order_id)?.deciplus_member_id || null,
    cancel_reason: order.cancel_reason,
  };
}

async function processSaleJob(page, order, jobMeta = {}) {
  const t0 = Date.now();
  const mark = (label) => logInfo(`Timing bot · ${label}`, { order_id: order.order_id, ms: Date.now() - t0 });
  const filePath = jobMeta.file || null;
  const checkpoint = jobMeta.checkpoint || order.checkpoint || {};

  const saveCheckpoint = (patch) => {
    if (!filePath) return;
    try {
      const next = { ...(checkpoint || {}), ...patch, at: new Date().toISOString() };
      Object.assign(checkpoint, next);
      updateJob(filePath, { checkpoint: next });
    } catch (err) {
      logWarn('Checkpoint job non enregistré', { order_id: order.order_id, error: err.message });
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
  const gymConfig = getGymConfig(order.gym);

  let badgeProductConfig = null;
  if (productConfig.auto_badge) {
    try {
      badgeProductConfig = resolveBadgeProductConfig(catalog, {
        badge_timing: 'deferred',
        badge_method: 'iban',
      });
    } catch (err) {
      logWarn('Badge non ajouté automatiquement', { order_id: order.order_id, error: err.message });
    }
  }

  let memberId = checkpoint.deciplus_member_id || null;
  let memberResult = {
    member_id: memberId,
    action: memberId ? 'checkpoint_resume' : null,
  };

  if (!memberId) {
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
    if (!memberId) {
      return {
        status: STATUS.MANUAL_REVIEW,
        error: 'member_id Deciplus manquant après création — membre non visible / non finalisé',
        member_action: memberResult.action,
      };
    }
    saveCheckpoint({ step: 'member', deciplus_member_id: memberId });
  } else {
    logInfo('Reprise job — membre déjà créé', { order_id: order.order_id, member_id: memberId });
    mark('member_resume');
  }

  let photoResult = null;
  if (!checkpoint.photo_done && (order.photo_path || order.photo_base64)) {
    photoResult = await uploadMemberPhoto(
      page,
      order.photo_path,
      order.photo_base64,
      memberId
    ).catch((err) => ({
      ok: false,
      reason: err.message,
    }));
    mark('photo');
    if (!photoResult?.ok) {
      logWarn('Photo non uploadée dans Deciplus', {
        order_id: order.order_id,
        reason: photoResult?.reason,
      });
    } else {
      saveCheckpoint({ step: 'photo', deciplus_member_id: memberId, photo_done: true });
    }
  }

  let saleResult = { sale_id: checkpoint.deciplus_sale_id || null };

  const needsIban = productConfig.requires_iban === true;
  const iban = order.payment.iban;

  if (!checkpoint.iban_done) {
    if (needsIban && productConfig.sale_type !== 'none') {
      if (!iban) {
        return {
          status: STATUS.MANUAL_REVIEW,
          error: 'IBAN requis pour cette offre',
          deciplus_member_id: memberId,
        };
      }
      if (!isValidFrenchIban(iban)) {
        return {
          status: STATUS.MANUAL_REVIEW,
          error: 'IBAN français invalide',
          deciplus_member_id: memberId,
        };
      }
      if (memberId) {
        await setMemberIban(page, memberId, iban, order.customer, gymConfig);
        mark('iban');
        saveCheckpoint({ step: 'iban', deciplus_member_id: memberId, iban_done: true });
      }
    } else if (iban && memberId) {
      if (!isValidFrenchIban(iban)) {
        return {
          status: STATUS.MANUAL_REVIEW,
          error: 'IBAN français invalide',
          deciplus_member_id: memberId,
        };
      }
      await setMemberIban(page, memberId, iban, order.customer, gymConfig);
      mark('iban');
      saveCheckpoint({ step: 'iban', deciplus_member_id: memberId, iban_done: true });
    }
  }

  if (checkpoint.sale_done) {
    logInfo('Reprise job — vente déjà enregistrée', {
      order_id: order.order_id,
      sale_id: checkpoint.deciplus_sale_id || null,
    });
    saleResult = {
      sale_id: checkpoint.deciplus_sale_id || null,
      action: 'checkpoint_resume',
      badge_action: checkpoint.badge_action || null,
    };
  } else if (productConfig.requires_payment !== false && order.payment.status === 'paid') {
    saleResult = await recordSale(page, order, productConfig, memberId, gymConfig, {
      badgeProductConfig,
    });
    mark('sale');
    saveCheckpoint({
      step: 'sale',
      deciplus_member_id: memberId,
      sale_done: true,
      deciplus_sale_id: saleResult.sale_id || null,
      badge_action: saleResult.badge_action || null,
    });
  } else if (productConfig.sale_type === 'none') {
    saleResult = { action: 'trial_only' };
    saveCheckpoint({ step: 'sale', deciplus_member_id: memberId, sale_done: true });
  }

  const finalStatus =
    saleResult.manual_review ? STATUS.MANUAL_REVIEW : STATUS.SUCCESS;

  await resetMemberSearchContext(page).catch((err) => {
    logWarn('Retour select.php après job ignoré', { order_id: order.order_id, error: err.message });
  });

  mark('done');
  return {
    status: finalStatus,
    action: 'sale',
    deciplus_member_id: memberId || null,
    deciplus_sale_id: saleResult.sale_id || null,
    member_action: memberResult.action,
    sale_action: saleResult.action,
    badge_action: saleResult.badge_action || null,
    badge_error: saleResult.badge_error || null,
    photo_uploaded: Boolean(photoResult?.ok || checkpoint.photo_done),
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

  if (order.action === 'cancel') {
    return processCancelJob(page, order);
  }

  return processSaleJob(page, order, {
    file: job.file,
    checkpoint: job.checkpoint || {},
  });
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

async function processOneJob(job) {
  const filePath = job.file;
  const jobId = job.job_id || job.order_id;

  if (isProcessed(jobId)) {
    removeJob(filePath);
    logWarn('Fichier orphelin supprimé (job déjà traité)', { job_id: jobId });
    return { ok: true, skipped: true };
  }

  const order = normalizeOrder(job);
  const validationErrors = validateOrder(order);
  if (validationErrors.length) {
    rejectJob(job, filePath, validationErrors.join(', '));
    return { ok: false, rejected: true, error: validationErrors.join(', ') };
  }

  updateJob(filePath, { status: STATUS.PROCESSING, started_at: new Date().toISOString() });

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
    }

    const outcome = await runWithSession('job', async (page) => {
      await login(page, { siteLabel });
      return processJob(page, job);
    });

    markProcessed(jobId, outcome);
    removeJob(filePath);

    logInfo('Job Deciplus traité', {
      job_id: jobId,
      order_id: job.order_id,
      action: outcome.action || job.action || 'sale',
      status: outcome.status,
    });

    touchKeepAliveClock();
    return { ok: true, result: outcome };
  } catch (err) {
    if (err.message.startsWith('Validation:')) {
      rejectJob(job, filePath, err.message.replace(/^Validation:\s*/, ''));
      return { ok: false, rejected: true, error: err.message };
    }

    const sessionErr = isSessionRecoverableError(err.message);
    const browserGone = /browser has been closed|Target page, context or browser/i.test(err.message);
    // Session / navigateur : reprendre sans consommer les tentatives MFA
    const attempts = sessionErr || browserGone ? job.attempts || 0 : (job.attempts || 0) + 1;
    const noRetry = isMfaAuthError(err.message) && !sessionErr;
    const status = noRetry || attempts >= MAX_RETRIES ? STATUS.MANUAL_REVIEW : STATUS.ERROR;

    updateJob(filePath, {
      status,
      last_error: err.message,
      attempts,
    });

    if (status === STATUS.MANUAL_REVIEW) {
      await sendAlert(`Échec Deciplus après ${attempts} tentatives — ${jobId}`, {
        job_id: jobId,
        order_id: job.order_id,
        action: job.action,
        error: err.message,
      });
      markProcessed(jobId, {
        status,
        error: err.message,
        action: job.action || 'sale',
        deciplus_member_id: job.checkpoint?.deciplus_member_id || null,
        deciplus_sale_id: job.checkpoint?.deciplus_sale_id || null,
      });
      removeJob(filePath);
    }

    logError('Erreur traitement job', { job_id: jobId, order_id: job.order_id, error: err.message });

    if (sessionErr || browserGone) {
      logWarn('Session / navigateur — reset pour reprendre le job avec la nouvelle session');
      await closeBrowser();
    }

    return { ok: false, error: err.message };
  }
}

async function runLoop(once = false) {
  const { startBotServer } = require('./server');
  startBotServer();

  const recovered = requeueInterruptedJobs(Number(process.env.BOT_REQUEUE_MS || 0));
  if (recovered) {
    logInfo('Jobs interrompus remis en file', { count: recovered });
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
      logWarn('storage-state.json modifié — fermeture navigateur pour charger la nouvelle session');
      await closeBrowser();
    }

    const pending = listPending();
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
      logError('Erreur fatale boucle bot', { error: err.message });
      await closeBrowser();
    }
  } while (!once);

  await closeBrowser();
  logInfo('Bot Deciplus arrêté', getQueueStats());
}

if (require.main === module) {
  const once = process.argv.includes('--once');
  runLoop(once).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { processJob, processOneJob, runLoop, processCancelJob, processSaleJob };
