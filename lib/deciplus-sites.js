'use strict';

/**
 * Sites Deciplus vs salles boutique.
 *
 * Inscription neuve « États-Unis » → fiche créée à Minimes.
 * Fiche déjà sur le club Deciplus États-Unis → migrer vers Minimes avant la vente.
 */
const { getGymConfig } = require('./normalize');
const { BOXING_CENTER_GYM_SLUGS } = require('./gym-slugs');

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
 * États-Unis (club réel) en premier si la commande boutique est etats-unis.
 */
function uniqueDeciplusSearchConfigs(preferredSlug) {
  const seen = new Set();
  const out = [];
  const add = (cfg) => {
    if (!cfg) return;
    const key = siteKey(cfg);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(cfg);
  };

  const preferred = createGymConfig(preferredSlug);
  add(existingSiteConfig(preferred));
  add(preferred);

  for (const slug of BOXING_CENTER_GYM_SLUGS) {
    if (slug === String(preferredSlug || '').toLowerCase()) continue;
    const cfg = createGymConfig(slug);
    add(existingSiteConfig(cfg));
    add(cfg);
  }
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
  isEtatsUnisDeciplusSite,
  gymConfigFromZoneId,
};
