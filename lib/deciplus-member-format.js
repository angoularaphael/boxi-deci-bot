'use strict';

/**
 * Helpers purs (sans Playwright) — format téléphone + URLs Deciplus nextgen/legacy.
 */

function phoneForDeciplus(raw) {
  let digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return '';

  if (digits.startsWith('0033')) digits = digits.slice(4);
  if (digits.startsWith('33') && digits.length >= 11) digits = digits.slice(2);
  if (digits.startsWith('0')) {
    return digits.slice(0, 10);
  }

  if (digits.length === 9) return `0${digits}`;
  if (digits.length >= 10) return `0${digits.slice(0, 9)}`;
  return digits;
}

function expandDeciplusUrl(url = '') {
  const raw = String(url || '');
  const parts = [raw];
  try {
    const decoded = decodeURIComponent(raw);
    if (decoded !== raw) parts.push(decoded);
  } catch {
    /* ignore */
  }
  try {
    const u = new URL(raw);
    const pathParam = u.searchParams.get('path');
    if (pathParam) {
      parts.push(pathParam);
      try {
        parts.push(decodeURIComponent(pathParam));
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
  return parts.join('\n');
}

function extractMemberIdFromUrl(url = '') {
  const haystack = expandDeciplusUrl(url);
  const patterns = [
    /check\.php\?[^#\s]*idj=(\d+)/i,
    /select\.php\?[^#\s]*idjnew=(\d+)/i,
    /select\.php\?[^#\s]*idj=(\d+)/i,
    /joueurs\.php\?[^#\s]*idj=(\d+)/i,
    /[?&]idjnew=(\d+)/i,
    /[?&]idj=(\d+)/i,
  ];
  for (const re of patterns) {
    const m = haystack.match(re);
    if (m && m[1] !== 'new') return m[1];
  }
  return null;
}

function isNewMemberUrl(url = '') {
  return /idj=new|idj%3Dnew/i.test(expandDeciplusUrl(url));
}

module.exports = {
  phoneForDeciplus,
  expandDeciplusUrl,
  extractMemberIdFromUrl,
  isNewMemberUrl,
};
