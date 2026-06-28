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

if (!fs.existsSync(path.join(__dirname, 'node_modules'))) {
  run('npm install --omit=dev --ignore-scripts');
}

try {
  installPlaywrightBrowser();
} catch (err) {
  console.error('[BOXPLUS]', err.message);
  process.exit(1);
}

require('./bot/index.js');
