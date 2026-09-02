'use strict';

function normalizeLabel(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function productNeedles(product = {}) {
  return [
    product.deciplus_product_name,
    product.deciplus_product_search,
    product.label,
    product.name,
    product.title,
    product.display_name,
  ]
    .filter(Boolean)
    .map(normalizeLabel);
}

function isAnnualPromoProduct(product = {}) {
  const hay = productNeedles(product).join(' ');
  return /offre promo|12\s*mois|12mois|\b259\b/.test(hay);
}

function isOffre29Product(product = {}) {
  const hay = [
    ...productNeedles(product),
    product.id,
    product.product_id,
    product.deciplus_id,
  ]
    .filter(Boolean)
    .join(' ');
  return /offre\s*a\s*29|offre\s*duo|offre-duo|offre_29|dp-104|\b29[,.]?99\b/.test(hay);
}

function isMonthlyFlexProduct(product = {}) {
  if (isOffre29Product(product) || isAnnualPromoProduct(product)) return false;
  const hay = productNeedles(product).join(' ');
  return /44,?99|4 semaines|sans engagement/.test(hay);
}

/**
 * Un contrat Deciplus déjà présent (ex. 44,99 € / 4 semaines) ne doit pas
 * valider une vente 259 € / 12 mois — et inversement.
 * OFFRE A 29€ (boutique) = OFFRE DUO 29€ (Deciplus) — pas l’ancien 44,99 résilié.
 */
function saleContractMatches(contractLabel, product = {}) {
  const label = normalizeLabel(contractLabel);
  if (!label) return false;
  if (/resilie|annule|termine|inactif|clotur|archiv/.test(label)) return false;

  if (isOffre29Product(product)) {
    if (/44,?99/.test(label) && !/\b29\b/.test(label)) return false;
    if (/offre promo|12\s*mois|12mois|\b259\b/.test(label) && !/\b29\b/.test(label)) return false;
    return /offre\s*(a|duo)\s*29|\b29[,.]?0{0,2}\s*€|\b29[,.]?99/.test(label);
  }

  if (isAnnualPromoProduct(product)) {
    if (/44,?99|4 semaines|sans engagement/.test(label) && !/12\s*mois|12mois|offre promo|\b259\b/.test(label)) {
      return false;
    }
    if (product.paiement_comptant === true && /4\s*[x×]|4 fois/.test(label)) {
      return false;
    }
    return /offre promo|12\s*mois|12mois|\b259\b/.test(label);
  }

  if (isMonthlyFlexProduct(product)) {
    return /44,?99|4 semaines|sans engagement/.test(label);
  }

  const needles = productNeedles(product).filter((n) => n.length >= 6);
  if (!needles.length) return !/\bbadge\b/.test(label);
  return needles.some((n) => label.includes(n.slice(0, Math.min(18, n.length))));
}

module.exports = {
  normalizeLabel,
  saleContractMatches,
  isAnnualPromoProduct,
  isMonthlyFlexProduct,
  isOffre29Product,
};
