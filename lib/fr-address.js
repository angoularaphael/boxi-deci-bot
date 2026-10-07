const { logWarn } = require('./logger');

const DEFAULT_FR_ADDRESS = {
  address: '12 rue de Fenouillet',
  postal_code: '31200',
  city: 'Toulouse',
  country: 'France',
};

/** Communes fréquentes où la ville saisie « Toulouse » + CP suburbain bloque le mandat SEPA. */
const POSTAL_CITY_OVERRIDES = {
  '31270': 'Villeneuve-Tolosane',
  '31170': 'Tournefeuille',
  '31120': 'Portet-sur-Garonne',
  '31600': 'Muret',
  '31770': 'Colomiers',
  '31830': 'Plaisance-du-Touch',
  '31140': 'Aucamville',
  '31240': "L'Union",
  '31320': 'Castanet-Tolosan',
  '31850': 'Montrabé',
  '31150': 'Bruguières',
};

function parseGymAddress(raw) {
  const text = String(raw || '').trim();
  const m = text.match(/^(.+?),\s*(\d{5})\s+(.+)$/);
  if (m) {
    return { address: m[1].trim(), postal_code: m[2], city: m[3].trim(), country: 'France' };
  }
  return { ...DEFAULT_FR_ADDRESS };
}

function normalizeCityKey(city) {
  return String(city || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z]/g, '');
}

function isUsableRibCity(city, postalDigits) {
  const c = String(city || '').trim();
  if (!c) return false;
  if (/^\d+$/.test(c)) return false;
  const cityDigits = c.replace(/\D/g, '');
  if (cityDigits.length === 5 && cityDigits === String(postalDigits || '')) return false;
  return true;
}

/**
 * Corrige ville coincée dans la rue / CP suburbain avec ville « Toulouse ».
 * Ex. « 66 ter route de portet villeneuve tolosone » + 31270 + Toulouse
 *  -> rue nettoyée + Villeneuve-Tolosane.
 */
function reconcileRibCityAddress(address, postalDigits, city) {
  let street = String(address || '').trim();
  let resolvedCity = String(city || '').trim();
  let postal = String(postalDigits || '').replace(/\D/g, '');

  const vt = street.match(/\bvilleneuve[\s\-]*tolos[ao]n[ea]?\b/i);
  if (vt) {
    street = street.replace(vt[0], '').replace(/\s{2,}/g, ' ').trim();
    resolvedCity = 'Villeneuve-Tolosane';
    if (!postal || postal === '31270') postal = '31270';
  }

  const mapped = POSTAL_CITY_OVERRIDES[postal];
  if (mapped && /^toulouse$/i.test(resolvedCity)) {
    resolvedCity = mapped;
  }

  return {
    address: street,
    postal_code: postal,
    city: resolvedCity,
  };
}

function isValidFrenchPostalCode(postalCode) {
  const postalDigits = String(postalCode || '').replace(/\D/g, '');
  return postalDigits.length === 5;
}

function isFrenchCountry(raw) {
  const v = String(raw || '').trim().toLowerCase();
  if (!v) return true;
  return v === 'fr' || v === 'fra' || v === 'france';
}

function hasValidFrenchAddress(customer = {}) {
  if (!isFrenchCountry(customer.country || customer.pays)) return false;
  const postalDigits = String(customer.postal_code || customer.code_postal || '').replace(/\D/g, '');
  const address = customer.address || customer.adresse;
  const city = customer.city || customer.ville;
  return (
    isValidFrenchPostalCode(postalDigits) &&
    Boolean(address) &&
    isUsableRibCity(city, postalDigits)
  );
}

function realFrenchAddress(gymConfig = {}) {
  if (gymConfig?.address) return parseGymAddress(gymConfig.address);
  return { ...DEFAULT_FR_ADDRESS };
}

function ribAddressFields(customer = {}, gymConfig = {}) {
  const postalDigits = String(customer.postal_code || customer.code_postal || '').replace(/\D/g, '');
  const address = customer.address || customer.adresse;
  const city = customer.city || customer.ville;

  if (hasValidFrenchAddress(customer)) {
    const reconciled = reconcileRibCityAddress(address, postalDigits, city);
    if (
      normalizeCityKey(reconciled.city) !== normalizeCityKey(city) ||
      reconciled.address !== String(address || '').trim()
    ) {
      logWarn('Adresse RIB réconciliée (ville/CP)', {
        from_city: city,
        to_city: reconciled.city,
        postal_code: reconciled.postal_code,
      });
    }
    return {
      address: reconciled.address,
      postal_code: reconciled.postal_code || postalDigits,
      city: reconciled.city,
      country: 'France',
    };
  }

  logWarn('Adresse hors France — remplacement par une adresse française', {
    gym: gymConfig?.label || gymConfig?.deciplus_label || null,
  });
  return realFrenchAddress(gymConfig);
}

function originalAddressLine(customer = {}) {
  return [
    customer.address || customer.adresse,
    customer.postal_code || customer.code_postal,
    customer.city || customer.ville,
    customer.country || customer.pays,
  ]
    .filter(Boolean)
    .join(', ');
}

function applyFrenchAddressFallback(customer = {}, gymConfig = {}, { preserveOriginalInAddress2 = true } = {}) {
  if (!customer || typeof customer !== 'object') return customer;
  if (hasValidFrenchAddress(customer)) {
    return { ...customer, country: customer.country || customer.pays || 'FR' };
  }

  const addr = ribAddressFields(customer, gymConfig);
  const originalLine = originalAddressLine(customer);
  const out = {
    ...customer,
    address: addr.address,
    postal_code: addr.postal_code,
    city: addr.city,
    country: 'FR',
    pays: 'FR',
  };

  if (preserveOriginalInAddress2 && originalLine) {
    const note = `Adresse saisie: ${originalLine}`;
    const existing = customer.address2 || customer.adr2;
    out.address2 = existing ? `${existing} — ${note}` : note;
  }

  return out;
}

module.exports = {
  DEFAULT_FR_ADDRESS,
  POSTAL_CITY_OVERRIDES,
  parseGymAddress,
  normalizeCityKey,
  isUsableRibCity,
  isValidFrenchPostalCode,
  isFrenchCountry,
  hasValidFrenchAddress,
  realFrenchAddress,
  reconcileRibCityAddress,
  ribAddressFields,
  applyFrenchAddressFallback,
};
