'use strict';

const { logInfo, logWarn } = require('../lib/logger');
const { uniqueDeciplusSearchConfigs } = require('../lib/deciplus-sites');
const { getGymConfig } = require('../lib/normalize');
const { resolveSearchGymSlug, balmaMigrationLookupAllowed } = require('../lib/gym-slugs');
const { switchDeciplusSite } = require('./deciplus-zone');
const { findMemberByIdentity } = require('./member');

async function memberZoneLooksBalma(page) {
  const balmaZone = String(getGymConfig('balma')?.deciplus_zone_id || '1');
  const scopes = [page, ...(page.frames?.() || [])];
  for (const ctx of scopes) {
    const val = await ctx
      .locator('form[name="db1_form"] select[name="idz"]')
      .first()
      .inputValue()
      .catch(() => '');
    if (val) return String(val) === balmaZone;
  }
  return false;
}

function allowBalmaLookup(options = {}) {
  return Boolean(options.allowBalmaLookup) && balmaMigrationLookupAllowed();
}

/**
 * Identité résil / changement d’abo : clubs Deciplus Boxing Center.
 * Balma exclu par défaut — lookup Balma réservé aux scripts ops (env + option).
 */
async function findMemberOnBoxingCenterGyms(page, identity, options = {}) {
  const preferred = resolveSearchGymSlug(options.preferredGym || 'minimes');
  const balmaLookup = allowBalmaLookup(options);
  const sites = uniqueDeciplusSearchConfigs(preferred, { allowBalmaLookup: balmaLookup });
  let last = { found: false, reason: 'not_found', mismatch_fields: [] };
  for (const gym of sites) {
    const label = gym?.deciplus_label || gym?.label;
    const switched = await switchDeciplusSite(page, label, {
      allowBalmaLookup: balmaLookup,
    }).catch((err) => {
      logWarn('Site BC non ouvert pour vérif', { gym: gym.key, error: err.message });
      return false;
    });
    if (!switched) continue;
    const match = await findMemberByIdentity(page, identity, options);
    if (!match.found) {
      last = match;
      continue;
    }
    if (!balmaLookup && (await memberZoneLooksBalma(page))) {
      logInfo('Fiche Balma ignorée (résil / changement)', { member_id: match.member_id, gym: gym.key });
      last = { found: false, reason: 'balma_skipped', member_id: match.member_id };
      continue;
    }
    logInfo('Fiche trouvée hors Balma', { member_id: match.member_id, gym: gym.key, site: label });
    return { ...match, gym: gym.key, gymConfig: gym };
  }
  return last;
}

module.exports = { findMemberOnBoxingCenterGyms, memberZoneLooksBalma, allowBalmaLookup };
