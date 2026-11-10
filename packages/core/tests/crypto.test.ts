import { describe, expect, it } from 'vitest';
import { TyagError, ENCRYPTED_BACKUP_FORMAT } from '../src/index';
import {
  AES_GCM_IV_BYTES,
  BACKUP_ENVELOPE_VERSION,
  KDF_ITERATIONS,
  KDF_SALT_BYTES,
  base64ToBytes,
  bytesToBase64,
  decryptString,
  encryptString,
  openEnvelope,
  parseEnvelope,
  randomBytes,
  sealEnvelope,
  sha256Hex,
} from '../src/backup/crypto';

const PASSWORD = 'correct horse battery staple';

function keyMaterial(envelope: { kdf: { salt: string }; cipher: { iv: string } }): {
  salt: Uint8Array;
  iv: Uint8Array;
} {
  return { salt: base64ToBytes(envelope.kdf.salt), iv: base64ToBytes(envelope.cipher.iv) };
}

describe('crypto: base64', () => {
  it('round-trips every byte length remainder', () => {
    for (let length = 0; length <= 33; length += 1) {
      const bytes = new Uint8Array(length);
      for (let index = 0; index < length; index += 1) bytes[index] = (index * 37 + 11) % 256;
      const encoded = bytesToBase64(bytes);
      expect(encoded.length % 4).toBe(0);
      expect(encoded).not.toMatch(/[\r\n]/);
      expect(base64ToBytes(encoded)).toEqual(bytes);
    }
  });

  it('encodes known values', () => {
    expect(bytesToBase64(new Uint8Array([0x66]))).toBe('Zg==');
    expect(bytesToBase64(new Uint8Array([0x66, 0x6f]))).toBe('Zm8=');
    expect(bytesToBase64(new Uint8Array([0x66, 0x6f, 0x6f]))).toBe('Zm9v');
    expect(bytesToBase64(new Uint8Array([0x66, 0x6f, 0x6f, 0x62, 0x61, 0x72]))).toBe('Zm9vYmFy');
  });

  it('accepts surrounding whitespace and rejects invalid input', () => {
    expect(base64ToBytes(' Zm9v \n')).toEqual(new Uint8Array([0x66, 0x6f, 0x6f]));
    expect(() => base64ToBytes('not base64!')).toThrow(TyagError);
    expect(base64ToBytes('')).toEqual(new Uint8Array(0));
    expect(() => base64ToBytes('abc')).toThrow(TyagError);
  });
});

describe('crypto: SHA-256 integrity hashing', () => {
  it('matches the published test vectors', async () => {
    expect(await sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('hashes bytes the same way as their UTF-8 text', async () => {
    const text = 'Tyag — private by design ✓';
    expect(await sha256Hex(new TextEncoder().encode(text))).toBe(await sha256Hex(text));
  });
});

describe('crypto: random bytes', () => {
  it('returns the requested length and fresh values', () => {
    const first = randomBytes(16);
    const second = randomBytes(16);
    expect(first).toHaveLength(16);
    expect(second).toHaveLength(16);
    expect(first).not.toEqual(second);
    expect(first.some((byte) => byte !== 0)).toBe(true);
    expect(() => randomBytes(0)).toThrow(TyagError);
  });
});

describe('crypto: AES-256-GCM encryption', () => {
  it('round-trips UTF-8 text and uses the documented KDF parameters', async () => {
    const plaintext = JSON.stringify({ hello: 'world', emoji: '🔒', nested: [1, 2, 3] });
    const encrypted = await encryptString(plaintext, PASSWORD);
    expect(encrypted.iterations).toBe(KDF_ITERATIONS);
    expect(base64ToBytes(encrypted.salt)).toHaveLength(KDF_SALT_BYTES);
    expect(base64ToBytes(encrypted.iv)).toHaveLength(AES_GCM_IV_BYTES);
    expect(await decryptString(encrypted, PASSWORD)).toBe(plaintext);
  });

  it('uses a fresh salt and IV for every call', async () => {
    const first = await encryptString('same', PASSWORD);
    const second = await encryptString('same', PASSWORD);
    expect(first.salt).not.toBe(second.salt);
    expect(first.iv).not.toBe(second.iv);
    expect(first.payload).not.toBe(second.payload);
  });

  it('rejects a wrong password with a clear CRYPTO error', async () => {
    const encrypted = await encryptString('secret', PASSWORD);
    await expect(decryptString(encrypted, 'wrong password')).rejects.toMatchObject({
      name: 'TyagError',
      code: 'CRYPTO',
    });
    try {
      await decryptString(encrypted, 'wrong password');
    } catch (error) {
      expect((error as TyagError).message).toContain('Could not decrypt');
    }
  });

  it('detects tampered ciphertext (authenticated encryption)', async () => {
    const encrypted = await encryptString('secret', PASSWORD);
    const bytes = base64ToBytes(encrypted.payload);
    bytes[0] = (bytes[0]! ^ 0xff) & 0xff;
    const tampered = { ...encrypted, payload: bytesToBase64(bytes) };
    await expect(decryptString(tampered, PASSWORD)).rejects.toMatchObject({ code: 'CRYPTO' });
  });

  it('rejects empty passwords and unsupported envelope parameters', async () => {
    await expect(encryptString('secret', '')).rejects.toMatchObject({ code: 'VALIDATION' });
    const encrypted = await encryptString('secret', PASSWORD);
    await expect(decryptString(encrypted, '')).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(
      decryptString({ ...encrypted, salt: bytesToBase64(new Uint8Array(3)) }, PASSWORD),
    ).rejects.toMatchObject({ code: 'IMPORT_INVALID' });
    await expect(
      decryptString({ ...encrypted, iv: bytesToBase64(new Uint8Array(3)) }, PASSWORD),
    ).rejects.toMatchObject({ code: 'IMPORT_INVALID' });
    await expect(decryptString({ ...encrypted, iterations: 10 }, PASSWORD)).rejects.toMatchObject({
      code: 'IMPORT_INVALID',
    });
    await expect(decryptString({ ...encrypted, iterations: 99_999_999 }, PASSWORD)).rejects.toMatchObject({
      code: 'IMPORT_INVALID',
    });
    await expect(decryptString({ ...encrypted, payload: 'AAAA' }, PASSWORD)).rejects.toMatchObject({
      code: 'IMPORT_INVALID',
    });
  });
});

describe('crypto: encrypted backup envelope', () => {
  const meta = { createdAt: 1_767_225_600_000, appVersion: '1.0.0', schemaVersion: 1 };

  it('seals and opens an envelope with the documented shape', async () => {
    const envelope = await sealEnvelope('{"format":"x"}', PASSWORD, meta);
    expect(envelope.format).toBe(ENCRYPTED_BACKUP_FORMAT);
    expect(envelope.version).toBe(BACKUP_ENVELOPE_VERSION);
    expect(envelope.createdAt).toBe(meta.createdAt);
    expect(envelope.appVersion).toBe('1.0.0');
    expect(envelope.schemaVersion).toBe(1);
    expect(envelope.kdf).toMatchObject({ name: 'PBKDF2', hash: 'SHA-256', iterations: KDF_ITERATIONS });
    expect(envelope.cipher.name).toBe('AES-GCM');
    const material = keyMaterial(envelope);
    expect(material.salt).toHaveLength(KDF_SALT_BYTES);
    expect(material.iv).toHaveLength(AES_GCM_IV_BYTES);

    const text = JSON.stringify(envelope);
    expect(await openEnvelope(text, PASSWORD)).toBe('{"format":"x"}');
    await expect(openEnvelope(text, 'nope')).rejects.toMatchObject({ code: 'CRYPTO' });
  });

  it('rejects malformed envelopes with clear errors', async () => {
    const envelope = await sealEnvelope('payload', PASSWORD, meta);
    const parsed = parseEnvelope(JSON.stringify(envelope));
    expect(parsed.format).toBe(ENCRYPTED_BACKUP_FORMAT);

    expect(() => parseEnvelope('not json')).toThrow(TyagError);
    expect(() => parseEnvelope(JSON.stringify({ ...envelope, format: 'other' }))).toThrow(TyagError);
    expect(() => parseEnvelope(JSON.stringify({ ...envelope, version: 2 }))).toThrow(TyagError);
    try {
      parseEnvelope(JSON.stringify({ ...envelope, version: 2 }));
    } catch (error) {
      expect((error as TyagError).code).toBe('IMPORT_UNSUPPORTED_VERSION');
    }
    expect(() => parseEnvelope(JSON.stringify({ ...envelope, kdf: { ...envelope.kdf, name: 'scrypt' } }))).toThrow(
      TyagError,
    );
    expect(() => parseEnvelope(JSON.stringify({ ...envelope, cipher: { ...envelope.cipher, name: 'AES-CBC' } }))).toThrow(
      TyagError,
    );
    expect(() => parseEnvelope(JSON.stringify({ ...envelope, payload: 5 }))).toThrow(TyagError);
    expect(() => parseEnvelope(JSON.stringify({ ...envelope, kdf: { ...envelope.kdf, salt: 7 } }))).toThrow(
      TyagError,
    );
  });
});
