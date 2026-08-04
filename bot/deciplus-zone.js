const { randomDelay } = require('../lib/utils');
const { logInfo } = require('../lib/logger');

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function isChooseZoneScreen(page) {
  if (page.url().includes('choose-zone')) return true;
  const heading = page.locator('text=Choisissez un site').first();
  return (await heading.count()) > 0 && (await heading.isVisible().catch(() => false));
}

async function selectSiteInPicker(page, siteLabel) {
  // siteLabel vient de la commande (salle choisie). Pas de fallback Minimes ici :
  // si absent, on ne change pas de site pour éviter d'écraser le choix client.
  const label = String(siteLabel || '').trim();
  if (!label) {
    logInfo('Aucune salle fournie pour le picker Deciplus — site session inchangé');
    return false;
  }
  const pattern = new RegExp(escapeRegExp(label), 'i');
  logInfo('Sélection site Deciplus', { site: label });

  const customSelect = page.locator('.ari-select').first();
  if ((await customSelect.count()) > 0 && (await customSelect.isVisible().catch(() => false))) {
    await customSelect.click();
    await randomDelay(400, 800);
    const option = page.getByText(pattern).first();
    if ((await option.count()) > 0) {
      await option.click();
      await randomDelay(400, 800);
      return true;
    }
  }

  const nativeSelect = page.locator('select').first();
  if ((await nativeSelect.count()) > 0) {
    const ok = await nativeSelect.selectOption({ label }).then(() => true).catch(async () => {
      const options = nativeSelect.locator('option');
      const count = await options.count();
      for (let i = 0; i < count; i += 1) {
        const opt = options.nth(i);
        const text = ((await opt.textContent().catch(() => '')) || '').trim();
        if (!pattern.test(text)) continue;
        const value = await opt.getAttribute('value');
        if (value == null) continue;
        await nativeSelect.selectOption(value);
        return true;
      }
      return false;
    });
    await randomDelay(400, 800);
    return ok;
  }

  return false;
}

async function clickSellOnSite(page) {
  const sellBtn = page.getByRole('button', { name: /Vendre sur ce site/i }).first();
  if ((await sellBtn.count()) === 0) return false;
  await sellBtn.click({ force: true });
  await page.waitForURL(/vente|nextgen\/home|select\.php/, { timeout: 20000 }).catch(() => {});
  await randomDelay(800, 1500);
  return true;
}

/**
 * Deciplus nextgen — écran « Choisissez un site » (composant .ari-select).
 */
async function ensureDeciplusSaleZone(page, gymConfig = {}) {
  if (!(await isChooseZoneScreen(page))) return false;

  // Respecte la salle de la commande (gymConfig), jamais une salle hardcodée.
  const siteLabel = gymConfig.deciplus_label || gymConfig.label || '';
  if (!siteLabel) {
    logInfo('Écran zone Deciplus sans salle commande — pas de sélection forcée');
    return false;
  }
  logInfo('Sélection site Deciplus pour vente', { site: siteLabel, gym: gymConfig.key || null });

  const selected = await selectSiteInPicker(page, siteLabel);
  if (!selected) {
    logInfo('Échec sélection site vente', { site: siteLabel });
    return false;
  }
  await clickSellOnSite(page);
  return true;
}

module.exports = {
  isChooseZoneScreen,
  selectSiteInPicker,
  clickSellOnSite,
  ensureDeciplusSaleZone,
};
