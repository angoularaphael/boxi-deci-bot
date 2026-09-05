'use strict';

const { resolvePrestationHint } = require('./catalog-sale');
const { shouldGiftBadgeComptant } = require('./balma');
const {
  isComptantStyleProduct,
  isChildOfferProduct,
  isPayplug4xPrelevementOrder,
  productNeedsAutoBadge,
  productSupportsBillingChoice,
  paymentPeriodLabel,
} = require('./billing-plan');

const GYM_LABELS = {
  minimes: 'Minimes',
  ramonville: 'Ramonville',
  portet: 'Portet',
  'etats-unis': 'États-Unis',
  'st-cyprien': 'Saint-Cyprien',
  balma: 'Balma',
};

function gymLabel(slug) {
  if (!slug) return '';
  return GYM_LABELS[slug] || String(slug);
}

function isPortetOrder(order = {}) {
  const gym = order.customer_full?.gym || order.gym || order.pickup_gym || order.customer?.gym || '';
  return /portet/i.test(String(gym));
}

function idsOf(product = {}, order = {}) {
  return [product.id, product.product_id, product.legacy_id, order.product_id]
    .filter(Boolean)
    .map((v) => String(v).toLowerCase());
}

function productTitle(product = {}) {
  return String(product.display_name || product.name || product.product_name || '').trim();
}

function prestationHint(product = {}, order = {}) {
  return resolvePrestationHint({
    product_id: product.id || product.product_id || order.product_id,
    product_name: productTitle(product) || order.product_name,
    sale_type: product.sale_type || order.sale_type,
  });
}

function durationBit(product = {}) {
  const text = `${productTitle(product)} ${product.duration_label || ''}`;
  const week = /4\s*semaines/i.test(text);
  if (week) return '4 semaines';
  const m = text.match(/(\d+)\s*mois/i);
  if (m) return `${m[1]} mois`;
  if (product.duration_label) return String(product.duration_label).replace(/^\/\s*/, '');
  return '';
}

function isOffre29(product, order) {
  const ids = idsOf(product, order);
  if (ids.some((id) => id === 'offre-duo' || id === 'offre_29' || id === 'dp-104')) return true;
  return /29[,.]?99|offre\s*duo/i.test(productTitle(product));
}

function isOffre259(product, order) {
  const ids = idsOf(product, order);
  if (ids.some((id) => id === 'offre-saison' || id === 'offre_259' || id === 'dp-100')) return true;
  return /OFFRE\s*PROMO\s*12\s*MOIS|259\s*€/i.test(productTitle(product));
}

/**
 * Kind used to personalize invoice + contract copy.
 * prestation = coaching / essai (not a membership)
 */
function offerKind(product = {}, order = {}) {
  const hint = prestationHint(product, order);
  if (hint?.id === 'seance-essai') return 'essai';
  if (hint?.id === 'coaching-1') return 'coaching-1';
  if (hint?.id === 'coaching-5') return 'coaching-5';
  if (hint?.id === 'coaching-10') return 'coaching-10';
  if (hint) return hint.id.startsWith('coaching') ? 'coaching-1' : 'essai';

  if (isChildOfferProduct(product)) {
    const title = productTitle(product);
    if (/BABY\s*BOXE/i.test(title) || idsOf(product, order).some((id) => id === 'baby-boxe' || id === 'dp-93')) {
      return 'baby-boxe';
    }
    return 'boxe-educative';
  }
  if (isPayplug4xPrelevementOrder(order)) return 'abo-prelevement';
  if (isOffre29(product, order)) return 'abo-prelevement';
  if (isOffre259(product, order) || isComptantStyleProduct(product)) return 'abo-comptant';
  if (productSupportsBillingChoice(product) || product.requires_iban) return 'abo-prelevement';
  return 'abo';
}

function isPrestationKind(kind) {
  return kind === 'essai' || String(kind || '').startsWith('coaching');
}

function documentTypeLabel(product, { billingPlan, order } = {}) {
  if (order && isPayplug4xPrelevementOrder(order)) return 'Abonnement prélèvement';
  const kind = offerKind(product, order);
  if (kind === 'essai') return "Séance d'essai";
  if (String(kind).startsWith('coaching')) return 'Coaching privé';
  if (kind === 'baby-boxe') return 'Baby Boxe';
  if (kind === 'boxe-educative') return 'Boxe éducative';
  if (kind === 'abo-comptant') return 'Paiement comptant';
  if (kind === 'abo-prelevement') return 'Abonnement prélèvement';
  if (billingPlan === 'rib' || billingPlan === 'paypal' || product?.requires_iban) return 'Abonnement prélèvement';
  return 'Abonnement';
}

function offerDocumentCopy(product = {}, order = {}) {
  const kind = offerKind(product, order);
  const gym = gymLabel(order.customer_full?.gym || order.gym || product.gym);
  const title = productTitle(product);
  const period = durationBit(product) || paymentPeriodLabel(product);
  const prestation = isPrestationKind(kind);
  const portet = isPortetOrder(order);
  const clubShort = portet ? 'Noble Art Portésien' : 'Boxing Center';
  const accessScope = portet
    ? 'à la salle de Portet-sur-Garonne'
    : 'aux 5 salles Boxing Center';
  const accessHours = portet
    ? 'Accès : cours collectifs + accès libre à la salle de Portet-sur-Garonne.'
    : 'Accès : cours collectifs + accès libre 6j/7 (10h–21h) sur les 5 salles Boxing Center.';

  const gymLine = gym ? `Salle : ${gym}` : null;
  let headline = title || `Offre ${clubShort}`;
  let details = [];
  let accessLine = '';
  let footerNote = portet
    ? "Détail établi suite à l'inscription en ligne. TVA au taux en vigueur selon la nature de l'offre."
    : "Détail établi suite à l'inscription en ligne Boxing Center. TVA au taux en vigueur selon la nature de l'offre.";
  let contractTitle = portet
    ? "Contrat d'adhésion — Noble Art Portésien"
    : "Contrat d'adhésion — Boxing Center";
  let showBadge72h = false;
  let showSepa = false;

  if (kind === 'essai') {
    headline = "Séance d'essai — 1 cours encadré";
    details = [
      'Prestation ponctuelle : un cours collectif d’essai.',
      'Aucun abonnement, aucun prélèvement, aucun badge d’accès.',
    ];
    accessLine = "Accès limité à la séance d'essai — n'ouvre pas d'abonnement salle.";
    footerNote = "Cette facture concerne uniquement la séance d'essai. Elle ne constitue pas un contrat d'abonnement.";
    contractTitle = "Bon de commande — séance d'essai";
  } else if (kind === 'coaching-1') {
    headline = 'Coaching privé — 1 séance d’1 heure';
    details = [
      'Cours particulier avec un coach, prestation ponctuelle.',
      'Aucun abonnement, aucun prélèvement, aucun badge d’accès.',
    ];
    accessLine = "Prestation de coaching uniquement — n'ouvre pas d'accès illimité aux salles.";
    footerNote = "Cette facture concerne uniquement le cours particulier d'1 heure. Elle ne constitue pas un contrat d'abonnement.";
    contractTitle = 'Bon de commande — coaching privé';
  } else if (kind === 'coaching-5') {
    headline = 'Coaching privé — forfait 5 séances d’1 heure';
    details = [
      'Cours particuliers avec un coach (5 séances).',
      'Aucun abonnement salle, aucun prélèvement, aucun badge d’accès.',
    ];
    accessLine = "Forfait coaching uniquement — n'ouvre pas d'accès illimité aux salles.";
    footerNote = "Cette facture concerne uniquement le forfait de 5 séances de coaching. Elle ne constitue pas un contrat d'abonnement.";
    contractTitle = 'Bon de commande — coaching privé';
  } else if (kind === 'coaching-10') {
    headline = 'Coaching privé — forfait 10 séances d’1 heure';
    details = [
      'Cours particuliers avec un coach (10 séances).',
      'Aucun abonnement salle, aucun prélèvement, aucun badge d’accès.',
    ];
    accessLine = "Forfait coaching uniquement — n'ouvre pas d'accès illimité aux salles.";
    footerNote = "Cette facture concerne uniquement le forfait de 10 séances de coaching. Elle ne constitue pas un contrat d'abonnement.";
    contractTitle = 'Bon de commande — coaching privé';
  } else if (kind === 'baby-boxe') {
    headline = title || 'Baby Boxe (3-6 ans)';
    details = [
      'Formule enfants — paiement comptant.',
      'Pas de prélèvement SEPA, pas de badge automatique.',
    ];
    accessLine = 'Accès selon la formule Baby Boxe (créneaux enfants).';
  } else if (kind === 'boxe-educative') {
    headline = title || 'Boxe éducative (7-16 ans)';
    details = [
      'Formule enfants — paiement comptant.',
      'Pas de prélèvement SEPA, pas de badge automatique.',
    ];
    accessLine = 'Accès selon la formule Boxe éducative (créneaux enfants).';
  } else if (kind === 'abo-comptant') {
    headline = title || `Abonnement ${period || '12 mois'}`;
    details = [
      `Abonnement cours collectifs + accès libre ${accessScope}${period ? ` — ${period}` : ''}.`,
      'Paiement en une fois — pas de prélèvement automatique.',
    ];
    accessLine = accessHours;
  } else if (kind === 'abo-prelevement') {
    headline = title || `Abonnement sans engagement (${period || '4 semaines'})`;
    details = [
      `Abonnement cours collectifs + accès libre ${accessScope}${period ? ` — ${period}` : ''}.`,
      'Première échéance aujourd’hui, puis prélèvement sans engagement.',
    ];
    accessLine = accessHours;
    showSepa = true;
    showBadge72h = productNeedsAutoBadge(product) && !isPayplug4xPrelevementOrder(order);
  } else {
    headline = title || `Abonnement ${clubShort}`;
    details = [
      `Abonnement cours collectifs + accès libre ${accessScope}${period ? ` — ${period}` : ''}.`,
    ];
    accessLine = accessHours;
    showSepa = Boolean(product.requires_iban || productSupportsBillingChoice(product));
    showBadge72h = productNeedsAutoBadge(product) && !isPayplug4xPrelevementOrder(order);
  }

  if (shouldGiftBadgeComptant(order, product)) {
    showBadge72h = false;
    details.push('Badge d’accès réactivé — offert, pas de prélèvement du badge.');
  }

  const lines = [headline, ...details, gymLine].filter(Boolean);
  return {
    kind,
    prestation,
    typeLabel: documentTypeLabel(product, { billingPlan: order.payment?.billing_plan, order }),
    contractTitle,
    headline,
    description: lines.join('\n'),
    descriptionLines: lines,
    gymLine,
    accessLine,
    footerNote,
    showBadge72h,
    showSepa,
    showIban: showSepa && Boolean(order.payment?.iban),
  };
}

module.exports = {
  offerKind,
  isPrestationKind,
  documentTypeLabel,
  offerDocumentCopy,
  gymLabel,
};
