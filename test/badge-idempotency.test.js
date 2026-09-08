'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isActiveBadgeContract } = require('../bot/sale');

test('reconnaît un badge actif avant tout nouvel achat', () => {
  assert.equal(
    isActiveBadgeContract({
      isBadge: true,
      label: 'BADGE CONTRAT N°C2026-043597 1 crédit restant',
    }),
    true
  );
});

test('un badge pré-décompté à zéro crédit reste actif', () => {
  assert.equal(
    isActiveBadgeContract({
      isBadge: true,
      label: 'BADGE 0 crédit restant 0 Pré-décomptée',
    }),
    true
  );
});

test('ignore les badges expirés ou réellement épuisés', () => {
  assert.equal(
    isActiveBadgeContract({
      isBadge: true,
      label: 'BADGE Expiré - 0 crédit restant',
    }),
    false
  );
  assert.equal(
    isActiveBadgeContract({
      isBadge: true,
      label: 'BADGE 0 crédit restant',
    }),
    false
  );
});

test('ne confond pas un abonnement avec un badge', () => {
  assert.equal(
    isActiveBadgeContract({
      isBadge: false,
      label: 'OFFRE DUO 29€ 335 jours restants',
    }),
    false
  );
});
