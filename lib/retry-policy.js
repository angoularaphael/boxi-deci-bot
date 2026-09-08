'use strict';

const CLASSIFICATION = Object.freeze({
  VALIDATION: 'validation_customer_data',
  AUTH: 'authentication_session',
  TRANSIENT: 'transient_deciplus_ui_network',
  CONFLICT: 'conflict_duplicate',
  CALLBACK: 'callback_storage',
  UNKNOWN: 'unknown',
});

function classifyError(error) {
  const message = String(error?.message || error || '');
  const code = String(error?.code || '');
  if (/iban.*(invalide|requis|manquant)|validation:|champ.*requis|birthdate|date de naissance|gym.*manquant/i.test(message)) {
    return { classification: CLASSIFICATION.VALIDATION, retryable: false, action: 'Corriger les données client puis relancer.' };
  }
  if (/doublon|duplicate|already|conflit|unique|23505|ancien abo toujours actif/i.test(`${code} ${message}`)) {
    return { classification: CLASSIFICATION.CONFLICT, retryable: false, action: 'Vérifier les contrats Deciplus avant toute relance.' };
  }
  if (/callback|supabase|stockage|storage|fetch failed.*boutique|sale-status/i.test(message)) {
    return { classification: CLASSIFICATION.CALLBACK, retryable: true, action: 'Vérifier Supabase et le callback boutique.' };
  }
  if (/session|auth|login|otp|mfa|cookie|401|unauthorized|browser has been closed|target page/i.test(message)) {
    return { classification: CLASSIFICATION.AUTH, retryable: true, action: 'Renouveler la session Deciplus/OTP.' };
  }
  if (/timeout|timed out|network|econn|enotfound|502|503|504|navigation|detached|temporar/i.test(message)) {
    return { classification: CLASSIFICATION.TRANSIENT, retryable: true, action: 'Relancer après rétablissement du service.' };
  }
  return { classification: CLASSIFICATION.UNKNOWN, retryable: true, action: 'Examiner les événements structurés du job.' };
}

function backoffMs(attempt, options = {}) {
  const base = Number(options.baseMs || process.env.BOT_RETRY_BASE_MS || 5000);
  const cap = Number(options.capMs || process.env.BOT_RETRY_CAP_MS || 15 * 60 * 1000);
  const random = options.random || Math.random;
  const exponential = Math.min(cap, base * 2 ** Math.max(0, Number(attempt || 1) - 1));
  const jitter = 0.75 + random() * 0.5;
  return Math.round(exponential * jitter);
}

module.exports = { CLASSIFICATION, classifyError, backoffMs };
