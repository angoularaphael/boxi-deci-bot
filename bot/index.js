#!/usr/bin/env node
/**
 * Phase 2 — Bot RPA Deciplus : traite la file d'attente BOXPLUS.
 */
require('dotenv').config();

const path = require('path');
const { launchBrowser, login, saveSession } = require('./auth');
const { findOrCreateMember } = require('./member');
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
} = require('../lib/queue');
const {
  normalizeOrder,
  validateOrder,
  getGymConfig,
} = require('../lib/normalize');
const { fetchDeciplusCatalog, resolveProductConfig, resolveBadgeProductConfig } = require('./catalog');
const { logInfo, logError, logWarn, sendAlert } = require('../lib/logger');
const { sleep } = require('../lib/utils');

const MAX_RETRIES = Number(process.env.BOT_MAX_RETRIES || 3);
const POLL_MS = Number(process.env.BOT_POLL_MS || 5000);
const CATALOG_PUSH_MS = Number(process.env.BOT_CATALOG_PUSH_MS || 6 * 60 * 60 * 1000);

async function maybePushCatalog() {
  if (String(process.env.BOT_CATALOG_PUSH_ENABLED || 'true').toLowerCase() === 'false') return;
  try {
    const { syncAndPushCatalog } = require('../lib/catalog-sync');
    await syncAndPushCatalog();
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

async function processSaleJob(page, order) {
  const catalog = await fetchDeciplusCatalog(page);
  const productConfig = resolveProductConfig(order, catalog);
  const gymConfig = getGymConfig(order.gym || 'minimes');

  let badgeProductConfig = null;
  if (productConfig.auto_badge) {
    try {
      badgeProductConfig = resolveBadgeProductConfig(catalog);
    } catch (err) {
      logWarn('Badge non ajouté automatiquement', { order_id: order.order_id, error: err.message });
    }
  }

  const memberResult = await findOrCreateMember(page, order, gymConfig);

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

  let saleResult = { sale_id: null };
  const memberId = memberResult.member_id;

  const needsIban = productConfig.requires_iban === true;
  const iban = order.payment.iban;

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
  }

  if (productConfig.requires_payment !== false && order.payment.status === 'paid') {
    saleResult = await recordSale(page, order, productConfig, memberId, gymConfig, {
      badgeProductConfig,
    });
  } else if (productConfig.sale_type === 'none') {
    saleResult = { action: 'trial_only' };
  }

  const finalStatus =
    saleResult.manual_review ? STATUS.MANUAL_REVIEW : STATUS.SUCCESS;

  return {
    status: finalStatus,
    action: 'sale',
    deciplus_member_id: memberId || null,
    deciplus_sale_id: saleResult.sale_id || null,
    member_action: memberResult.action,
    sale_action: saleResult.action,
    badge_action: saleResult.badge_action || null,
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

  return processSaleJob(page, order);
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

  updateJob(filePath, { status: STATUS.PROCESSING, attempts: (job.attempts || 0) + 1 });

  let browser;
  let context;
  let page;

  try {
    ({ browser, context, page } = await launchBrowser());
    await login(page);
    const result = await processJob(page, job);
    await saveSession(context);

    markProcessed(jobId, result);
    removeJob(filePath);

    logInfo('Job Deciplus traité', {
      job_id: jobId,
      order_id: job.order_id,
      action: result.action || job.action || 'sale',
      status: result.status,
    });

    return { ok: true, result };
  } catch (err) {
    if (err.message.startsWith('Validation:')) {
      rejectJob(job, filePath, err.message.replace(/^Validation:\s*/, ''));
      return { ok: false, rejected: true, error: err.message };
    }

    const attempts = (job.attempts || 0) + 1;
    const status = attempts >= MAX_RETRIES ? STATUS.MANUAL_REVIEW : STATUS.ERROR;

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
      markProcessed(jobId, { status, error: err.message, action: job.action || 'sale' });
      removeJob(filePath);
    }

    logError('Erreur traitement job', { job_id: jobId, order_id: job.order_id, error: err.message });
    return { ok: false, error: err.message };
  } finally {
    if (browser) await browser.close();
  }
}

async function runLoop(once = false) {
  const { startBotServer } = require('./server');
  startBotServer();

  logInfo('Bot Deciplus démarré', getQueueStats());

  maybePushCatalog().catch(() => {});
  const catalogTimer = setInterval(() => {
    maybePushCatalog().catch(() => {});
  }, CATALOG_PUSH_MS);
  if (catalogTimer.unref) catalogTimer.unref();

  do {
    const pending = listPending();
    if (pending.length === 0) {
      if (once) break;
      await sleep(POLL_MS);
      continue;
    }

    const job = pending[0];
    logInfo('Traitement job', { job_id: job.job_id, order_id: job.order_id, action: job.action || 'sale' });
    await processOneJob(job);
  } while (!once);

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
