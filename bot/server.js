/**
 * Serveur HTTP minimal — reçoit les commandes Vercel et les met en file locale.
 */
require('dotenv').config();

const express = require('express');
const {
  enqueue,
  getQueueStats,
  cancelJob,
  getProcessedRecord,
  findJobFile,
  unmarkProcessed,
  removeJob,
  queuedJobIsBusy,
  listPending,
  clearPendingQueue,
  markProcessed,
  STATUS,
} = require('../lib/queue');
const { normalizeOrder, validateOrder, getJobId } = require('../lib/normalize');
const { logInfo, logError } = require('../lib/logger');
const { getBotId, wrongSalesBotReject } = require('../lib/sales-bot');
const idempotency = require('../lib/persistent-idempotency');
const packageJson = require('../package.json');

const PORT = Number(process.env.BOT_HTTP_PORT || process.env.PORT || 3050);
const SECRET = process.env.SYNC_SECRET || process.env.BRIDGE_SECRET || '';

function isAuthorized(req) {
  if (!SECRET) return false;
  const header = req.headers['x-sync-secret'] || req.headers['authorization'] || '';
  const token = String(header).replace(/^Bearer\s+/i, '').trim();
  return token === SECRET;
}

function createBotServer() {
  const app = express();
  app.use(express.json({ limit: '6mb' }));

  app.get('/health', async (_req, res) => {
    const registry = await idempotency.health().catch((err) => ({
      available: false,
      reason: err.message,
    }));
    const ready = Boolean(registry.available);
    res.json({
      ok: true,
      ready,
      service: 'boxi-deci-bot',
      version: packageJson.version,
      git_sha: process.env.VERCEL_GIT_COMMIT_SHA || process.env.GIT_SHA || null,
      build_id: process.env.VERCEL_DEPLOYMENT_ID || process.env.BUILD_ID || null,
      bot_id: getBotId() || null,
      bot_role: String(process.env.BOT_ROLE || 'all').toLowerCase(),
      persistent_idempotency: registry,
      stats: getQueueStats(),
    });
  });

  app.post('/api/jobs', (req, res) => {
    if (!isAuthorized(req)) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
    try {
      const order = normalizeOrder(req.body);
      const errors = validateOrder(order);
      if (errors.length) {
        return res.status(400).json({ ok: false, error: errors.join(', ') });
      }
      const wrongBot = wrongSalesBotReject(order);
      if (wrongBot) {
        logInfo('Job refusé — autre bot ventes', {
          order_id: order.order_id,
          sales_bot: wrongBot.sales_bot,
          bot_id: wrongBot.bot_id,
        });
        return res.json({ ok: true, ...wrongBot });
      }
      const result = enqueue(order);
      const processed =
        !result.queued && (result.reason === 'already_processed' || result.reason === 'already_queued')
          ? getProcessedRecord(result.job_id || order.order_id)
          : null;
      logInfo('Job reçu depuis boutique', {
        order_id: order.order_id,
        job_id: result.job_id,
        queued: result.queued,
        reason: result.reason || null,
      });
      res.json({ ok: true, ...result, processed });
    } catch (err) {
      logError('Ingest job échoué', { error: err.message });
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get('/api/queue/stats', (req, res) => {
    if (!isAuthorized(req)) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
    res.json({ ok: true, ...getQueueStats(), STATUS });
  });

  app.get('/api/jobs/:id', (req, res) => {
    if (!isAuthorized(req)) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
    const record = getProcessedRecord(req.params.id);
    res.json({ ok: true, job_id: req.params.id, processed: record || null });
  });

  app.post('/api/jobs/:id/cancel', (req, res) => {
    if (!isAuthorized(req)) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
    try {
      const reason = String(req.body?.reason || 'cancelled_by_admin').slice(0, 200);
      const result = cancelJob(req.params.id, reason);
      if (!result.ok) return res.status(400).json(result);
      logInfo('Job annulé via API', { job_id: result.job_id, reason });
      res.json(result);
    } catch (err) {
      logError('Annulation job échouée', { error: err.message });
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/api/jobs/force-requeue', (req, res) => {
    if (!isAuthorized(req)) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
    try {
      const order = normalizeOrder(req.body);
      const errors = validateOrder(order);
      if (errors.length) {
        return res.status(400).json({ ok: false, error: errors.join(', ') });
      }
      const wrongBot = wrongSalesBotReject(order);
      if (wrongBot) {
        return res.json({ ok: true, forced: false, ...wrongBot });
      }
      const jobId = order.job_id || getJobId(order);
      const previous = getProcessedRecord(jobId);
      if (previous) unmarkProcessed(jobId);
      const found = findJobFile(jobId);
      if (found?.file && !queuedJobIsBusy(found.file)) removeJob(found.file);
      const result = enqueue({
        ...order,
        force_requeue: true,
        force_sale_retry: true,
      });
      logInfo('Force requeue job', {
        order_id: order.order_id,
        job_id: jobId,
        queued: result.queued,
        reason: result.reason || null,
        previous_status: previous?.status || null,
      });
      res.json({
        ok: true,
        forced: true,
        ...result,
        processed: previous || null,
      });
    } catch (err) {
      logError('Force requeue échoué', { error: err.message });
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get('/api/queue/pending', (req, res) => {
    if (!isAuthorized(req)) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
    const jobs = listPending().map((j) => ({
      order_id: j.order_id,
      job_id: j.job_id,
      status: j.status,
      attempts: j.attempts || 0,
      last_error: j.last_error || null,
      created_at: j.created_at,
      updated_at: j.updated_at,
    }));
    res.json({ ok: true, count: jobs.length, jobs, stats: getQueueStats() });
  });

  app.post('/api/queue/clear', (req, res) => {
    if (!isAuthorized(req)) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
    try {
      const body = req.body || {};
      const result = clearPendingQueue({
        dryRun: Boolean(body.dry_run),
        staleProcessingMs: Number(body.stale_processing_ms || 2 * 60 * 1000),
        onlyIds: body.only_ids,
        exceptIds: body.except_ids,
        unmarkIds: body.unmark_ids,
        includeProcessed: Boolean(body.include_processed),
        allStatuses: Boolean(body.all_statuses),
      });
      for (const row of body.mark_processed || []) {
        const id = String(row.job_id || row.order_id || '').trim();
        if (!id) continue;
        if (!body.dry_run) {
          markProcessed(id, {
            status: row.status || STATUS.SUCCESS,
            deciplus_member_id: row.deciplus_member_id || null,
            deciplus_sale_id: row.deciplus_sale_id || null,
            error: row.error || null,
            action: row.action || 'sale',
          });
        }
        result.marked_processed = (result.marked_processed || []).concat(id);
      }
      logInfo('File bot vidée via API', {
        cleared: result.cleared.length,
        unmarked: result.unmarked.length,
        dry_run: Boolean(body.dry_run),
      });
      res.json({ ok: true, ...result, stats: getQueueStats() });
    } catch (err) {
      logError('Clear queue échoué', { error: err.message });
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/api/queue/requeue-stale', (req, res) => {
    if (!isAuthorized(req)) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
    const { requeueInterruptedJobs } = require('../lib/queue');
    const maxAgeMs = Number(req.body?.max_age_ms || process.env.BOT_STALE_PROCESSING_MS || 3 * 60 * 1000);
    const count = requeueInterruptedJobs(maxAgeMs, { includeSessionErrors: true });
    res.json({ ok: true, requeued: count, max_age_ms: maxAgeMs, stats: getQueueStats() });
  });

  return app;
}

function startBotServer() {
  const app = createBotServer();
  app.listen(PORT, '0.0.0.0', () => {
    logInfo(`Bot HTTP ingest → :${PORT}`);
  });
  return app;
}

module.exports = { createBotServer, startBotServer };
