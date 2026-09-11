const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';

/**
 * Returns the 32-byte encryption key derived from the ENCRYPTION_KEY env var.
 * ENCRYPTION_KEY should be a long random string (at least 32 characters).
 */
function getKey() {
  const secret = process.env.ENCRYPTION_KEY;
  if (!secret) {
    throw new Error('ENCRYPTION_KEY is not set in the .env file.');
  }
  return crypto.createHash('sha256').update(secret).digest(); // always 32 bytes
}

/**
 * Encrypts a plain text string (e.g. a refresh token) for safe storage.
 * Returns a single string combining iv:authTag:ciphertext (all hex-encoded).
 */
function encrypt(plainText) {
  const key = getKey();
  const iv = crypto.randomBytes(12); // recommended IV length for GCM
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Decrypts a string previously produced by encrypt().
 */
function decrypt(encryptedString) {
  const key = getKey();
  const [ivHex, authTagHex, dataHex] = encryptedString.split(':');

  if (!ivHex || !authTagHex || !dataHex) {
    throw new Error('Encrypted value is malformed.');
  }

  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(dataHex, 'hex')),
    decipher.final(),
  ]);

  return decrypted.toString('utf8');
}

module.exports = { encrypt, decrypt };
