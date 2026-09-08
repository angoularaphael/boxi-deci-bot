'use strict';

const { isAventureOrder } = require('./aventure-policy');

const SIGNATURE_STEP = 7;

function identityFields(order = {}) {
  const short = order.customer_short || {};
  const full = order.customer_full || {};
  const cust = order.customer || {};
  return {
    first: full.first_name || short.first_name || cust.first_name,
    last: full.last_name || short.last_name || cust.last_name,
    birth: full.birthdate || short.birthdate || cust.birthdate,
  };
}

function aventureDossierReady(order = {}) {
  if (order.ready_for_dispatch || order.signature?.signed_at) return true;
  if (Number(order.step || 0) < SIGNATURE_STEP) return false;
  const { first, last, birth } = identityFields(order);
  return Boolean(first && last && birth);
}

function boutiqueSaleDispatchAllowed(order = {}) {
  if (order.signature?.signed_at || order.ready_for_dispatch) return true;
  if (isAventureOrder(order)) return aventureDossierReady(order);
  return false;
}

module.exports = {
  SIGNATURE_STEP,
  aventureDossierReady,
  boutiqueSaleDispatchAllowed,
};
