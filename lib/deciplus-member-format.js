'use strict';

/**
 * Helpers purs (sans Playwright) — format téléphone + URLs Deciplus nextgen/legacy.
 */

/**
 * Normalise un téléphone FR en 10 chiffres (0XXXXXXXXX).
 * Ne tronque plus les numéros trop longs (sinon 07878787879 ≈ 0787878787).
 */
function phoneForDeciplus(raw) {
  let digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return '';

  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('33') && digits.length === 11) {
    digits = `0${digits.slice(2)}`;
  } else if (digits.startsWith('33') && digits.length === 12 && digits[2] === '0') {
    digits = digits.slice(2);
  }

  if (digits.length === 9 && /^[1-9]/.test(digits)) {
    digits = `0${digits}`;
  }

  if (/^0\d{9}$/.test(digits)) return digits;
  return '';
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

/** Saisie recherche Deciplus : majuscules, espaces normalisés (la fiche stocke TEST, pas Test). */
function nameForDeciplusSearch(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toUpperCase();
}

function normalizePerson(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function namesMatch(a, b) {
  const na = normalizePerson(a);
  const nb = normalizePerson(b);
  return Boolean(na && nb && na === nb);
}

function normalizeEmail(value) {
  return String(value || '')
    .trim()
    .toLowerCase();
}

function emailsMatch(a, b) {
  const na = normalizeEmail(a);
  const nb = normalizeEmail(b);
  return Boolean(na && nb && na === nb);
}

/** Normalise une date Deciplus / ISO vers JJ/MM/AAAA comparable. */
function normalizeBirthCompare(value) {
  const raw = String(value || '')
    .trim()
    .replace(/\s/g, '')
    .replace(/-/g, '/');
  if (!raw) return '';
  let m = raw.match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  m = raw.match(/^(\d{2})\/(\d{2})\/(\d{2})$/);
  if (m) {
    const yy = Number(m[3]);
    const century = yy > 30 ? 1900 : 2000;
    return `${m[1]}/${m[2]}/${century + yy}`;
  }
  m = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (m) return `${m[1]}/${m[2]}/${m[3]}`;
  return raw;
}

function birthdatesMatch(a, b) {
  const na = normalizeBirthCompare(a);
  const nb = normalizeBirthCompare(b);
  return Boolean(na && nb && na === nb);
}

/**
 * Un hit recherche (email/tél) n’est la même personne que si nom + prénom collent.
 * Un mail de couple ne doit jamais réutiliser la fiche du conjoint (Derdour / Yousfi).
 */
function memberSearchHitMatches(form, customer = {}) {
  if (!form) return false;
  const custLast = String(customer.last_name || '').trim();
  const custFirst = String(customer.first_name || '').trim();
  const formLast = String(form.lastName || form.last_name || '').trim();
  const formFirst = String(form.firstName || form.first_name || '').trim();

  if (custLast && (!formLast || !namesMatch(formLast, custLast))) return false;
  if (custFirst && (!formFirst || !namesMatch(formFirst, custFirst))) return false;

  const custBirth = String(customer.birthdate || '').trim();
  const formBirth = String(form.birth || form.birthdate || '').trim();
  if (custBirth && formBirth && !birthdatesMatch(formBirth, custBirth)) return false;

  const wantEmail = normalizeEmail(customer.email);
  const formEmail = normalizeEmail(form.email);
  if (wantEmail && formEmail) return emailsMatch(wantEmail, formEmail);

  const wantPhone = phoneForDeciplus(customer.phone);
  const formPhone = phoneForDeciplus(form.phone);
  if (wantPhone && formPhone) return wantPhone === formPhone;

  return Boolean((formLast || formFirst) && (custLast || custFirst));
}

/** Email réel d’adhérent — pas le mail PSP Aventure `aventure.<order>@boxplus-test.local`. */
function isSearchableMemberEmail(value) {
  const email = normalizeEmail(value);
  if (!email.includes('@')) return '';
  if (/^aventure\.[a-z0-9-]+@boxplus-test\.local$/.test(email)) return '';
  return email;
}

module.exports = {
  phoneForDeciplus,
  expandDeciplusUrl,
  extractMemberIdFromUrl,
  isNewMemberUrl,
  nameForDeciplusSearch,
  normalizePerson,
  namesMatch,
  normalizeEmail,
  emailsMatch,
  isSearchableMemberEmail,
  normalizeBirthCompare,
  birthdatesMatch,
  memberSearchHitMatches,
};
