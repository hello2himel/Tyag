/**
 * WebCrypto primitives for encrypted backups.
 *
 * Only platform-primitive cryptography is used — never a home-grown cipher:
 *  - SHA-256 (`crypto.subtle.digest`) for export integrity hashes.
 *  - PBKDF2-HMAC-SHA-256 with 310 000 iterations and a 16-byte random salt for
 *    key derivation (OWASP-recommended PBKDF2-SHA256 work factor at the time
 *    of writing).
 *  - AES-256-GCM with a 12-byte random IV and a 128-bit authentication tag for
 *    the payload.
 *
 * The same code runs in browsers, Capacitor/Tauri WebViews and Node >= 20
 * because all of them expose `globalThis.crypto.subtle`. Base64 is implemented
 * here (rather than `btoa`/`Buffer`) so the envelope is identical everywhere
 * and importable by every platform.
 */
import type { EncryptedBackupEnvelope } from '../domain';
import { ENCRYPTED_BACKUP_FORMAT } from '../domain';
import { TyagError } from '../util/errors';

/** Envelope version understood by this release. */
export const BACKUP_ENVELOPE_VERSION = 1;
/** PBKDF2-HMAC-SHA-256 iteration count for new encrypted backups. */
export const KDF_ITERATIONS = 310_000;
/** Random PBKDF2 salt length in bytes. */
export const KDF_SALT_BYTES = 16;
/** AES-GCM initialisation vector length in bytes. */
export const AES_GCM_IV_BYTES = 12;
/** AES-GCM authentication tag length in bits. */
export const AES_GCM_TAG_BITS = 128;

/** Refuse absurd iteration counts to keep opening a backup fast enough. */
const MIN_ACCEPTED_KDF_ITERATIONS = 10_000;
const MAX_ACCEPTED_KDF_ITERATIONS = 2_000_000;

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder('utf-8', { fatal: true });

function cryptoObject(): Crypto {
  const candidate = (globalThis as { crypto?: Crypto }).crypto;
  if (!candidate || !candidate.subtle) {
    throw new TyagError(
      'UNAVAILABLE',
      'Encrypted backups are not available on this platform. You can still export a JSON backup.',
    );
  }
  return candidate;
}

function subtle(): SubtleCrypto {
  return cryptoObject().subtle;
}

function failCrypto(message: string): never {
  throw new TyagError('CRYPTO', message);
}

function failInvalid(message: string): never {
  throw new TyagError('IMPORT_INVALID', message);
}

/** Cryptographically random bytes from the platform CSPRNG. */
export function randomBytes(length: number): Uint8Array {
  if (!Number.isInteger(length) || length <= 0) {
    throw new TyagError('VALIDATION', 'Invalid random byte length.');
  }
  const bytes = new Uint8Array(length);
  cryptoObject().getRandomValues(bytes);
  return bytes;
}

/** Standard base64 (RFC 4648) without line breaks. */
export function bytesToBase64(bytes: Uint8Array): string {
  let output = '';
  const remainder = bytes.length % 3;
  const whole = bytes.length - remainder;
  for (let index = 0; index < whole; index += 3) {
    const a = bytes[index]!;
    const b = bytes[index + 1]!;
    const c = bytes[index + 2]!;
    const triple = (a << 16) | (b << 8) | c;
    output +=
      BASE64_ALPHABET[(triple >> 18) & 63]! +
      BASE64_ALPHABET[(triple >> 12) & 63]! +
      BASE64_ALPHABET[(triple >> 6) & 63]! +
      BASE64_ALPHABET[triple & 63]!;
  }
  if (remainder === 1) {
    const a = bytes[whole]!;
    const triple = a << 16;
    output += `${BASE64_ALPHABET[(triple >> 18) & 63]!}${BASE64_ALPHABET[(triple >> 12) & 63]!}==`;
  } else if (remainder === 2) {
    const a = bytes[whole]!;
    const b = bytes[whole + 1]!;
    const triple = (a << 16) | (b << 8);
    output += `${BASE64_ALPHABET[(triple >> 18) & 63]!}${BASE64_ALPHABET[(triple >> 12) & 63]!}${BASE64_ALPHABET[(triple >> 6) & 63]!}=`;
  }
  return output;
}

/**
 * Decode standard base64. Throws `IMPORT_INVALID` for anything that is not
 * valid base64 so a corrupt envelope produces a clear message.
 */
export function base64ToBytes(value: string): Uint8Array {
  if (typeof value !== 'string') {
    failInvalid('The backup file is missing encrypted data.');
  }
  const clean = value.replace(/\s+/g, '');
  if (clean.length === 0) return new Uint8Array(0);
  if (clean.length % 4 !== 0) failInvalid('The backup file contains invalid encrypted data.');
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  const body = padding > 0 ? clean.slice(0, -padding) : clean;
  const bytes: number[] = [];
  for (let index = 0; index < body.length; index += 4) {
    const chunk = body.slice(index, index + 4);
    if (chunk.length < 2) failInvalid('The backup file contains invalid encrypted data.');
    const values = chunk.split('').map((character) => BASE64_ALPHABET.indexOf(character));
    if (values.some((entry) => entry < 0)) failInvalid('The backup file contains invalid encrypted data.');
    while (values.length < 4) values.push(0);
    const [a, b, c, d] = values as [number, number, number, number];
    const triple = (a << 18) | (b << 12) | (c << 6) | d;
    bytes.push((triple >> 16) & 0xff);
    if (values.length > 2) bytes.push((triple >> 8) & 0xff);
    if (values.length > 3) bytes.push(triple & 0xff);
  }
  if (padding === 2) {
    bytes.pop();
    bytes.pop();
  } else if (padding === 1) {
    bytes.pop();
  }
  return new Uint8Array(bytes);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

/** Lower-case hex SHA-256 of UTF-8 text or raw bytes. */
export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const bytes = typeof input === 'string' ? ENCODER.encode(input) : input;
  const digest = await subtle().digest('SHA-256', toArrayBuffer(bytes));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function decodeBase64OrThrow(value: string, label: string): Uint8Array {
  try {
    return base64ToBytes(value);
  } catch {
    failInvalid(`The backup file contains invalid ${label} data.`);
  }
}

async function deriveAesKey(password: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const material = await subtle().importKey('raw', toArrayBuffer(ENCODER.encode(password)), 'PBKDF2', false, [
    'deriveKey',
  ]);
  return subtle().deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: toArrayBuffer(salt), iterations },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

interface EncryptStringResult {
  iterations: number;
  salt: string;
  iv: string;
  payload: string;
}

/**
 * Encrypt a UTF-8 string with PBKDF2-derived AES-256-GCM.
 *
 * @param password non-empty user password; never stored or logged.
 */
export async function encryptString(
  plaintext: string,
  password: string,
  iterations: number = KDF_ITERATIONS,
): Promise<EncryptStringResult> {
  if (typeof password !== 'string' || password.length === 0) {
    throw new TyagError('VALIDATION', 'Enter a password to encrypt this backup.');
  }
  if (!Number.isInteger(iterations) || iterations < MIN_ACCEPTED_KDF_ITERATIONS) {
    throw new TyagError('VALIDATION', 'Invalid encryption work factor.');
  }
  const salt = randomBytes(KDF_SALT_BYTES);
  const iv = randomBytes(AES_GCM_IV_BYTES);
  const key = await deriveAesKey(password, salt, iterations);
  const ciphertext = await subtle().encrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(iv), tagLength: AES_GCM_TAG_BITS },
    key,
    toArrayBuffer(ENCODER.encode(plaintext)),
  );
  return {
    iterations,
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    payload: bytesToBase64(new Uint8Array(ciphertext)),
  };
}

/**
 * Decrypt a payload produced by {@link encryptString}.
 *
 * A wrong password and a corrupt payload are cryptographically
 * indistinguishable (GCM authentication fails for both), so the error message
 * covers both possibilities without leaking which one happened.
 */
export async function decryptString(data: EncryptStringResult, password: string): Promise<string> {
  if (typeof password !== 'string' || password.length === 0) {
    throw new TyagError('VALIDATION', 'Enter the password for this backup.');
  }
  const salt = decodeBase64OrThrow(data.salt, 'salt');
  const iv = decodeBase64OrThrow(data.iv, 'encryption');
  if (salt.length !== KDF_SALT_BYTES) failInvalid('The backup file uses an unsupported salt.');
  if (iv.length !== AES_GCM_IV_BYTES) failInvalid('The backup file uses an unsupported encryption IV.');
  if (!Number.isInteger(data.iterations) || data.iterations < MIN_ACCEPTED_KDF_ITERATIONS) {
    failInvalid('The backup file uses an unsupported password work factor.');
  }
  if (data.iterations > MAX_ACCEPTED_KDF_ITERATIONS) {
    failInvalid('The backup file uses an unsupported password work factor.');
  }
  let ciphertext: Uint8Array;
  try {
    ciphertext = base64ToBytes(data.payload);
  } catch {
    failInvalid('The backup file contains invalid encrypted data.');
  }
  if (ciphertext.length <= AES_GCM_TAG_BITS / 8) failInvalid('The backup file contains invalid encrypted data.');
  try {
    const key = await deriveAesKey(password, salt, data.iterations);
    const plaintext = await subtle().decrypt(
      { name: 'AES-GCM', iv: toArrayBuffer(iv), tagLength: AES_GCM_TAG_BITS },
      key,
      toArrayBuffer(ciphertext),
    );
    return DECODER.decode(new Uint8Array(plaintext));
  } catch (error) {
    if (error instanceof TyagError) throw error;
    failCrypto('Could not decrypt this backup. Check the password and try again, or the file may be damaged.');
  }
}

/**
 * Build the full encrypted-backup envelope around a UTF-8 JSON payload.
 *
 * The envelope stores only what is needed to derive the key: format/version,
 * KDF parameters (with a fresh random salt), the AES-GCM IV and the encrypted
 * payload. The password itself is never written anywhere.
 */
export async function sealEnvelope(
  plaintext: string,
  password: string,
  meta: { createdAt: number; appVersion: string; schemaVersion: number },
): Promise<EncryptedBackupEnvelope> {
  const encrypted = await encryptString(plaintext, password);
  return {
    format: ENCRYPTED_BACKUP_FORMAT,
    version: BACKUP_ENVELOPE_VERSION,
    createdAt: meta.createdAt,
    appVersion: meta.appVersion,
    schemaVersion: meta.schemaVersion,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: encrypted.iterations, salt: encrypted.salt },
    cipher: { name: 'AES-GCM', iv: encrypted.iv },
    payload: encrypted.payload,
  };
}

/** Parse and structurally validate an encrypted-backup envelope. */
export function parseEnvelope(text: string): EncryptedBackupEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    failInvalid('This file is not a valid Tyag backup.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    failInvalid('This file is not a valid Tyag backup.');
  }
  const record = parsed as Record<string, unknown>;
  if (record.format !== ENCRYPTED_BACKUP_FORMAT) {
    failInvalid('This file is not an encrypted Tyag backup.');
  }
  if (typeof record.version !== 'number' || !Number.isInteger(record.version) || record.version < 1) {
    failInvalid('This encrypted backup has an invalid version.');
  }
  if (record.version > BACKUP_ENVELOPE_VERSION) {
    throw new TyagError(
      'IMPORT_UNSUPPORTED_VERSION',
      'This backup was created by a newer version of Tyag. Update the app to open it.',
    );
  }
  const kdf = record.kdf;
  const cipher = record.cipher;
  if (!kdf || typeof kdf !== 'object' || Array.isArray(kdf)) failInvalid('This encrypted backup is damaged.');
  if (!cipher || typeof cipher !== 'object' || Array.isArray(cipher)) failInvalid('This encrypted backup is damaged.');
  const kdfRecord = kdf as Record<string, unknown>;
  const cipherRecord = cipher as Record<string, unknown>;
  if (kdfRecord.name !== 'PBKDF2' || kdfRecord.hash !== 'SHA-256') {
    failInvalid('This encrypted backup uses an unsupported key derivation method.');
  }
  if (cipherRecord.name !== 'AES-GCM') {
    failInvalid('This encrypted backup uses an unsupported cipher.');
  }
  if (typeof record.createdAt !== 'number' || !Number.isFinite(record.createdAt)) {
    failInvalid('This encrypted backup is damaged.');
  }
  if (typeof record.schemaVersion !== 'number' || !Number.isInteger(record.schemaVersion)) {
    failInvalid('This encrypted backup is damaged.');
  }
  if (typeof record.appVersion !== 'string' || typeof record.payload !== 'string') {
    failInvalid('This encrypted backup is damaged.');
  }
  if (typeof kdfRecord.salt !== 'string' || typeof cipherRecord.iv !== 'string') {
    failInvalid('This encrypted backup is damaged.');
  }
  if (typeof kdfRecord.iterations !== 'number' || !Number.isInteger(kdfRecord.iterations)) {
    failInvalid('This encrypted backup is damaged.');
  }
  return {
    format: ENCRYPTED_BACKUP_FORMAT,
    version: record.version,
    createdAt: record.createdAt,
    appVersion: record.appVersion,
    schemaVersion: record.schemaVersion,
    kdf: {
      name: 'PBKDF2',
      hash: 'SHA-256',
      iterations: kdfRecord.iterations,
      salt: kdfRecord.salt,
    },
    cipher: { name: 'AES-GCM', iv: cipherRecord.iv },
    payload: record.payload,
  };
}

/** Parse an envelope and decrypt its UTF-8 JSON payload. */
export async function openEnvelope(text: string, password: string): Promise<string> {
  const envelope = parseEnvelope(text);
  return decryptString(
    {
      iterations: envelope.kdf.iterations,
      salt: envelope.kdf.salt,
      iv: envelope.cipher.iv,
      payload: envelope.payload,
    },
    password,
  );
}
