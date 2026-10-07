/**
 * Validation IBAN / RIB français (Deciplus, Nuapay, prélèvements SEPA).
 *
 * Format FR : FR + clé IBAN (2 ch.) + RIB (23 car.)
 *   · code banque (5 ch.) — ex. 30001 BNP, 20041 La Banque Postale, 10107 Boursorama
 *   · code guichet (5 ch.)
 *   · n° de compte (11 car. alphanumériques A–Z, 0–9)
 *   · clé RIB (2 ch.)
 */
function normalizeIban(raw) {
  return String(raw || '')
    .replace(/\s+/g, '')
    .toUpperCase();
}

/** Lettres autorisées dans le n° de compte RIB (norme bancaire française). */
function ribAccountCharToDigit(ch) {
  if (ch >= '0' && ch <= '9') return ch;
  const map = {
    A: '1',
    J: '1',
    B: '2',
    K: '2',
    S: '2',
    C: '3',
    L: '3',
    T: '3',
    D: '4',
    M: '4',
    U: '4',
    E: '5',
    N: '5',
    V: '5',
    F: '6',
    O: '6',
    W: '6',
    G: '7',
    P: '7',
    X: '7',
    H: '8',
    Q: '8',
    Y: '8',
    I: '9',
    R: '9',
    Z: '9',
  };
  return map[ch] ?? null;
}

function isValidIbanMod97(value) {
  const rearranged = value.slice(4) + value.slice(0, 4);
  const expanded = rearranged.replace(/[A-Z]/g, (ch) => String(ch.charCodeAt(0) - 55));
  let remainder = 0;
  for (let i = 0; i < expanded.length; i += 7) {
    remainder = Number(String(remainder) + expanded.slice(i, i + 7)) % 97;
  }
  return remainder === 1;
}

/** Clé RIB : 97 − ((89×banque + 15×guichet + 3×compte) mod 97) — toutes banques FR. */
function isValidFrenchRibKey(bban23) {
  const bank = bban23.slice(0, 5);
  const branch = bban23.slice(5, 10);
  const account = bban23.slice(10, 21);
  const key = bban23.slice(21, 23);
  if (!/^[0-9]{5}$/.test(bank) || !/^[0-9]{5}$/.test(branch) || !/^[0-9]{2}$/.test(key)) {
    return false;
  }
  if (!/^[0-9A-Z]{11}$/.test(account)) return false;

  let accountDigits = '';
  for (const ch of account) {
    const digit = ribAccountCharToDigit(ch);
    if (digit == null) return false;
    accountDigits += digit;
  }

  const checksum = (89n * BigInt(bank) + 15n * BigInt(branch) + 3n * BigInt(accountDigits)) % 97n;
  const expected = String(checksum === 0n ? 97n : 97n - checksum).padStart(2, '0');
  return key === expected;
}

const FRENCH_IBAN_RE = /^FR[0-9]{2}[0-9]{5}[0-9]{5}[0-9A-Z]{11}[0-9]{2}$/;

function frenchIbanError(raw) {
  const value = normalizeIban(raw);
  if (!value) return 'IBAN requis pour le prélèvement.';
  if (!value.startsWith('FR')) {
    return 'Seuls les IBAN français commençant par FR sont acceptés. Si vous n’en avez pas, rapprochez-vous du manager de votre salle.';
  }
  if (value.length !== 27) {
    return 'Un IBAN français compte 27 caractères (ex. FR76 3000 6000 0112 3456 7890 189).';
  }
  if (!FRENCH_IBAN_RE.test(value)) {
    return 'Format RIB invalide : vérifiez le code banque (5 ch.), le guichet (5 ch.), le compte (11 car.) et la clé (2 ch.).';
  }
  const bban = value.slice(4);
  if (!isValidFrenchRibKey(bban)) {
    return 'Clé RIB incorrecte — vérifiez le numéro de compte et la clé à 2 chiffres.';
  }
  if (!isValidIbanMod97(value)) {
    return 'Clé IBAN incorrecte — vérifiez l’ensemble de l’IBAN.';
  }
  return null;
}

function isValidFrenchIban(iban) {
  return frenchIbanError(iban) == null;
}

/** Retourne l’IBAN normalisé si valide, sinon null (ne jamais persister un RIB incomplet). */
function sanitizeFrenchIban(raw) {
  if (!raw) return null;
  const value = normalizeIban(raw);
  return isValidFrenchIban(value) ? value : null;
}

/** BIC SWIFT 8 ou 11 caractères. */
function isLikelyBic(raw) {
  const v = String(raw || '')
    .replace(/\s+/g, '')
    .toUpperCase();
  return /^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(v);
}

/**
 * Code banque FR (5 chiffres) -> BIC de repli.
 * Deciplus remplit souvent le BIC exact (agence) après le blur IBAN ;
 * cette table sert si le lookup UI reste vide.
 */
const FR_BANK_BIC = {
  '10057': 'CMCIFRPP',
  '10107': 'BOUSFRPP',
  '10278': 'CMCIFRPP',
  '11899': 'CMCIFRPP',
  '13807': 'CCOPFRPPXXX',
  '14518': 'FTNOFRP1XXX',
  '14559': 'CEPAFRPP',
  '15589': 'CMBRFR2BXXX',
  '16518': 'SNNNFR22XXX',
  '16598': 'FPELFR21XXX',
  '16798': 'TRZOFR21XXX',
  '16908': 'LBDIFRP1XXX',
  '16958': 'QNTOFRP1XXX',
  '17318': 'NTSBFRM1XXX',
  '17418': 'TRWIFRPPXXX',
  '17515': 'CEPAFRPP751',
  '17598': 'LYDIFRP2XXX',
  '18370': 'REVOFRP2XXX',
  '18706': 'BREDFRPPXXX',
  '20041': 'PSSTFRPPXXX',
  '20433': 'NTSBFRM1XXX',
  '28233': 'REVOFRP2XXX',
  '30001': 'BDFEFRPPCCT',
  '30002': 'CRLYFRPPXXX',
  '30003': 'SOGEFRPPXXX',
  '30004': 'BNPAFRPPXXX',
  '30006': 'AGRIFRPPXXX',
  '30066': 'BNPAFRPPXXX',
  '40618': 'BOUSFRPPXXX',
  '40978': 'BSPFFRPPXXX',
  '42559': 'QNTOFRP1XXX',
};

function bicFromFrenchIban(raw) {
  const value = normalizeIban(raw);
  if (!isValidFrenchIban(value)) return '';
  const bank = value.slice(4, 9);
  if (FR_BANK_BIC[bank]) return FR_BANK_BIC[bank];
  // Crédit Agricole régional (ex. 13106). Ne pas classer les néobanques 16xxx/17xxx.
  if (/^1[1-8]\d{2}06$/.test(bank)) return 'AGRIFRPPXXX';
  return '';
}

/** Découpe un IBAN FR en champs RIB Deciplus (banque / guichet / compte / clé / BIC). */
function frenchIbanToRibParts(raw) {
  const value = normalizeIban(raw);
  if (!isValidFrenchIban(value)) return null;
  return {
    iban: value,
    etablissement: value.slice(4, 9),
    guichet: value.slice(9, 14),
    numero: value.slice(14, 25),
    cle: value.slice(25, 27),
    bic: bicFromFrenchIban(value),
  };
}

module.exports = {
  normalizeIban,
  isValidFrenchIban,
  frenchIbanError,
  isValidFrenchRibKey,
  sanitizeFrenchIban,
  frenchIbanToRibParts,
  isLikelyBic,
  bicFromFrenchIban,
};
