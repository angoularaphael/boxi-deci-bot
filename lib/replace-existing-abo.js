'use strict';

const { saleContractMatches } = require('./sale-contract-match');

function isCartePrestationLabel(label) {
  return /s[eé]ance d['’]?essai|coaching\s*priv/i.test(String(label || ''));
}

/**
 * Quand un client paie un nouvel abo alors qu’il en a déjà un (44,99, 259, saison…),
 * on résilie l’ancien (et un 29 € encore « en attente ») puis on vend le nouveau.
 * `replaceExisting` : résilie aussi un contrat déjà démarré du même produit
 * (sauf `keepSaleId`, la vente qu’on vient de poser).
 */
function classifyMemberContracts(contracts = [], productConfig = {}, options = {}) {
  const isPending =
    typeof options.isPendingOrFuture === 'function'
      ? options.isPendingOrFuture
      : () => false;
  const abos = (contracts || []).filter(
    (c) => c && !c.isBadge && !isCartePrestationLabel(c.label)
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
  const matchingToReplace = matchingStarted.filter((c) => String(c.idc) !== keepId);
  const toCancel = options.skipCancel
    ? []
    : [
        ...otherActive,
        ...matchingPending,
        ...(options.replaceExisting ? matchingToReplace : []),
      ];
  const keptMatch = keepId
    ? matchingStarted.filter((c) => String(c.idc) === keepId)
    : options.replaceExisting
      ? []
      : matchingStarted;

  return {
    matchingStarted,
    matchingPending,
    otherActive,
    badges,
    toCancel,
    needsNewSale: keptMatch.length === 0,
    needsBadge: badges.length === 0,
  };
}

function contractsToCancelBeforeNewAbo(contracts, productConfig, options = {}) {
  return classifyMemberContracts(contracts, productConfig, options).toCancel;
}

module.exports = {
  classifyMemberContracts,
  contractsToCancelBeforeNewAbo,
};
