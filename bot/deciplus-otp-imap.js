'use strict';

/**
 * Lit automatiquement le code email Deciplus (2FA / session) via IMAP.
 * Env :
 *   DECIPLUS_IMAP_USER / DECIPLUS_IMAP_PASS  (prioritaires)
 *   ou IMAP_USER / IMAP_PASS                 (repli, ex. même boîte que mail-bot)
 *   DECIPLUS_IMAP_HOST (défaut imap.gmail.com)
 *   DECIPLUS_IMAP_PORT (défaut 993)
 */

const { logInfo, logWarn } = require('../lib/logger');

function imapConfig() {
  const user = String(
    process.env.DECIPLUS_IMAP_USER || process.env.IMAP_USER || ''
  )
    .trim()
    .replace(/^["']|["']$/g, '');
  const pass = String(
    process.env.DECIPLUS_IMAP_PASS || process.env.IMAP_PASS || ''
  )
    .trim()
    .replace(/^["']|["']$/g, '');
  return {
    host: process.env.DECIPLUS_IMAP_HOST || process.env.IMAP_HOST || 'imap.gmail.com',
    port: Number(process.env.DECIPLUS_IMAP_PORT || process.env.IMAP_PORT || 993),
    user,
    pass,
  };
}

function isImapOtpConfigured() {
  const { user, pass } = imapConfig();
  return Boolean(user && pass);
}

function extractOtpCode(text = '') {
  const raw = String(text || '');
  // Priorité : formulations type « code : 123456 »
  const labeled = raw.match(
    /(?:code|otp|validation|vérification|verification)\s*(?:de\s+vérification)?\s*[:\s]+(\d{4,8})\b/i
  );
  if (labeled?.[1]) return labeled[1];
  // Sinon premier bloc de 6 chiffres isolé (le plus courant chez Deciplus)
  const six = raw.match(/(?<!\d)(\d{6})(?!\d)/);
  if (six?.[1]) return six[1];
  const four = raw.match(/(?<!\d)(\d{4,8})(?!\d)/);
  return four?.[1] || null;
}

function looksLikeDeciplusOtpMail({ subject = '', from = '', text = '' } = {}) {
  const blob = `${subject}\n${from}\n${text}`.toLowerCase();
  if (/deciplus|boxing\s*center|boxingcenter/.test(blob)) return true;
  if (/(code|otp|vérification|verification|connexion|login|authent)/i.test(blob) && /\d{4,8}/.test(blob)) {
    return true;
  }
  return false;
}

/**
 * Poll IMAP jusqu’à trouver un code récent.
 * @param {{ maxWaitMs?: number, pollMs?: number, sinceMs?: number }} opts
 */
async function fetchDeciplusEmailCode(opts = {}) {
  if (!isImapOtpConfigured()) {
    return null;
  }

  let ImapFlow;
  let simpleParser;
  try {
    ImapFlow = require('imapflow').ImapFlow;
    simpleParser = require('mailparser').simpleParser;
  } catch {
    logWarn(
      'imapflow/mailparser absents — npm install imapflow mailparser (lecture auto code Deciplus)'
    );
    return null;
  }

  const cfg = imapConfig();
  const maxWaitMs = Number(opts.maxWaitMs || process.env.DECIPLUS_OTP_WAIT_MS || 90000);
  const pollMs = Number(opts.pollMs || process.env.DECIPLUS_OTP_POLL_MS || 4000);
  const sinceMs = Number(opts.sinceMs || 15 * 60 * 1000);
  const startedAt = Date.now();
  let attempt = 0;

  logInfo('Lecture IMAP du code email Deciplus…', {
    user: cfg.user,
    host: cfg.host,
    max_wait_s: Math.round(maxWaitMs / 1000),
  });

  while (Date.now() - startedAt < maxWaitMs) {
    attempt += 1;
    const client = new ImapFlow({
      host: cfg.host,
      port: cfg.port,
      secure: true,
      auth: { user: cfg.user, pass: cfg.pass },
      logger: false,
      tls: { rejectUnauthorized: false },
    });

    try {
      await client.connect();
      const lock = await client.getMailboxLock('INBOX');
      try {
        const since = new Date(Date.now() - sinceMs);
        const uids = (await client.search({ since }, { uid: true })) || [];
        if (uids.length) {
          const dated = [];
          for await (const msg of client.fetch(uids, { uid: true, internalDate: true }, { uid: true })) {
            dated.push({ uid: msg.uid, date: msg.internalDate || new Date(0) });
          }
          dated.sort((a, b) => new Date(b.date) - new Date(a.date));
          const batch = dated.slice(0, 12).map((d) => d.uid);

          for await (const msg of client.fetch(
            batch,
            { uid: true, source: true, envelope: true, internalDate: true },
            { uid: true }
          )) {
            const parsed = await simpleParser(msg.source, {
              skipTextToHtml: false,
              skipImageLinks: true,
            });
            const subject = String(parsed.subject || msg.envelope?.subject || '');
            const from = String(
              parsed.from?.text ||
                (msg.envelope?.from || []).map((f) => f.address || '').join(' ') ||
                ''
            );
            const text = [parsed.text, parsed.html ? String(parsed.html).replace(/<[^>]+>/g, ' ') : '']
              .filter(Boolean)
              .join('\n');
            if (!looksLikeDeciplusOtpMail({ subject, from, text })) continue;
            const code = extractOtpCode(`${subject}\n${text}`);
            if (!code) continue;
            const ageSec = Math.round((Date.now() - new Date(msg.internalDate || 0).getTime()) / 1000);
            logInfo('Code email Deciplus trouvé via IMAP', {
              subject: subject.slice(0, 80),
              age_s: ageSec,
              attempt,
            });
            return code;
          }
        }
      } finally {
        lock.release();
      }
      await client.logout().catch(() => {});
    } catch (err) {
      logWarn('IMAP code Deciplus — tentative échouée', {
        attempt,
        error: err.message,
      });
      try {
        await client.logout();
      } catch {
        /* ignore */
      }
    }

    await new Promise((r) => setTimeout(r, pollMs));
  }

  logWarn('Aucun code email Deciplus trouvé dans la boîte IMAP', {
    user: cfg.user,
    waited_s: Math.round((Date.now() - startedAt) / 1000),
  });
  return null;
}

module.exports = {
  isImapOtpConfigured,
  extractOtpCode,
  looksLikeDeciplusOtpMail,
  fetchDeciplusEmailCode,
};
