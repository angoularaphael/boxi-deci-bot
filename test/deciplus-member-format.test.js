'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  phoneForDeciplus,
  expandDeciplusUrl,
  extractMemberIdFromUrl,
  isNewMemberUrl,
  nameForDeciplusSearch,
  namesMatch,
} = require('../lib/deciplus-member-format');

describe('phoneForDeciplus', () => {
  it('garde un mobile FR classique', () => {
    assert.equal(phoneForDeciplus('06 12 34 56 78'), '0612345678');
  });

  it('normalise +33', () => {
    assert.equal(phoneForDeciplus('+33612345678'), '0612345678');
  });

  it('corrige saisie 11 chiffres sans 0 (cas nowa)', () => {
    assert.equal(phoneForDeciplus('76233478493'), '0762334784');
  });

  it('ajoute 0 si 9 chiffres', () => {
    assert.equal(phoneForDeciplus('612345678'), '0612345678');
  });
});

describe('extractMemberIdFromUrl / legacy nextgen', () => {
  it('extrait idj depuis check.php', () => {
    assert.equal(
      extractMemberIdFromUrl('https://boxingcenter.deciplus.pro/check.php?idj=21013'),
      '21013'
    );
  });

  it('extrait idj depuis nextgen/legacy?path=', () => {
    const url =
      'https://boxingcenter.deciplus.pro/nextgen/legacy?path=%2Fcheck.php%3Fidj%3D21013';
    assert.equal(extractMemberIdFromUrl(url), '21013');
  });

  it('détecte idj=new encodé (bug Valider vs Mettre à jour)', () => {
    const url =
      'https://boxingcenter.deciplus.pro/nextgen/legacy?path=%2Fjoueurs.php%3Fidj%3Dnew';
    assert.equal(isNewMemberUrl(url), true);
    assert.equal(extractMemberIdFromUrl(url), null);
  });

  it('select.php sans id → pas de faux positif', () => {
    assert.equal(
      extractMemberIdFromUrl(
        'https://boxingcenter.deciplus.pro/nextgen/legacy?path=%2Fselect.php'
      ),
      null
    );
  });

  it('expand décode le path', () => {
    const expanded = expandDeciplusUrl(
      'https://boxingcenter.deciplus.pro/nextgen/legacy?path=%2Fjoueurs.php%3Fidj%3Dnew'
    );
    assert.match(expanded, /idj=new/);
  });
});

describe('recherche nom Deciplus (casse)', () => {
  it('passe Test/test en TEST pour la saisie Deciplus', () => {
    assert.equal(nameForDeciplusSearch('Test'), 'TEST');
    assert.equal(nameForDeciplusSearch('  test  '), 'TEST');
  });

  it('compare sans tenir compte de la casse ni des accents', () => {
    assert.equal(namesMatch('TEST', 'Test'), true);
    assert.equal(namesMatch('François', 'FRANCOIS'), true);
    assert.equal(namesMatch('TEST', 'TSET'), false);
  });

  it('compare les emails sans casse et ignore le mail PSP Aventure', () => {
    const { emailsMatch, isSearchableMemberEmail } = require('../lib/deciplus-member-format');
    assert.equal(emailsMatch('Lea@Test.local', 'lea@test.local'), true);
    assert.equal(emailsMatch('lea@test.local', 'autre@test.local'), false);
    assert.equal(isSearchableMemberEmail('lea@test.local'), 'lea@test.local');
    assert.equal(isSearchableMemberEmail('aventure.bc-99@boxplus-test.local'), '');
    assert.equal(isSearchableMemberEmail('dup48668.balma@boxingcenter-test.fr'), 'dup48668.balma@boxingcenter-test.fr');
  });
});

describe('memberSearchHitMatches — pas de réutilisation sur email de couple', () => {
  const { memberSearchHitMatches } = require('../lib/deciplus-member-format');

  const nassim = {
    last_name: 'Derdour',
    first_name: 'Nassim',
    email: 'derdour.nassim813@gmail.com',
    phone: '0766675935',
    birthdate: '1999-02-20',
  };
  const inesForm = {
    lastName: 'YOUSFI',
    firstName: 'INES',
    email: 'derdour.nassim813@gmail.com',
    phone: '0766675935',
    birth: '13/12/1999',
    fromMemberForm: true,
  };

  it('refuse la fiche Inès Yousfi pour Nassim Derdour (même mail)', () => {
    assert.equal(memberSearchHitMatches(inesForm, nassim), false);
  });

  it('refuse un hit email si les noms de la fiche sont illisibles', () => {
    assert.equal(
      memberSearchHitMatches(
        { lastName: '', firstName: '', email: nassim.email, fromMemberForm: true },
        nassim
      ),
      false
    );
  });

  it('accepte la même personne (noms + mail)', () => {
    assert.equal(
      memberSearchHitMatches(
        {
          lastName: 'DERDOUR',
          firstName: 'Nassim',
          email: nassim.email,
          birth: '20/02/1999',
          fromMemberForm: true,
        },
        nassim
      ),
      true
    );
  });
});
