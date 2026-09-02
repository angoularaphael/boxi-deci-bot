'use strict';

const fs = require('fs');
const path = require('path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '..');
const BOT_DIR = path.join(ROOT, 'bot');

function requiredRelatives(src, fromFile) {
  const out = [];
  const re = /require\('(\.[^']+)'\)/g;
  let m;
  while ((m = re.exec(src))) {
    const spec = m[1];
    if (!spec.startsWith('./') && !spec.startsWith('../')) continue;
    const resolved = path.resolve(path.dirname(fromFile), spec);
    const candidates = [
      resolved,
      `${resolved}.js`,
      path.join(resolved, 'index.js'),
    ];
    out.push({ spec, candidates });
  }
  return out;
}

describe('modules requis par le bot', () => {
  it('tous les require locaux de bot/*.js existent sur disque', () => {
    const files = fs.readdirSync(BOT_DIR).filter((f) => f.endsWith('.js'));
    const missing = [];
    for (const file of files) {
      const abs = path.join(BOT_DIR, file);
      const src = fs.readFileSync(abs, 'utf8');
      for (const { spec, candidates } of requiredRelatives(src, abs)) {
        if (!spec.startsWith('../lib/')) continue;
        if (!candidates.some((c) => fs.existsSync(c))) {
          missing.push(`${file} → ${spec}`);
        }
      }
    }
    assert.deepEqual(missing, []);
  });

  it('charge deciplus-sites / balma sans MODULE_NOT_FOUND', () => {
    assert.equal(typeof require('../lib/deciplus-sites').createGymConfig, 'function');
    assert.equal(typeof require('../lib/balma').shouldGiftBadgeComptant, 'function');
    assert.equal(typeof require('../bot/search-bc-gyms').findMemberOnBoxingCenterGyms, 'function');
  });
});
