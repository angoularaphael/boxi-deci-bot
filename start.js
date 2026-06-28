#!/usr/bin/env node
/**
 * Point d'entrée BotHost / VPS — installe les deps et lance le bot Deciplus.
 * Usage: node start.js
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function run(cmd) {
  console.log(`> ${cmd}`);
  execSync(cmd, { stdio: 'inherit', cwd: __dirname });
}

if (!fs.existsSync(path.join(__dirname, 'node_modules'))) {
  run('npm install --omit=dev');
}

try {
  run('npx playwright install chromium');
} catch {
  console.warn('Playwright chromium — installation manuelle si besoin');
}

require('./bot/index.js');
