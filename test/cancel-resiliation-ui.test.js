'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const {
  clickActionTile,
  selectResiliationMotif,
  clickAppliquerEtQuitter,
  confirmResiliationModal,
  clickResilierEtEnvoyerMail,
  waitAppliquerEnabled,
} = require('../bot/cancel-sale');

function resiliationFormHtml() {
  return `<!doctype html>
<html><body>
  <div class="el-form-item">
    <label>Motif de résiliation</label>
    <div class="el-select">
      <input class="el-input__inner" id="motifInput" value="Choisir" readonly />
    </div>
  </div>
  <p id="decoy">Ne souhaite pas reconduire est cité dans l'aide, ce n'est pas l'option.</p>
  <ul class="el-select-dropdown" id="menu" style="display:none">
    <li class="el-select-dropdown__item" id="opt">Ne souhaite pas reconduire</li>
  </ul>
  <button id="apply" class="is-disabled" disabled>Appliquer et Quitter</button>
  <div id="dialog" hidden>
    <p>Êtes-vous certain de confirmer la résiliation ?</p>
    <label><input type="checkbox" /> Envoyer un mail de résiliation</label>
    <button type="button" id="confirm">Confirmer</button>
  </div>
  <button type="button" id="mail" hidden>Résilier le contrat et envoyer le mail</button>
  <button type="button" id="stray">OK</button>
  <script>
    document.querySelector('.el-select').addEventListener('click', () => {
      document.getElementById('menu').style.display = 'block';
    });
    document.getElementById('opt').addEventListener('click', () => {
      document.getElementById('motifInput').value = 'Ne souhaite pas reconduire';
      document.getElementById('menu').style.display = 'none';
      const apply = document.getElementById('apply');
      apply.disabled = false;
      apply.classList.remove('is-disabled');
    });
    document.getElementById('decoy').addEventListener('click', () => {
      document.getElementById('decoy').dataset.clicked = '1';
    });
    document.getElementById('apply').addEventListener('click', () => {
      const apply = document.getElementById('apply');
      if (apply.disabled) return;
      apply.dataset.clicked = '1';
      document.getElementById('dialog').hidden = false;
    });
    document.getElementById('confirm').addEventListener('click', () => {
      document.getElementById('confirm').dataset.clicked = '1';
      document.getElementById('dialog').hidden = true;
      document.getElementById('mail').hidden = false;
    });
    document.getElementById('stray').addEventListener('click', () => {
      document.getElementById('stray').dataset.clicked = '1';
    });
    document.getElementById('mail').addEventListener('click', () => {
      document.getElementById('mail').dataset.clicked = '1';
    });
  </script>
</body></html>`;
}

function tilesHtml() {
  return `<!doctype html>
<html><body>
  <p>Action souhaitée</p>
  <div class="tile" id="card" style="width:220px;height:72px">
    <span id="resil">Résilier le contrat</span>
    <small>À la date choisie</small>
  </div>
  <div id="void" style="width:180px;height:48px">Annuler la vente</div>
  <script>
    document.getElementById('resil').addEventListener('click', () => {
      document.getElementById('resil').dataset.clicked = '1';
    });
    document.getElementById('void').addEventListener('click', () => {
      document.getElementById('void').dataset.clicked = '1';
    });
  </script>
</body></html>`;
}

async function withPage(html, fn) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(html);
    return await fn(page);
  } finally {
    await browser.close();
  }
}

test('le texte d’aide ne sélectionne pas le motif ; l’option oui', async () => {
  await withPage(resiliationFormHtml(), async (page) => {
    const ok = await selectResiliationMotif(page);
    assert.equal(ok, true);
    assert.equal(await page.locator('#motifInput').inputValue(), 'Ne souhaite pas reconduire');
    assert.equal(await page.locator('#decoy').getAttribute('data-clicked'), null);
    assert.equal(await waitAppliquerEnabled(page, 2000), true);
  });
});

test('parcours complet : Appliquer actif, Confirmer, puis mail', async () => {
  await withPage(resiliationFormHtml(), async (page) => {
    assert.equal(await selectResiliationMotif(page), true);
    assert.equal(await clickAppliquerEtQuitter(page, { timeoutMs: 3000 }), true);
    assert.equal(await page.locator('#apply').getAttribute('data-clicked'), '1');
    assert.equal(await confirmResiliationModal(page, { timeoutMs: 3000 }), true);
    assert.equal(await page.locator('#confirm').getAttribute('data-clicked'), '1');
    assert.equal(await page.locator('#stray').getAttribute('data-clicked'), null);
    assert.equal(await clickResilierEtEnvoyerMail(page, { timeoutMs: 3000 }), true);
    assert.equal(await page.locator('#mail').getAttribute('data-clicked'), '1');
  });
});

test('Appliquer désactivé n’est pas cliqué, et OK hors modale n’est pas une confirmation', async () => {
  await withPage(resiliationFormHtml(), async (page) => {
    assert.equal(await clickAppliquerEtQuitter(page, { timeoutMs: 1200 }), false);
    assert.equal(await page.locator('#apply').getAttribute('data-clicked'), null);
    assert.equal(await page.locator('#apply').isDisabled(), true);
    assert.equal(await confirmResiliationModal(page, { timeoutMs: 1200 }), false);
    assert.equal(await page.locator('#stray').getAttribute('data-clicked'), null);
    assert.equal(await page.locator('#confirm').getAttribute('data-clicked'), null);
  });
});

test('la tuile « Résilier le contrat » est cliquée, pas « Annuler la vente »', async () => {
  await withPage(tilesHtml(), async (page) => {
    const hit = await clickActionTile(page, [/^Résilier$/i, /^Résiliation$/i]);
    assert.equal(hit, 'Résilier le contrat');
    assert.equal(await page.locator('#resil').getAttribute('data-clicked'), '1');
    assert.equal(await page.locator('#void').getAttribute('data-clicked'), null);
  });
});
