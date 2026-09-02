'use strict';

const { logInfo, logWarn } = require('../lib/logger');
const { uniqueDeciplusSearchConfigs } = require('../lib/deciplus-sites');
const { getGymConfig } = require('../lib/normalize');
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

/**
 * Identité résil / changement d’abo : clubs Deciplus Boxing Center.
 * Club États-Unis inclus même si les inscriptions neuves se créent à Minimes.
 * Balma seulement si includeBalma.
 */
async function findMemberOnBoxingCenterGyms(page, identity, options = {}) {
  const sites = uniqueDeciplusSearchConfigs(options.preferredGym);
  if (options.includeBalma) {
    const balma = getGymConfig('balma');
    if (!sites.some((s) => String(s.deciplus_zone_id) === String(balma.deciplus_zone_id))) {
      sites.unshift(balma);
    }
  }
  let last = { found: false, reason: 'not_found', mismatch_fields: [] };
  for (const gym of sites) {
    const label = gym?.deciplus_label || gym?.label;
    const switched = await switchDeciplusSite(page, label).catch((err) => {
      logWarn('Site BC non ouvert pour vérif', { gym: gym.key, error: err.message });
      return false;
    });
    if (!switched) continue;
    const match = await findMemberByIdentity(page, identity, options);
    if (!match.found) {
      last = match;
      continue;
    }
    if (!options.includeBalma && (await memberZoneLooksBalma(page))) {
      logInfo('Fiche Balma ignorée (résil / changement)', { member_id: match.member_id, gym: gym.key });
      last = { found: false, reason: 'balma_skipped', member_id: match.member_id };
      continue;
    }
    logInfo('Fiche trouvée hors Balma', { member_id: match.member_id, gym: gym.key, site: label });
    return { ...match, gym: gym.key, gymConfig: gym };
  }
  return last;
}

module.exports = { findMemberOnBoxingCenterGyms, memberZoneLooksBalma };
