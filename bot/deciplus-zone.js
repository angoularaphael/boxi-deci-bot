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
  const label = siteLabel || process.env.DECIPLUS_DEFAULT_SITE || 'Minimes';
  const pattern = new RegExp(escapeRegExp(label), 'i');

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
    await nativeSelect.selectOption({ label }).catch(async () => {
      await nativeSelect.selectOption({ label: pattern }).catch(() => {});
    });
    await randomDelay(400, 800);
    return true;
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

  const siteLabel = gymConfig.deciplus_label || gymConfig.label || process.env.DECIPLUS_DEFAULT_SITE || 'Minimes';
  logInfo('Sélection site Deciplus pour vente', { site: siteLabel });

  await selectSiteInPicker(page, siteLabel);
  await clickSellOnSite(page);
  return true;
}

module.exports = {
  isChooseZoneScreen,
  selectSiteInPicker,
  clickSellOnSite,
  ensureDeciplusSaleZone,
};
