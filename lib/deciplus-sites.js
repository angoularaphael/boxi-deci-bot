'use strict';

/**
 * Sites Deciplus vs salles boutique.
 *
 * Inscription neuve « États-Unis » → fiche créée à Minimes.
 * Fiche déjà sur le club Deciplus États-Unis → migrer vers Minimes avant la vente.
 */
const { getGymConfig } = require('./normalize');
const { BOXING_CENTER_GYM_SLUGS, resolveSearchGymSlug } = require('./gym-slugs');

function normalizeSiteLabel(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\bst\b/g, 'saint')
    .replace(/\bste\b/g, 'sainte')
    .replace(/\bboxing center\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function existingSiteConfig(gymConfig) {
  if (!gymConfig?.deciplus_existing_label) return null;
  return {
    key: `${gymConfig.key || 'gym'}-existing`,
    source_gym: gymConfig.key || null,
    label: gymConfig.label || gymConfig.deciplus_existing_label,
    deciplus_label: gymConfig.deciplus_existing_label,
    deciplus_zone_id: String(gymConfig.deciplus_existing_zone_id || ''),
    existing_only: true,
  };
}

function siteKey(cfg) {
  return normalizeSiteLabel(cfg?.deciplus_label || cfg?.label);
}

/** Club Deciplus où créer une fiche neuve (États-Unis boutique → Minimes). */
function createGymConfig(gymSlug) {
  return getGymConfig(gymSlug);
}

/**
 * Clubs Deciplus à parcourir pour retrouver une fiche existante.
 * Balma n’est jamais inclus sauf lookup migration explicite (env + option).
 */
function uniqueDeciplusSearchConfigs(preferredSlug, options = {}) {
  const seen = new Set();
  const out = [];
  const add = (cfg) => {
    if (!cfg) return;
    const key = siteKey(cfg);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(cfg);
  };

  const preferred = createGymConfig(resolveSearchGymSlug(preferredSlug));
  add(existingSiteConfig(preferred));
  add(preferred);

  for (const slug of BOXING_CENTER_GYM_SLUGS) {
    if (slug === String(preferredSlug || '').toLowerCase()) continue;
    const cfg = createGymConfig(slug);
    add(existingSiteConfig(cfg));
    add(cfg);
  }
  const { balmaMigrationLookupAllowed } = require('./gym-slugs');
  if (options.allowBalmaLookup && balmaMigrationLookupAllowed()) {
    add(createGymConfig('balma'));
  }
  return out;
}

/**
 * Inscription (sale) — recherche rapide : salle commandée + site legacy États-Unis.
 * Évite de parcourir les 5 clubs BC à chaque nouvelle fiche (~1–3 min gagnées).
 * Repli multi-salles complet si doublon Deciplus à la création (findOrCreateMember).
 * Forcer l’ancien comportement : DECIPLUS_SEARCH_ALL_GYMS=1
 */
function saleMemberSearchConfigs(preferredSlug, options = {}) {
  if (
    options.allGyms ||
    String(process.env.DECIPLUS_SEARCH_ALL_GYMS || '0').trim() === '1'
  ) {
    return uniqueDeciplusSearchConfigs(preferredSlug, options);
  }

  const seen = new Set();
  const out = [];
  const add = (cfg) => {
    if (!cfg) return;
    const key = siteKey(cfg);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(cfg);
  };

  const preferred = createGymConfig(resolveSearchGymSlug(preferredSlug));
  add(existingSiteConfig(preferred));
  add(preferred);

  // Fiches historiques zone Deciplus « États-Unis » (id 7), quelle que soit la salle boutique.
  const etatsUnis = createGymConfig('etats-unis');
  add(existingSiteConfig(etatsUnis));

  return out;
}

function isEtatsUnisDeciplusSite(gymConfig = {}) {
  const label = normalizeSiteLabel(gymConfig.deciplus_label || gymConfig.label);
  const zone = String(gymConfig.deciplus_zone_id || '');
  return zone === '7' || label === 'etats unis';
}

function gymConfigFromZoneId(zoneId) {
  const want = String(zoneId || '').trim();
  if (!want) return null;
  const balma = createGymConfig('balma');
  if (String(balma.deciplus_zone_id || '1') === want) {
    return { key: 'balma', ...balma };
  }
  for (const slug of BOXING_CENTER_GYM_SLUGS) {
    const cfg = createGymConfig(slug);
    if (String(cfg.deciplus_zone_id || '') === want) return cfg;
    const existing = existingSiteConfig(cfg);
    if (existing && String(existing.deciplus_zone_id || '') === want) return existing;
  }
  return null;
}

module.exports = {
  normalizeSiteLabel,
  existingSiteConfig,
  createGymConfig,
  uniqueDeciplusSearchConfigs,
  saleMemberSearchConfigs,
  isEtatsUnisDeciplusSite,
  gymConfigFromZoneId,
};
