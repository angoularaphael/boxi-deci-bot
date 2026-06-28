const fs = require('fs');
const path = require('path');
const { ROOT, ensureDir } = require('./utils');
const { logInfo, logWarn } = require('./logger');
const { getJobId } = require('./normalize');

const QUEUE_DIR =
  process.env.BOXPLUS_QUEUE_DIR ||
  (process.env.VERCEL ? '/tmp/boxplus-queue' : path.join(ROOT, 'data', 'queue'));
const PROCESSED_FILE = path.join(QUEUE_DIR, 'processed-orders.json');

const STATUS = {
  PENDING: 'pending',
  PROCESSING: 'processing',
  SUCCESS: 'success',
  ERROR: 'error',
  DUPLICATE: 'duplicate',
  MANUAL_REVIEW: 'manual_review',
  REJECTED: 'rejected',
};

function initQueue() {
  ensureDir(QUEUE_DIR);
  if (!fs.existsSync(PROCESSED_FILE)) {
    fs.writeFileSync(PROCESSED_FILE, JSON.stringify({ orders: {} }, null, 2), 'utf8');
  }
}

function loadProcessed() {
  initQueue();
  return JSON.parse(fs.readFileSync(PROCESSED_FILE, 'utf8'));
}

function saveProcessed(data) {
  fs.writeFileSync(PROCESSED_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function sanitizeJobFilename(jobId) {
  return String(jobId).replace(/[^a-zA-Z0-9_-]+/g, '__');
}

function isProcessed(jobId) {
  const data = loadProcessed();
  return Boolean(data.orders[jobId]);
}

function getProcessedRecord(jobId) {
  const data = loadProcessed();
  return data.orders[jobId] || null;
}

function markProcessed(jobId, result) {
  const data = loadProcessed();
  data.orders[jobId] = {
    status: result.status,
    action: result.action || null,
    deciplus_member_id: result.deciplus_member_id || null,
    deciplus_sale_id: result.deciplus_sale_id || null,
    processed_at: new Date().toISOString(),
    error: result.error || null,
  };
  saveProcessed(data);
}

function markSaleCancelled(orderId) {
  const data = loadProcessed();
  if (data.orders[orderId]) {
    data.orders[orderId].cancelled_at = new Date().toISOString();
    data.orders[orderId].cancel_status = STATUS.SUCCESS;
  }
  saveProcessed(data);
}

function enqueue(order) {
  initQueue();
  const jobId = order.job_id || getJobId(order);
  if (!order.order_id && !jobId) throw new Error('order_id requis');

  if (isProcessed(jobId)) {
    logWarn('Job déjà traité (idempotence)', { job_id: jobId });
    return { queued: false, reason: 'already_processed', job_id: jobId, order_id: order.order_id };
  }

  const file = path.join(QUEUE_DIR, `${sanitizeJobFilename(jobId)}.json`);
  if (fs.existsSync(file)) {
    return { queued: false, reason: 'already_queued', job_id: jobId, order_id: order.order_id };
  }

  const payload = {
    ...order,
    job_id: jobId,
    status: STATUS.PENDING,
    created_at: new Date().toISOString(),
    attempts: 0,
  };
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
  logInfo('Job ajouté à la file', { job_id: jobId, order_id: order.order_id, action: order.action || 'sale' });
  return { queued: true, job_id: jobId, order_id: order.order_id, file };
}

function listPending() {
  initQueue();
  return fs
    .readdirSync(QUEUE_DIR)
    .filter((f) => f.endsWith('.json') && f !== 'processed-orders.json')
    .map((f) => {
      const full = path.join(QUEUE_DIR, f);
      const data = JSON.parse(fs.readFileSync(full, 'utf8'));
      return { file: full, ...data };
    })
    .filter((item) => {
      const jobId = item.job_id || item.order_id;
      if (jobId && isProcessed(jobId)) return false;
      return item.status === STATUS.PENDING || item.status === STATUS.ERROR;
    })
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
}

function updateJob(filePath, patch) {
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const next = { ...data, ...patch, updated_at: new Date().toISOString() };
  fs.writeFileSync(filePath, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

function removeJob(filePath) {
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

function getQueueStats() {
  initQueue();
  const processed = loadProcessed();
  const pending = listPending();
  const counts = { pending: 0, error: 0, success: 0, manual_review: 0, duplicate: 0, cancelled: 0 };
  for (const job of pending) {
    counts[job.status === STATUS.ERROR ? 'error' : 'pending'] += 1;
  }
  for (const entry of Object.values(processed.orders)) {
    if (entry.status === STATUS.SUCCESS) {
      if (entry.action === 'cancel') counts.cancelled += 1;
      else counts.success += 1;
    } else if (entry.status === STATUS.MANUAL_REVIEW) counts.manual_review += 1;
    else if (entry.status === STATUS.DUPLICATE) counts.duplicate += 1;
    else if (entry.status === STATUS.ERROR) counts.error += 1;
    else if (entry.status === STATUS.REJECTED) counts.error += 1;
  }
  return { counts, pending_jobs: pending.length, processed_total: Object.keys(processed.orders).length };
}

module.exports = {
  QUEUE_DIR,
  STATUS,
  enqueue,
  listPending,
  updateJob,
  removeJob,
  isProcessed,
  getProcessedRecord,
  markProcessed,
  markSaleCancelled,
  getQueueStats,
};
