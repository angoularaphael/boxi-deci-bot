#!/usr/bin/env node
/**
 * Point d'entrée BotHost / VPS — installe les deps et lance le bot Deciplus.
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { installPlaywrightBrowser } = require('./lib/playwright-install');

function run(cmd) {
  console.log(`> ${cmd}`);
  execSync(cmd, { stdio: 'inherit', cwd: __dirname, env: process.env });
}

function moduleResolvable(name) {
  try {
    require.resolve(name, { paths: [__dirname] });
    return true;
  } catch {
    return false;
  }
}

/** Toujours s’assurer des deps critiques (même si node_modules existe déjà). */
function ensureRequiredDeps() {
  const required = ['dotenv', 'express', 'playwright', 'imapflow', 'mailparser'];
  const missing = required.filter((name) => !moduleResolvable(name));
  const nodeModules = path.join(__dirname, 'node_modules');

  if (!fs.existsSync(nodeModules) || missing.length) {
    if (missing.length) {
      console.log(`[BOXPLUS] Dépendances manquantes: ${missing.join(', ')} — npm install…`);
    }
    run('npm install --omit=dev --ignore-scripts');
  }

  const stillMissing = required.filter((name) => !moduleResolvable(name));
  if (stillMissing.length) {
    console.error(
      `[BOXPLUS] Impossible d’installer: ${stillMissing.join(', ')}. Vérifier package.json / réseau.`
    );
    process.exit(1);
  }
  console.log('[BOXPLUS] Dépendances OK (dont imapflow + mailparser pour code email Deciplus)');
}

ensureRequiredDeps();

try {
  installPlaywrightBrowser();
} catch (err) {
  console.error('[BOXPLUS]', err.message);
  process.exit(1);
}

require('./bot/index.js');
