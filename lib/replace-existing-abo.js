'use strict';

const { saleContractMatches } = require('./sale-contract-match');

function isCartePrestationLabel(label) {
  return /s[eé]ance d['’]?essai|coaching\s*priv/i.test(String(label || ''));
}

/**
 * Bandeau Deciplus « 1 ANNULÉ, 1 ACTIF » — ne pas le prendre pour le statut du contrat.
 */
function stripContractSummaryBanner(text) {
  return String(text || '')
    .replace(/\d+\s+(annul[éeÉE]s?|actifs?|en attente)(?=,|\s|$)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function labelEndDateMs(label) {
  const dates = String(label || '').match(/\d{2}\/\d{2}\/\d{4}/g) || [];
  if (dates.length < 2) return null;
  const end = dates[dates.length - 1];
  const [d, m, y] = end.split('/').map(Number);
  const endMs = Date.parse(`${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}T23:59:59`);
  return Number.isFinite(endMs) ? endMs : null;
}

/**
 * Quand un client paie un nouvel abo alors qu’il en a déjà un (44,99, 259, saison…),
 * on résilie l’ancien (et un 29 € encore « en attente ») puis on vend le nouveau.
 * `replaceExisting` : résilie aussi un contrat déjà démarré du même produit
 * (sauf `keepSaleId`, la vente qu’on vient de poser).
 */
function isStaleOrInactiveAbo(label) {
  const t = stripContractSummaryBanner(label);
  if (/expir|r[eéÉ]sili|annul|termin|inactif|cl[oô]tur|archiv/i.test(t)) return true;
  if (/jours restants/i.test(t)) return false;
  if (/en attente/i.test(t)) return false;
  const dates = t.match(/\d{2}\/\d{2}\/\d{4}/g) || [];
  // Vente du jour déjà annulée : « vendu le 09/09/2026 09/09/2026 » sans durée restante.
  if (dates.length >= 2 && dates[dates.length - 2] === dates[dates.length - 1] && /vendu le/i.test(t)) {
    return true;
  }
  const endMs = labelEndDateMs(t);
  if (endMs != null && endMs < Date.now() - 86400000) return true;
  return false;
}

/** Leftover après résiliation : ne bloquer que les vrais abos encore en cours. */
function leftoverBlocksNewSale(contract) {
  const label = String(contract?.label || '');
  if (isStaleOrInactiveAbo(label)) return false;
  if (/jours restants/i.test(label) || /en attente/i.test(label)) return true;
  const endMs = labelEndDateMs(label);
  if (endMs != null) return endMs > Date.now();
  return true;
}

function parisDay(at = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(at);
}

/** Contrat vendu le jour J (Europe/Paris) — c’est la vente en cours, pas un leftover. */
function isSoldOnParisDay(label, day = parisDay()) {
  const m = String(label || '').match(/vendu le (\d{2})\/(\d{2})\/(\d{4})/i);
  if (!m) return false;
  return `${m[3]}-${m[2]}-${m[1]}` === day;
}

function pickKeepSaleId(classified = {}, orderSaleId = null) {
  if (orderSaleId && /^\d+$/.test(String(orderSaleId))) return String(orderSaleId);
  const started = classified.matchingStarted || [];
  if (started.length) return String(started[started.length - 1].idc);
  const today = parisDay();
  const pendingToday = (classified.matchingPending || []).filter((c) =>
    isSoldOnParisDay(c.label, today)
  );
  if (pendingToday.length) return String(pendingToday[pendingToday.length - 1].idc);
  return null;
}

function classifyMemberContracts(contracts = [], productConfig = {}, options = {}) {
  const isPending =
    typeof options.isPendingOrFuture === 'function'
      ? options.isPendingOrFuture
      : () => false;
  const abos = (contracts || []).filter(
    (c) => c && !c.isBadge && !isCartePrestationLabel(c.label) && !isStaleOrInactiveAbo(c.label)
  );
  const badges = (contracts || []).filter((c) => c && c.isBadge);

  const matchingStarted = abos.filter(
    (c) => saleContractMatches(c.label, productConfig) && !isPending(c.label)
  );
  const matchingPending = abos.filter(
    (c) => saleContractMatches(c.label, productConfig) && isPending(c.label)
  );
  const otherActive = abos.filter((c) => !saleContractMatches(c.label, productConfig));

  const keepId = options.keepSaleId ? String(options.keepSaleId) : '';
  const today = parisDay();
  const keepTodayIds = new Set(
    [...matchingStarted, ...matchingPending]
      .filter((c) => isSoldOnParisDay(c.label, today))
      .map((c) => String(c.idc))
  );
  if (keepId) keepTodayIds.add(keepId);

  const matchingToReplace = matchingStarted.filter((c) => !keepTodayIds.has(String(c.idc)));
  const pendingToCancel = matchingPending.filter((c) => !keepTodayIds.has(String(c.idc)));
  const toCancel = options.skipCancel
    ? []
    : [
        ...otherActive,
        ...pendingToCancel,
        ...(options.replaceExisting ? matchingToReplace : []),
      ];
  const keptMatch = keepId || options.replaceExisting
    ? matchingStarted.filter((c) => keepTodayIds.has(String(c.idc)))
    : matchingStarted;
  const keptPendingToday = matchingPending.filter((c) => keepTodayIds.has(String(c.idc)));

  return {
    matchingStarted,
    matchingPending,
    otherActive,
    badges,
    toCancel,
    needsNewSale: keptMatch.length === 0 && keptPendingToday.length === 0,
    needsBadge: badges.length === 0,
  };
}

function contractsToCancelBeforeNewAbo(contracts, productConfig, options = {}) {
  return classifyMemberContracts(contracts, productConfig, options).toCancel;
}

module.exports = {
  classifyMemberContracts,
  contractsToCancelBeforeNewAbo,
  isStaleOrInactiveAbo,
  leftoverBlocksNewSale,
  stripContractSummaryBanner,
  isSoldOnParisDay,
  pickKeepSaleId,
  parisDay,
};
