/**
 * Serveur HTTP minimal — reçoit les commandes Vercel et les met en file locale.
 */
require('dotenv').config();

const express = require('express');
const { enqueue, getQueueStats, STATUS } = require('../lib/queue');
const { normalizeOrder, validateOrder } = require('../lib/normalize');
const { logInfo, logError } = require('../lib/logger');

const PORT = Number(process.env.BOT_HTTP_PORT || 3050);
const SECRET = process.env.SYNC_SECRET || process.env.BRIDGE_SECRET || '';

function isAuthorized(req) {
  if (!SECRET) return false;
  const header = req.headers['x-sync-secret'] || req.headers['authorization'] || '';
  const token = String(header).replace(/^Bearer\s+/i, '').trim();
  return token === SECRET;
}

function createBotServer() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'boxi-deci-bot', stats: getQueueStats() });
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
      const result = enqueue(order);
      logInfo('Job reçu depuis boutique', {
        order_id: order.order_id,
        job_id: result.job_id,
        queued: result.queued,
      });
      res.json({ ok: true, ...result });
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
