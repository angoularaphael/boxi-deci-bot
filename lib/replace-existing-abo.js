'use strict';

const { saleContractMatches } = require('./sale-contract-match');

function isCartePrestationLabel(label) {
  return /s[eé]ance d['’]?essai|coaching\s*priv/i.test(String(label || ''));
}

/**
 * Quand un client paie un nouvel abo alors qu’il en a déjà un (44,99, 259, saison…),
 * on résilie l’ancien (et un 29 € encore « en attente ») puis on vend le nouveau.
 * On ne touche pas un contrat déjà démarré du même produit, ni le Badge, ni un essai.
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

  const toCancel = options.skipCancel ? [] : [...otherActive, ...matchingPending];

  return {
    matchingStarted,
    matchingPending,
    otherActive,
    badges,
    toCancel,
    needsNewSale: matchingStarted.length === 0,
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
