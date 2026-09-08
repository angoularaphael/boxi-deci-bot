const fs = require('fs');
const path = require('path');
const { ROOT, ensureDir } = require('./utils');

const LOG_DIR =
  process.env.BOXPLUS_LOG_DIR ||
  (process.env.VERCEL ? '/tmp/boxplus-logs' : path.join(ROOT, 'logs'));

const DEFAULT_ALERT_EMAIL = 'boxingcentertls@gmail.com';
const ALERT_COOLDOWN_MS = Number(process.env.ALERT_EMAIL_COOLDOWN_MS || 60000);
const lastAlertAt = new Map();
const SECRET_KEY = /iban|token|secret|password|authorization|cookie|photo_base64/i;

function sanitizeMeta(value, depth = 0) {
  if (value == null || typeof value !== 'object' || depth > 5) return value;
  if (Array.isArray(value)) return value.map((item) => sanitizeMeta(item, depth + 1));
  const clean = {};
  for (const [key, nested] of Object.entries(value)) {
    clean[key] = SECRET_KEY.test(key)
      ? '[REDACTED]'
      : typeof nested === 'object'
        ? sanitizeMeta(nested, depth + 1)
        : nested;
  }
  return clean;
}

function writeLog(entry) {
  try {
    ensureDir(LOG_DIR);
    const file = path.join(LOG_DIR, `boxplus-${new Date().toISOString().slice(0, 10)}.jsonl`);
    const line = JSON.stringify({ ...sanitizeMeta(entry), logged_at: new Date().toISOString() });
    fs.appendFileSync(file, `${line}\n`, 'utf8');
  } catch {
    /* serverless : logs fichier optionnels */
  }
}

function logJobEvent(event, meta = {}) {
  const allowed = {
    event,
    order_id: meta.order_id || null,
    action: meta.action || null,
    phase: meta.phase || null,
    attempt: Number(meta.attempt || 0) || null,
    classification: meta.classification || null,
    duration_ms: Number(meta.duration_ms || 0) || null,
    member_id: meta.member_id || null,
    sale_id: meta.sale_id || null,
    worker_id: meta.worker_id || process.env.BOT_ID || null,
  };
  logInfo(`job_event:${event}`, allowed);
}

function logInfo(message, meta = {}) {
  const entry = { level: 'info', message, ...meta };
  console.log(`[BOXPLUS] ${message}`, meta.order_id ? `(order: ${meta.order_id})` : '');
  writeLog(entry);
}

function logError(message, meta = {}) {
  const entry = { level: 'error', message, ...meta };
  console.error(`[BOXPLUS] ERROR: ${message}`, meta);
  writeLog(entry);
}

function logWarn(message, meta = {}) {
  const entry = { level: 'warn', message, ...meta };
  console.warn(`[BOXPLUS] WARN: ${message}`, meta);
  writeLog(entry);
}

function alertCooldownKey(message, meta = {}) {
  return String(meta.job_id || meta.order_id || message || 'alert').slice(0, 180);
}

function allowAlert(key) {
  const now = Date.now();
  const prev = lastAlertAt.get(key) || 0;
  if (now - prev < ALERT_COOLDOWN_MS) return false;
  lastAlertAt.set(key, now);
  return true;
}

function formatAlertText(message, meta = {}) {
  const bot = process.env.BOT_ID || process.env.DECIPLUS_USER || process.env.BOT_ROLE || 'bot';
  const lines = [
    String(message || 'Alerte BOXPLUS'),
    '',
    `Bot: ${bot}`,
    meta.order_id ? `Commande: ${meta.order_id}` : '',
    meta.job_id ? `Job: ${meta.job_id}` : '',
    meta.action ? `Action: ${meta.action}` : '',
    meta.error ? `Erreur: ${meta.error}` : '',
  ].filter(Boolean);
  return lines.join('\n');
}

async function sendAlertEmail(message, meta = {}) {
  const to = String(process.env.ALERT_EMAIL || DEFAULT_ALERT_EMAIL).trim();
  const key = String(process.env.RESEND_API_KEY || '')
    .trim()
    .replace(/^["']|["']$/g, '');
  if (!to) return;
  if (!key) {
    logWarn('Alerte email non envoyée (RESEND_API_KEY manquant)', { to });
    return;
  }
  const bot = process.env.BOT_ID || process.env.DECIPLUS_USER || 'bot';
  const subject = `[BOXPLUS ${bot}] ${String(message || 'Alerte').slice(0, 80)}`;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: `${process.env.RESEND_SENDER_NAME || 'Boxing Center'} <${
          process.env.RESEND_SENDER_EMAIL || 'no-reply@boxingcenter.fr'
        }>`,
        to: [to],
        subject,
        text: formatAlertText(message, meta),
        reply_to: process.env.RESEND_REPLY_TO || DEFAULT_ALERT_EMAIL,
      }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.message || data.name || `Resend HTTP ${res.status}`);
    }
  } catch (err) {
    logError('Alerte email échouée', { error: err.message, to });
  }
}

async function sendAlert(message, meta = {}) {
  logError(message, meta);
  const key = alertCooldownKey(message, meta);
  if (!allowAlert(key)) return;

  const url = process.env.ALERT_WEBHOOK_URL;
  if (url) {
    try {
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: message, meta }),
      });
    } catch (err) {
      logError('Alert webhook failed', { error: err.message });
    }
  }

  await sendAlertEmail(message, meta);
}

module.exports = {
  LOG_DIR,
  writeLog,
  logInfo,
  logError,
  logWarn,
  sendAlert,
  sendAlertEmail,
  DEFAULT_ALERT_EMAIL,
  formatAlertText,
  sanitizeMeta,
  logJobEvent,
};
