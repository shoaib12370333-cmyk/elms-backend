const bcrypt = require('bcryptjs');

const SALT_ROUNDS = 10;

/**
 * Hashes a plain-text password for secure storage. Never store a password
 * in plain text - always pass it through this before saving to the database.
 */
async function hashPassword(plainPassword) {
  return bcrypt.hash(plainPassword, SALT_ROUNDS);
}

/**
 * Checks a plain-text password against a stored hash. Returns true/false -
 * never throws just because the password is wrong.
 */
async function verifyPassword(plainPassword, passwordHash) {
  if (!passwordHash) return false;
  return bcrypt.compare(plainPassword, passwordHash);
}

module.exports = { hashPassword, verifyPassword };
