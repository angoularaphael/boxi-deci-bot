'use strict';

/**
 * Empêche un push BotHosting où un `const { foo } = require(...)` n’exporte pas foo.
 * Ça aurait bloqué `switchDeciplusSite is not a function`.
 */
const fs = require('fs');
const path = require('path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '..');
const SCAN_DIRS = ['bot', 'lib'].map((d) => path.join(ROOT, d));
const SKIP_LOAD = new Set(['index.js']);
const SKIP_SCAN = /test-cleanup\.js$/i;
const OPTIONAL_SPECS = /^\.\.\/storefront\//;

function jsFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.js'))
    .map((f) => path.join(dir, f));
}

function parseDestructuredRequires(src) {
  const out = [];
  const re = /(?:const|let|var)\s*\{([^}]+)\}\s*=\s*require\((['"])(\.[^'"]+)\2\)/g;
  let m;
  while ((m = re.exec(src))) {
    const names = m[1]
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => part.split(/\s+as\s+|:/)[0].trim())
      .filter((name) => name && name !== '...');
    out.push({ names, spec: m[3] });
  }
  return out;
}

describe('exports requis par le bot', () => {
  it('chaque nom destructuré existe sur le module requis', () => {
    const missing = [];
    for (const dir of SCAN_DIRS) {
      for (const file of jsFiles(dir)) {
        if (SKIP_SCAN.test(file)) continue;
        const src = fs.readFileSync(file, 'utf8');
        for (const { names, spec } of parseDestructuredRequires(src)) {
          let resolved;
          try {
            resolved = require.resolve(spec, { paths: [path.dirname(file)] });
          } catch (err) {
            if (OPTIONAL_SPECS.test(spec)) continue;
            missing.push(`${path.relative(ROOT, file)} → ${spec} (fichier absent: ${err.code || err.message})`);
            continue;
          }
          const base = path.basename(resolved);
          if (SKIP_LOAD.has(base)) continue;
          let mod;
          try {
            mod = require(resolved);
          } catch (err) {
            missing.push(`${path.relative(ROOT, file)} → ${spec} (${err.message})`);
            continue;
          }
          for (const name of names) {
            if (mod == null || mod[name] === undefined) {
              missing.push(
                `${path.relative(ROOT, file)} → ${spec}.${name} (${typeof mod?.[name]})`
              );
            }
          }
        }
      }
    }
    assert.deepEqual(missing, []);
  });

  it('bot/index.js charge ses require de tête (sans lancer la boucle)', () => {
    const idx = require('../bot/index.js');
    assert.equal(typeof idx.processSaleJob, 'function');
  });

  it('les fonctions qui ont planté en prod existent', () => {
    assert.equal(typeof require('../bot/deciplus-zone').switchDeciplusSite, 'function');
    assert.equal(typeof require('../lib/info-compta-note').buildSeanceOfferteInfoComptaNote, 'function');
    assert.equal(typeof require('../lib/info-compta-note').applySeanceOfferteCustomerDefaults, 'function');
    assert.equal(typeof require('../lib/deciplus-sites').createGymConfig, 'function');
  });
});
