'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeOrder, validateOrder, getJobId } = require('../lib/normalize');

function isCoachAccessAction(action) {
  return ['coach_grant', 'coach_revoke', 'coach_revoke_coach', 'grant', 'revoke', 'revoke_coach'].includes(
    String(action || '').toLowerCase()
  );
}

test('coach_grant se normalise depuis grant + club_id', () => {
  const order = normalizeOrder({
    action: 'grant',
    order_id: 'resa-1',
    club_id: 'minimes',
    customer: { first_name: 'Lea', last_name: 'Martin', email: 'lea@example.com', birth_date: '1990-01-02' },
    qr_valid_from: '2026-09-22T10:55:00+02:00',
    qr_valid_to: '2026-09-22T12:00:00+02:00',
  });
  assert.equal(order.action, 'coach_grant');
  assert.equal(order.gym, 'minimes');
  assert.equal(order.customer.birthdate, '1990-01-02');
  assert.equal(getJobId(order), 'resa-1#coach_grant');
  assert.deepEqual(validateOrder(order), []);
  assert.equal(isCoachAccessAction(order.action), true);
});

test('coach_revoke accepte un member_id seul', () => {
  const order = normalizeOrder({
    action: 'coach_revoke',
    order_id: 'resa-1',
    gym: 'portet',
    deciplus_member_id: '22102',
  });
  assert.equal(order.action, 'coach_revoke');
  assert.deepEqual(validateOrder(order), []);
});
