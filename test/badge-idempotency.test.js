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

test('un badge à 0 crédit encore affiché reste un badge ouvert', () => {
  assert.equal(
    isActiveBadgeContract({
      isBadge: true,
      label: 'BADGE 0 crédit restant',
    }),
    true
  );
});

test('ignore uniquement les badges expirés ou résiliés', () => {
  assert.equal(
    isActiveBadgeContract({
      isBadge: true,
      label: 'BADGE Expiré - 0 crédit restant',
    }),
    false
  );
});

test('un badge sans abonnement actif est refusé', () => {
  const {
    isActiveMembershipContract,
    memberHasActiveMembership,
  } = require('../bot/sale');
  assert.equal(
    isActiveMembershipContract({
      isBadge: false,
      label: 'OFFRE A 29€ CONTRAT N°C2026-043124',
    }),
    true
  );
  assert.equal(
    isActiveMembershipContract({
      isBadge: false,
      label: "SEANCE D'ESSAI CONTRAT N°C2026-042873 Expiré",
    }),
    false
  );
  assert.equal(
    memberHasActiveMembership([
      { isBadge: true, label: 'BADGE CONTRAT N°C2026-043144' },
    ]),
    false
  );
  const src = require('fs').readFileSync(require('path').join(__dirname, '../bot/sale.js'), 'utf8');
  assert.match(src, /Vente Badge refusée — aucun abonnement actif/);
  assert.match(src, /le badge payé conservé n’est pas recréé/);
  assert.match(src, /keepOne\) \{\s*keeper = active\[0\]/);
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
