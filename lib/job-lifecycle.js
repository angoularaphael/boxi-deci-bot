'use strict';

const STATES = Object.freeze({
  PAID: 'PAID',
  DOSSIER_COMPLETE: 'DOSSIER_COMPLETE',
  SIGNED: 'SIGNED',
  MEMBER_CREATED: 'MEMBER_CREATED',
  MANDATE_SET: 'MANDATE_SET',
  SALE_CREATED: 'SALE_CREATED',
  VERIFIED: 'VERIFIED',
  MANUAL_REVIEW: 'MANUAL_REVIEW',
  FAILED: 'FAILED',
});

const FORWARD = [
  STATES.PAID,
  STATES.DOSSIER_COMPLETE,
  STATES.SIGNED,
  STATES.MEMBER_CREATED,
  STATES.MANDATE_SET,
  STATES.SALE_CREATED,
  STATES.VERIFIED,
];

function canTransition(from, to) {
  if (!to || !Object.values(STATES).includes(to)) return false;
  if (!from) return to === STATES.PAID || to === STATES.MANUAL_REVIEW || to === STATES.FAILED;
  if (from === to) return true;
  if (to === STATES.MANUAL_REVIEW || to === STATES.FAILED) return true;
  if (from === STATES.MANUAL_REVIEW || from === STATES.FAILED) {
    return to === STATES.PAID || to === STATES.DOSSIER_COMPLETE || to === STATES.SIGNED;
  }
  return FORWARD.indexOf(to) === FORWARD.indexOf(from) + 1;
}

function deriveState(order = {}) {
  const persisted = order.reliability?.state;
  if (persisted && Object.values(STATES).includes(persisted)) return persisted;
  if (order.deciplus_sale_id) return STATES.SALE_CREATED;
  if (order.deciplus_member_id) return STATES.MEMBER_CREATED;
  if (order.signature?.signed_at || order.ready_for_dispatch) return STATES.SIGNED;
  if (Number(order.step || 0) >= 7) return STATES.DOSSIER_COMPLETE;
  if (String(order.payment?.status || '').toLowerCase() === 'paid') return STATES.PAID;
  return null;
}

function transitionOrder(order, to, details = {}) {
  const from = deriveState(order);
  if (!canTransition(from, to)) {
    const err = new Error(`Transition lifecycle interdite: ${from || 'NONE'} -> ${to}`);
    err.code = 'INVALID_LIFECYCLE_TRANSITION';
    err.from = from;
    err.to = to;
    throw err;
  }
  const at = details.at || new Date().toISOString();
  const previous = Array.isArray(order.reliability?.history) ? order.reliability.history : [];
  order.reliability = {
    ...(order.reliability || {}),
    state: to,
    updated_at: at,
    reason: details.reason || null,
    action_required: details.action_required || null,
    history: [...previous.slice(-19), { from, to, at, reason: details.reason || null }],
  };
  return order;
}

function advanceOrder(order, to, details = {}) {
  const target = FORWARD.indexOf(to);
  if (target < 0) return transitionOrder(order, to, details);
  let current = FORWARD.indexOf(deriveState(order));
  if (current === target && order.reliability?.state !== to) {
    return transitionOrder(order, to, details);
  }
  if (current > target && !order.reliability?.state) {
    return transitionOrder(order, FORWARD[current], details);
  }
  while (current < target) {
    transitionOrder(order, FORWARD[current + 1], current + 1 === target ? details : {});
    current += 1;
  }
  return order;
}

function isMemberOrSaleEligible(order = {}) {
  return Boolean(order.signature?.signed_at || order.ready_for_dispatch) &&
    [STATES.SIGNED, STATES.MEMBER_CREATED, STATES.MANDATE_SET, STATES.SALE_CREATED, STATES.VERIFIED]
      .includes(deriveState(order));
}

module.exports = {
  STATES,
  FORWARD,
  canTransition,
  deriveState,
  transitionOrder,
  advanceOrder,
  isMemberOrSaleEligible,
};
