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
  const host = String(
    process.env.DECIPLUS_IMAP_HOST || process.env.IMAP_HOST || 'imap.gmail.com'
  ).trim();
  const user = String(
    process.env.DECIPLUS_IMAP_USER || process.env.IMAP_USER || ''
  )
    .trim()
    .replace(/^["']|["']$/g, '');
  let pass = String(
    process.env.DECIPLUS_IMAP_PASS || process.env.IMAP_PASS || ''
  )
    .trim()
    .replace(/^["']|["']$/g, '');
  // Les mots de passe d'application Gmail sont souvent copiés sous forme 4×4.
  if (/gmail\.com$/i.test(host) && /^(?:[^\s]{4}\s){3}[^\s]{4}$/.test(pass)) {
    pass = pass.replace(/\s/g, '');
  }
  return {
    host,
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
  // Deciplus envoie souvent « 807 803 » avec espace fine (U+202F) entre les 3+3
  const raw = String(text || '')
    .replace(/[\u00A0\u202F\u2007\u2009]/g, ' ')
    .replace(/\s+/g, ' ');

  // Zone prioritaire : après « code unique » / « code suivant »
  const afterHint = raw.match(
    /code\s+unique[^0-9]{0,80}(\d{3}\s*\d{3}|\d{6}|\d{4,8})/i
  );
  if (afterHint?.[1]) return afterHint[1].replace(/\s+/g, '');

  const labeled = raw.match(
    /(?:code|otp|validation|vérification|verification)[^0-9]{0,40}(\d{3}\s*\d{3}|\d{6})\b/i
  );
  if (labeled?.[1]) return labeled[1].replace(/\s+/g, '');

  // 3+3 avec espace (ex. 807 803)
  const spaced = raw.match(/(?<!\d)(\d{3})\s+(\d{3})(?!\d)/);
  if (spaced) return `${spaced[1]}${spaced[2]}`;

  // 6 chiffres collés — ignorer années 20xx isolées
  const sixes = [...raw.matchAll(/(?<!\d)(\d{6})(?!\d)/g)].map((m) => m[1]);
  const notYear = sixes.find((c) => !/^20\d{2}/.test(c) && c !== '000000');
  if (notYear) return notYear;
  if (sixes[0]) return sixes[0];

  return null;
}

function looksLikeDeciplusOtpMail({ subject = '', from = '', text = '' } = {}) {
  const blob = `${subject}\n${from}\n${text}`.toLowerCase();
  if (/deciplus|xplor|boxing\s*center|boxingcenter/.test(blob)) return true;
  if (/(code|otp|vérification|verification|connexion|login|authent)/i.test(blob) && /\d{4,8}/.test(blob)) {
    return true;
  }
  return false;
}

function htmlToSafeText(html = '') {
  return String(html || '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|td|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;|&#xA0;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

async function parseOtpMessage(source, envelope = {}) {
  const { simpleParser } = require('mailparser');
  const parsed = await simpleParser(source, {
    skipTextToHtml: false,
    skipImageLinks: true,
  });
  const subject = String(parsed.subject || envelope.subject || '');
  const from = String(
    parsed.from?.text || (envelope.from || []).map((item) => item.address || '').join(' ') || ''
  );
  const text = [parsed.text, htmlToSafeText(parsed.html)].filter(Boolean).join('\n');
  const matches = looksLikeDeciplusOtpMail({ subject, from, text });
  return {
    matches,
    code: matches ? extractOtpCode(`${subject}\n${text}`) : null,
    hasText: Boolean(parsed.text),
    hasHtml: Boolean(parsed.html),
  };
}

function selectOtpMailboxes(boxes = []) {
  const selected = [];
  const add = (box, role) => {
    if (box && !selected.some((item) => item.path === box.path)) {
      selected.push({ path: box.path, role });
    }
  };
  add(
    boxes.find((box) => String(box.specialUse || '').toLowerCase() === '\\inbox') ||
      boxes.find((box) => String(box.path || '').toUpperCase() === 'INBOX'),
    'inbox'
  );
  add(
    boxes.find((box) => String(box.specialUse || '').toLowerCase() === '\\all') ||
      boxes.find((box) => /all mail|tous les messages/i.test(String(box.path || ''))),
    'all'
  );
  add(
    boxes.find((box) => String(box.specialUse || '').toLowerCase() === '\\junk') ||
      boxes.find((box) => /spam|junk|indésirables/i.test(String(box.path || ''))),
    'spam'
  );
  return selected;
}

async function scanOtpMailbox(client, mailbox, { sinceMs, notBeforeMs }) {
  const lock = await client.getMailboxLock(mailbox.path);
  let recentCount = 0;
  let matchCount = 0;
  try {
    const since = new Date(Date.now() - sinceMs);
    const uids = (await client.search({ since }, { uid: true })) || [];
    recentCount = uids.length;
    if (!uids.length) return { recentCount, matchCount, result: null };

    const dated = [];
    for await (const msg of client.fetch(
      uids,
      { uid: true, internalDate: true },
      { uid: true }
    )) {
      dated.push({ uid: msg.uid, date: msg.internalDate || new Date(0) });
    }
    dated.sort((a, b) => new Date(b.date) - new Date(a.date));

    for (const candidate of dated.slice(0, 20)) {
      const mailAt = new Date(candidate.date).getTime();
      if (notBeforeMs && mailAt + 5000 < notBeforeMs) continue;
      for await (const msg of client.fetch(
        candidate.uid,
        { uid: true, source: true, envelope: true, internalDate: true },
        { uid: true }
      )) {
        const parsed = await parseOtpMessage(msg.source, msg.envelope);
        if (!parsed.matches) continue;
        matchCount += 1;
        if (!parsed.code) continue;
        return {
          recentCount,
          matchCount,
          result: {
            code: parsed.code,
            mailAt,
            hasText: parsed.hasText,
            hasHtml: parsed.hasHtml,
          },
        };
      }
    }
    return { recentCount, matchCount, result: null };
  } finally {
    lock.release();
  }
}

/**
 * Poll IMAP jusqu’à trouver un code récent.
 * @param {{ maxWaitMs?: number, pollMs?: number, sinceMs?: number, notBeforeMs?: number }} opts
 */
async function fetchDeciplusEmailCode(opts = {}) {
  if (!isImapOtpConfigured()) {
    return null;
  }

  let ImapFlow;
  try {
    ImapFlow = require('imapflow').ImapFlow;
    require('mailparser').simpleParser;
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
  // Ignore les mails antérieurs au login (évite de rejouer un vieux code)
  const notBeforeMs = Number(opts.notBeforeMs || 0);
  const startedAt = Date.now();
  let attempt = 0;

  logInfo('Lecture IMAP du code email Deciplus…', {
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
    });

    try {
      await client.connect();
      const mailboxes = selectOtpMailboxes(await client.list());
      for (const mailbox of mailboxes) {
        const scan = await scanOtpMailbox(client, mailbox, { sinceMs, notBeforeMs });
        if (scan.result) {
          const ageSec = Math.round((Date.now() - scan.result.mailAt) / 1000);
          logInfo(`Code email Deciplus trouvé via IMAP (folder=${mailbox.role})`, {
            folder: mailbox.role,
            age_s: ageSec,
            attempt,
            has_text: scan.result.hasText,
            has_html: scan.result.hasHtml,
          });
          await client.logout().catch(() => {});
          return scan.result.code;
        }
        if (attempt === 1 || attempt % 5 === 0) {
          logInfo(
            `Diagnostic IMAP Deciplus (folder=${mailbox.role}, recent=${scan.recentCount}, matches=${scan.matchCount})`,
            {
              attempt,
              folder: mailbox.role,
              recent_count: scan.recentCount,
              match_count: scan.matchCount,
            }
          );
        }
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
    waited_s: Math.round((Date.now() - startedAt) / 1000),
  });
  return null;
}

module.exports = {
  isImapOtpConfigured,
  extractOtpCode,
  looksLikeDeciplusOtpMail,
  htmlToSafeText,
  parseOtpMessage,
  selectOtpMailboxes,
  scanOtpMailbox,
  fetchDeciplusEmailCode,
};
