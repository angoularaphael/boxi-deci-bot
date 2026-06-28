const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function loadJson(relativePath, { optional = false } = {}) {
  const full = path.join(ROOT, relativePath);
  try {
    return JSON.parse(fs.readFileSync(full, 'utf8'));
  } catch (err) {
    if (optional || (process.env.VERCEL && err.code === 'ENOENT')) {
      return null;
    }
    throw err;
  }
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelay(minMs, maxMs) {
  const min = Number(minMs) || 1000;
  const max = Number(maxMs) || 3000;
  const ms = min + Math.floor(Math.random() * (max - min + 1));
  return sleep(ms);
}

function redactHeaders(headers) {
  const copy = { ...headers };
  for (const key of Object.keys(copy)) {
    const lower = key.toLowerCase();
    if (lower === 'authorization' || lower === 'cookie' || lower.includes('token')) {
      copy[key] = '[REDACTED]';
    }
  }
  return copy;
}

function safeParseJson(text) {
  if (!text || typeof text !== 'string') return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function truncate(value, max = 4000) {
  const str = typeof value === 'string' ? value : JSON.stringify(value);
  if (!str) return '';
  return str.length > max ? `${str.slice(0, max)}…` : str;
}

module.exports = {
  ROOT,
  loadJson,
  ensureDir,
  timestamp,
  sleep,
  randomDelay,
  redactHeaders,
  safeParseJson,
  truncate,
};
