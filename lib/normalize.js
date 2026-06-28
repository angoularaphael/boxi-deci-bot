const { loadJson } = require('./utils');
const { normalizeIban, isValidFrenchIban } = require('./iban');
const { isTrialOrder, buildProductConfig } = require('../bot/catalog');

function normalizePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('0') && digits.length === 10) return `+33${digits.slice(1)}`;
  if (digits.startsWith('33') && digits.length >= 11) return `+${digits}`;
  if (digits.startsWith('+')) return digits;
  return digits.length >= 9 ? `+${digits}` : digits;
}

function normalizeGender(raw) {
  const v = String(raw || '').trim().toLowerCase();
  if (['m', 'male', 'homme', 'h'].includes(v)) return 'M';
  if (['f', 'female', 'femme', 'f'].includes(v)) return 'F';
  return v || null;
}

function extractProductName(input) {
  if (input.product_name) return String(input.product_name).trim();
  if (input.deciplus_product_name) return String(input.deciplus_product_name).trim();
  if (input.product?.name) return String(input.product.name).trim();
  if (Array.isArray(input.products) && input.products[0]?.name) {
    return String(input.products[0].name).trim();
  }
  return null;
}

function extractProductReference(input) {
  if (input.product_reference) return String(input.product_reference).trim();
  if (input.product?.reference) return String(input.product.reference).trim();
  if (Array.isArray(input.products) && input.products[0]?.reference) {
    return String(input.products[0].reference).trim();
  }
  return null;
}

function normalizeAction(input) {
  const raw = String(input.action || input.event || input.type || 'sale').toLowerCase();
  if (['cancel', 'cancelled', 'cancellation', 'refund', 'refunded', 'annulation'].includes(raw)) {
    return 'cancel';
  }
  return 'sale';
}

function getJobId(order) {
  if (order.action === 'cancel') return `${order.order_id}#cancel`;
  return order.order_id;
}

function normalizeOrder(input) {
  const productName = extractProductName(input);
  const productReference = extractProductReference(input);
  const action = normalizeAction(input);
  const offer = String(
    input.offer || productReference || productName || input.product || ''
  )
    .toLowerCase()
    .trim();
  const gym = String(input.gym || input.salle || '').toLowerCase().replace(/\s+/g, '-');

  const customer = input.customer || {};
  const payment = input.payment || {};
  const utm = input.utm || {};

  const order = {
    order_id: String(input.order_id || input.reference || ''),
    action,
    job_id: input.job_id || null,
    offer,
    product_name: productName,
    product_reference: productReference,
    product_id: input.product_id || null,
    deciplus_id: input.deciplus_id || null,
    deciplus_product_search: input.deciplus_product_search || null,
    sale_type: input.sale_type || null,
    requires_iban: input.requires_iban,
    deciplus_member_id: input.deciplus_member_id ? String(input.deciplus_member_id) : null,
    cancel_reason: input.cancel_reason || input.reason || null,
    gym,
    customer: {
      first_name: String(customer.first_name || customer.prenom || '').trim(),
      last_name: String(customer.last_name || customer.nom || '').trim(),
      email: String(customer.email || '').trim().toLowerCase(),
      phone: normalizePhone(customer.phone || customer.telephone || customer.mobile),
      birthdate: customer.birthdate || customer.date_naissance || null,
      gender: normalizeGender(customer.gender || customer.sexe),
      address: customer.address || customer.adresse || null,
      postal_code: customer.postal_code || customer.code_postal || null,
      city: customer.city || customer.ville || null,
      country: customer.country || customer.pays || 'FR',
    },
    payment: {
      amount: Number(payment.amount ?? payment.montant ?? 0),
      method: payment.method || payment.moyen || 'card',
      status: payment.status || payment.statut || 'paid',
      date: payment.date || new Date().toISOString(),
      iban: payment.iban ? normalizeIban(payment.iban) : null,
    },
    utm: {
      source: utm.source || utm.utm_source || null,
      medium: utm.medium || utm.utm_medium || null,
      campaign: utm.campaign || utm.utm_campaign || null,
      content: utm.content || utm.utm_content || null,
      term: utm.term || utm.utm_term || null,
    },
    source: input.source || 'prestashop',
    raw: input,
  };

  order.job_id = order.job_id || getJobId(order);
  return order;
}

function validateCancelOrder(order) {
  const errors = [];
  if (!order.order_id) errors.push('order_id manquant');
  if (
    !order.deciplus_member_id &&
    !order.customer?.email &&
    !order.customer?.phone
  ) {
    errors.push('deciplus_member_id ou email/téléphone requis pour annulation');
  }
  return errors;
}

function validateOrder(order) {
  if (order.action === 'cancel') return validateCancelOrder(order);
  const errors = [];
  if (!order.order_id) errors.push('order_id manquant');
  if (!order.customer.first_name) errors.push('prénom manquant');
  if (!order.customer.last_name) errors.push('nom manquant');
  if (!order.customer.email && !order.customer.phone) errors.push('email ou téléphone requis');

  const trial = isTrialOrder(order);
  if (!trial && !order.product_name) {
    errors.push('product_name manquant (nom du produit PrestaShop = nom Deciplus)');
  }

  if (order.payment.status === 'paid' && !order.payment.amount && !trial) {
    errors.push('montant manquant pour vente payée');
  }
  if (order.payment.iban && !isValidFrenchIban(order.payment.iban)) {
    errors.push('IBAN français invalide');
  }

  const needsIban =
    !trial &&
    order.requires_iban !== false &&
    !/comptant/i.test(order.product_name || '') &&
    order.payment.status === 'paid';

  if (needsIban && !order.payment.iban) {
    errors.push('IBAN requis pour cette offre');
  }
  return errors;
}

/** @deprecated Utiliser resolveProductConfig(order, catalog) dans bot/catalog.js */
function getProductConfig(offer, overrides = {}) {
  const order = {
    offer,
    product_name: overrides.deciplus_product_name || offer,
    payment: { amount: overrides.amount ?? 0, status: 'paid' },
  };
  return buildProductConfig(order, overrides.deciplus_product_name ? {
    id: 0,
    title: overrides.deciplus_product_name,
    type: overrides.sale_type === 'carte' ? 'decipass' : 'abo',
    categoryId: overrides.sale_type === 'carte' ? 'decipass' : 'abo',
    price: overrides.amount || 0,
  } : null);
}

function getGymConfig(gymSlug) {
  const gyms = loadJson('config/gym-mapping.json');
  const key = Object.keys(gyms).find(
    (k) => k === gymSlug || gyms[k].deciplus_label.toLowerCase().replace(/\s+/g, '-') === gymSlug
  );
  if (!key) throw new Error(`Salle inconnue: ${gymSlug}`);
  return { key, ...gyms[key] };
}

function buildInternalNote(order) {
  const parts = [
    `Source: ${order.source}`,
    order.product_name ? `Produit: ${order.product_name}` : null,
    order.utm.source ? `UTM source: ${order.utm.source}` : null,
    order.utm.medium ? `UTM medium: ${order.utm.medium}` : null,
    order.utm.campaign ? `UTM campaign: ${order.utm.campaign}` : null,
    order.order_id ? `Commande: ${order.order_id}` : null,
  ].filter(Boolean);
  return parts.join(' | ');
}

module.exports = {
  normalizePhone,
  normalizeGender,
  normalizeOrder,
  validateOrder,
  validateCancelOrder,
  getJobId,
  getProductConfig,
  getGymConfig,
  buildInternalNote,
  normalizeIban,
  isValidFrenchIban,
};
