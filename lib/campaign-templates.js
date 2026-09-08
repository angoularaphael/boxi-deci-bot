const AVENTURE_URL = 'https://aventure.boxingcenter.fr';
const BALMA_WA = require('./balma-wa-14.json');

function fill(template, { prenom, lien } = {}) {
  return String(template || '')
    .replace(/\{prenom\}/g, String(prenom || '').trim() || 'toi')
    .replace(/\{lien\}/g, lien || AVENTURE_URL);
}

module.exports = { AVENTURE_URL, BALMA_WA, fill };
