/**
 * Slugs salles — alignés sur config/gym-mapping.json et checkout boutique.
 */
const GYM_SLUGS = ['st-cyprien', 'minimes', 'ramonville', 'portet', 'etats-unis', 'balma'];
/** 5 salles Boxing Center — jamais Balma (autre opérateur). */
const BOXING_CENTER_GYM_SLUGS = GYM_SLUGS.filter((slug) => slug !== 'balma');

const GYM_LABELS = {
  'st-cyprien': ['st-cyprien', 'st cyprien', 'saint-cyprien', 'saint cyprien', 'boxing center st-cyprien', 'boxing center st cyprien'],
  minimes: ['minimes', 'boxing center minimes'],
  ramonville: ['ramonville', 'boxing center ramonville'],
  portet: ['portet', 'portet-sur-garonne', 'boxing center portet'],
  'etats-unis': ['etats-unis', 'etats unis', 'boxing center etats-unis', 'boxing center etats unis'],
  balma: ['balma', 'boxing center balma'],
};

function stripAccents(text) {
  return String(text)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function normalizeGymText(raw) {
  let text = stripAccents(String(raw || '').toLowerCase().trim().replace(/<[^>]+>/g, ''));
  text = text.replace(/[^a-z0-9\s-]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (text.includes(' ') && !text.includes('-')) {
    return text.replace(/\s+/g, '-');
  }
  return text;
}

function isValidGymSlug(slug) {
  return GYM_SLUGS.includes(String(slug));
}

function matchGymLabel(text) {
  const normalized = normalizeGymText(text);
  if (!normalized) return null;

  for (const [slug, aliases] of Object.entries(GYM_LABELS)) {
    for (const alias of aliases) {
      if (normalized === alias || normalized.includes(alias)) {
        return slug;
      }
    }
  }
  return null;
}

function matchGymSlug(raw) {
  const text = normalizeGymText(raw);
  if (!text) return null;
  if (isValidGymSlug(text)) return text;

  const explicit = text.match(/(?:gym|salle)\s*[:=]\s*([a-z0-9][a-z0-9-]*)/i);
  if (explicit) {
    const slug = normalizeGymText(explicit[1]);
    if (isValidGymSlug(slug)) return slug;
    const fromLabel = matchGymLabel(slug);
    if (fromLabel) return fromLabel;
  }

  return matchGymLabel(text);
}

function extractGymFromTexts(texts, defaultGym = 'minimes') {
  const list = Array.isArray(texts) ? texts : [texts];
  for (const raw of list) {
    const slug = matchGymSlug(raw);
    if (slug) return slug;
  }
  const fallback = normalizeGymText(defaultGym);
  return isValidGymSlug(fallback) ? fallback : 'minimes';
}

function extractIbanFromTexts(texts) {
  const list = Array.isArray(texts) ? texts : [texts];
  for (const raw of list) {
    const compact = String(raw || '').replace(/\s+/g, '').toLowerCase();
    const match = compact.match(/fr\d{2}[a-z0-9]{23}/i);
    if (match) return match[0].toUpperCase();
  }
  return null;
}

function isBalmaGymSlug(slug) {
  return String(slug || '').trim().toLowerCase() === 'balma';
}

const BALMA_SALE_ERROR = 'Interdit : aucune offre Boxing Center n’est créée sur Balma';
const BALMA_DESTINATION_FORBIDDEN =
  'Interdit : aucun adhérent Boxing Center ne peut être créé, migré ou vendu sur Balma';

function balmaMigrationLookupAllowed() {
  return String(process.env.BOXPLUS_BALMA_MIGRATION_LOOKUP || '0') === '1';
}

function resolveSearchGymSlug(slug) {
  return remapBalmaGymSlug(String(slug || 'minimes').trim().toLowerCase()) || 'minimes';
}

function assertNeverBalmaDestination(gymConfig = {}, order = {}, context = 'operation') {
  if (isBalmaSaleTarget(gymConfig, order)) {
    throw new Error(`${BALMA_DESTINATION_FORBIDDEN} (${context})`);
  }
}

function isBalmaSaleTarget(gymConfig = {}, order = {}) {
  const parts = [
    gymConfig.key,
    gymConfig.slug,
    gymConfig.deciplus_label,
    gymConfig.label,
    order.gym,
  ];
  for (const part of parts) {
    const slug = matchGymSlug(part) || normalizeGymText(part);
    if (isBalmaGymSlug(slug) || /\bbalma\b/.test(String(slug || ''))) return true;
  }
  return String(gymConfig.deciplus_zone_id || '') === '1';
}

function assertNotBalmaSale(gymConfig, order) {
  if (isBalmaSaleTarget(gymConfig, order)) {
    throw new Error(BALMA_SALE_ERROR);
  }
}

/** Jamais une vente / migration vers Balma : la destination Boxing Center est Minimes. */
function resolveSaleGymConfig(gymConfigOrSlug, order = {}) {
  const { getGymConfig } = require('./normalize');
  const cfg =
    gymConfigOrSlug && typeof gymConfigOrSlug === 'object'
      ? gymConfigOrSlug
      : getGymConfig(gymConfigOrSlug || order.gym || 'minimes');
  if (!isBalmaSaleTarget(cfg, order)) return cfg;
  return getGymConfig('minimes');
}

function remapBalmaGymSlug(slug) {
  const raw = String(slug || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-');
  if (isBalmaGymSlug(raw) || raw === 'boxing-center-balma') return 'minimes';
  return slug;
}

/** Résil / changement d’abo : toutes les salles BC, Balma exclue. Preferred gym first. */
function boxingCenterGymsExceptBalma(preferred) {
  const want = String(preferred || '')
    .trim()
    .toLowerCase();
  const rest = BOXING_CENTER_GYM_SLUGS.filter((slug) => slug !== want);
  if (BOXING_CENTER_GYM_SLUGS.includes(want)) return [want, ...rest];
  return [...BOXING_CENTER_GYM_SLUGS];
}

module.exports = {
  GYM_SLUGS,
  BOXING_CENTER_GYM_SLUGS,
  GYM_LABELS,
  normalizeGymText,
  isValidGymSlug,
  isBalmaGymSlug,
  isBalmaSaleTarget,
  assertNotBalmaSale,
  assertNeverBalmaDestination,
  balmaMigrationLookupAllowed,
  resolveSearchGymSlug,
  resolveSaleGymConfig,
  remapBalmaGymSlug,
  BALMA_SALE_ERROR,
  BALMA_DESTINATION_FORBIDDEN,
  boxingCenterGymsExceptBalma,
  matchGymSlug,
  matchGymLabel,
  extractGymFromTexts,
  extractIbanFromTexts,
};
