/**
 * Dépendances système Chromium sur hébergement sans root (Pterodactyl / BotHosting).
 * Télécharge les .deb et les extrait localement → LD_LIBRARY_PATH.
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DEB_PACKAGES = [
  'libatk1.0-0',
  'libatk-bridge2.0-0',
  'libatspi2.0-0',
  'libcups2',
  'libdrm2',
  'libxkbcommon0',
  'libxcomposite1',
  'libxdamage1',
  'libxfixes3',
  'libxrandr2',
  'libgbm1',
  'libpango-1.0-0',
  'libcairo2',
  'libasound2',
  'libnss3',
  'libnspr4',
  'libdbus-1-3',
  'libgtk-3-0',
  'libglib2.0-0',
  'libx11-6',
  'libxcb1',
  'libxext6',
  'libxi6',
  'libexpat1',
  'libfontconfig1',
  'libfreetype6',
  'libpixman-1-0',
  'libxrender1',
  'libgcc-s1',
  'libstdc++6',
];

function libDirs(baseDir) {
  const candidates = [
    path.join(baseDir, 'usr', 'lib', 'x86_64-linux-gnu'),
    path.join(baseDir, 'usr', 'lib'),
    path.join(baseDir, 'lib', 'x86_64-linux-gnu'),
    path.join(baseDir, 'lib'),
  ];
  return candidates.filter((dir) => fs.existsSync(dir));
}

function hasAtkLib(baseDir) {
  for (const dir of libDirs(baseDir)) {
    try {
      if (fs.readdirSync(dir).some((name) => /^libatk-1\.0\.so/.test(name))) {
        return true;
      }
    } catch {
      /* ignore */
    }
  }
  return false;
}

function applyLibraryPath(baseDir) {
  const paths = libDirs(baseDir);
  if (!paths.length) return false;
  const merged = [...new Set([...paths, process.env.LD_LIBRARY_PATH].filter(Boolean))].join(':');
  process.env.LD_LIBRARY_PATH = merged;
  return true;
}

function runQuiet(cmd, cwd) {
  execSync(cmd, { stdio: 'pipe', cwd, shell: true, env: process.env });
}

function tryPlaywrightInstallDeps(cwd) {
  try {
    execSync('npx playwright install-deps chromium-headless-shell', {
      stdio: 'inherit',
      cwd,
      shell: true,
      env: process.env,
    });
    return true;
  } catch {
    try {
      execSync('npx playwright install-deps chromium', {
        stdio: 'inherit',
        cwd,
        shell: true,
        env: process.env,
      });
      return true;
    } catch {
      return false;
    }
  }
}

function installChromiumSystemDeps({ baseDir, botDir, log = console.log } = {}) {
  const depsRoot = baseDir || path.join(process.cwd(), 'data', 'system-libs');
  fs.mkdirSync(depsRoot, { recursive: true });

  if (hasAtkLib(depsRoot)) {
    applyLibraryPath(depsRoot);
    log(`Deps Chromium OK (${depsRoot})`);
    return { ok: true, method: 'cached', path: depsRoot };
  }

  log('Installation deps Chromium (apt-get download, sans root)…');
  try {
    runQuiet('apt-get update -qq 2>/dev/null || true', depsRoot);
    runQuiet(`apt-get download -qq ${DEB_PACKAGES.join(' ')}`, depsRoot);
    runQuiet('for f in *.deb; do [ -f "$f" ] && dpkg-deb -x "$f" .; done', depsRoot);
  } catch (err) {
    log(`apt-get download échoué: ${err.message || err}`);
  }

  if (hasAtkLib(depsRoot)) {
    applyLibraryPath(depsRoot);
    log('Deps extraites → LD_LIBRARY_PATH configuré');
    return { ok: true, method: 'deb-extract', path: depsRoot };
  }

  log('Tentative playwright install-deps (root requis)…');
  if (botDir && tryPlaywrightInstallDeps(botDir)) {
    return { ok: true, method: 'playwright-install-deps' };
  }

  log('ATTENTION: libatk manquante — Chromium ne démarrera pas sur cet hébergeur');
  return { ok: false, path: depsRoot };
}

module.exports = {
  DEB_PACKAGES,
  installChromiumSystemDeps,
  applyLibraryPath,
  hasAtkLib,
};
