/** Textes légaux / information client — boutique Boxing Center */

const BADGE_FEE_AMOUNT = '34,99 €';

const BADGE_FEE_NOTICE =
  `En souscrivant un abonnement, votre badge d'accès (${BADGE_FEE_AMOUNT}) sera prélevé sur l'IBAN que vous indiquez dans un délai de 5 à 7 jours ouvrés après votre achat. Le montant payé aujourd'hui par carte bancaire correspond à votre 1ère échéance d'abonnement.`;

function isStorefrontProduct(product) {
  if (!product) return false;
  const name = String(product.name || product.title || '').trim();
  const type = product.type || product.categoryId || '';
  if (product.id === 'badge' || product.id === 'seance-essai' || product.manual) return false;
  if (type === 'decipass' || /decipass/i.test(String(product.category || ''))) return false;
  if (/^badge$/i.test(name)) return false;
  if (/essai/i.test(name) && (product.price_cents === 0 || product.requires_payment === false)) return false;
  return true;
}

function shouldShowBadgeFeeNotice(product) {
  if (!product?.requires_iban) return false;
  if (product.sale_type === 'abonnement') return true;
  return String(product.category || '').toLowerCase().includes('abonnement');
}

function getBadgeFeeNotice(product) {
  if (!shouldShowBadgeFeeNotice(product)) return null;
  return product.badge_fee_notice || BADGE_FEE_NOTICE;
}

module.exports = {
  BADGE_FEE_AMOUNT,
  BADGE_FEE_NOTICE,
  isStorefrontProduct,
  shouldShowBadgeFeeNotice,
  getBadgeFeeNotice,
};
