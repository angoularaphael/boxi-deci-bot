/** Textes légaux / information client — boutique Boxing Center */

const BADGE_FEE_AMOUNT = '34,99 €';

const BADGE_FEE_NOTICE =
  `En souscrivant un abonnement, votre badge d'accès (${BADGE_FEE_AMOUNT}) sera prélevé sur l'IBAN que vous indiquez dans un délai de 3 à 7 jours ouvrés, avant le début des prélèvements de votre abonnement. Le montant payé aujourd'hui par carte bancaire correspond à votre 1ère échéance d'abonnement.`;

function isAbonnementProduct(product) {
  if (!product) return false;
  if (product.sale_type === 'abonnement') return true;
  if (String(product.category || '').toLowerCase().includes('abonnement')) return true;
  if (/badge|decipass|essai|seance/i.test(String(product.name || ''))) return false;
  return false;
}

function getBadgeFeeNotice(product) {
  if (!isAbonnementProduct(product)) return null;
  return product.badge_fee_notice || BADGE_FEE_NOTICE;
}

module.exports = {
  BADGE_FEE_AMOUNT,
  BADGE_FEE_NOTICE,
  isAbonnementProduct,
  getBadgeFeeNotice,
};
