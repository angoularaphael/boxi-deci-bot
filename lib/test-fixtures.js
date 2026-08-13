/**
 * Données client uniques pour tests (évite doublons Deciplus).
 */
function uniqueTestCustomer(prefix = 'test') {
  const ts = Date.now();
  const suffix = String(ts).slice(-8);
  // FR mobile = 10 chiffres (06 + 8). Pas 11, sinon phoneForDeciplus refuse le match.
  const phoneSuffix = String(ts).slice(-8).padStart(8, '0');
  return {
    first_name: 'Test',
    last_name: `Box${suffix.slice(0, 4)}`,
    email: `${prefix}-${suffix}@example.com`,
    phone: `06${phoneSuffix}`,
    birthdate: '1990-01-01',
    gender: 'M',
    gym: 'minimes',
    address: '1 rue Test Automatique',
    postal_code: '31000',
    city: 'Toulouse',
  };
}

const VALID_TEST_IBAN = 'FR7630001007941234567890185';

module.exports = { uniqueTestCustomer, VALID_TEST_IBAN };
