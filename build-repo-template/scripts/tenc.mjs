// THERMITE — THERMITE-ENC v1, runner side.
//
// The exact format implemented in js/crypto.js. Change one, change both.
//
//   ┌────────────┬─────────────┬──────────────┬──────────────────────────┐
//   │ "THRMENC1" │ u32be hdrLen│ header (JSON)│ ciphertext ‖ GCM tag     │
//   └────────────┴─────────────┴──────────────┴──────────────────────────┘
//
// Web Crypto appends the 16-byte GCM tag to the ciphertext; Node keeps it
// separate, so it is split off on decrypt and appended on encrypt.

import {
  publicEncrypt, privateDecrypt, constants, randomBytes,
  createCipheriv, createDecipheriv, createHash, createPublicKey,
} from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';

export const FORMAT = 'THERMITE-ENC';
export const VERSION = 1;
export const MAGIC = 'THRMENC1';
export const KEM_ALG = 'RSA-OAEP-4096-SHA256';
export const AEAD_ALG = 'AES-256-GCM';
const TAG_BYTES = 16;

export class TencError extends Error {}

export function keyIdOfPublicPem(pem) {
  const spki = createPublicKey(pem).export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(spki).digest('hex').slice(0, 16);
}

function assemble(header, ciphertext) {
  const headerBytes = Buffer.from(JSON.stringify(header), 'utf8');
  const prefix = Buffer.alloc(12);
  prefix.write(MAGIC, 0, 'ascii');
  prefix.writeUInt32BE(headerBytes.length, 8);
  const aad = Buffer.concat([prefix, headerBytes]);
  return { aad, container: Buffer.concat([aad, ciphertext]) };
}

export function parse(container) {
  const buf = Buffer.isBuffer(container) ? container : Buffer.from(container);
  if (buf.length < 13) throw new TencError('not a Thermite container');
  if (buf.subarray(0, 8).toString('ascii') !== MAGIC) throw new TencError('not a THERMITE-ENC container');
  const headerLen = buf.readUInt32BE(8);
  if (headerLen > 65536 || 12 + headerLen > buf.length) throw new TencError('malformed container header');
  const header = JSON.parse(buf.subarray(12, 12 + headerLen).toString('utf8'));
  if (header.format !== FORMAT || header.version !== VERSION) {
    throw new TencError(`unsupported container ${header.format} v${header.version}`);
  }
  return { header, aad: buf.subarray(0, 12 + headerLen), ciphertext: buf.subarray(12 + headerLen) };
}

/**
 * @param {Buffer} plaintext
 * @param {string} publicPem  recipient's SPKI PEM
 * @param {{purpose:string, jobId:string, compression?:'gzip'|'none', note?:string}} ctx
 */
export function seal(plaintext, publicPem, ctx) {
  const useGzip = ctx.compression !== 'none';
  const body = useGzip ? gzipSync(plaintext, { level: 9 }) : plaintext;

  const cek = randomBytes(32);
  const iv = randomBytes(12);
  const wrapped = publicEncrypt(
    { key: publicPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    cek);

  const header = {
    format: FORMAT,
    version: VERSION,
    purpose: ctx.purpose,
    jobId: ctx.jobId || null,
    kem: { alg: KEM_ALG, keyId: keyIdOfPublicPem(publicPem), wrappedKey: wrapped.toString('base64') },
    aead: { alg: AEAD_ALG, iv: iv.toString('base64'), tagBits: 128 },
    payload: { compression: useGzip ? 'gzip' : 'none', bytes: plaintext.length },
    createdAt: new Date().toISOString(),
    ...(ctx.note ? { note: ctx.note } : {}),
  };

  const headerBytes = Buffer.from(JSON.stringify(header), 'utf8');
  const prefix = Buffer.alloc(12);
  prefix.write(MAGIC, 0, 'ascii');
  prefix.writeUInt32BE(headerBytes.length, 8);
  const aad = Buffer.concat([prefix, headerBytes]);

  const cipher = createCipheriv('aes-256-gcm', cek, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad);
  const ct = Buffer.concat([cipher.update(body), cipher.final()]);
  // Match Web Crypto's layout: tag appended to the ciphertext.
  return Buffer.concat([aad, ct, cipher.getAuthTag()]);
}

/**
 * @param {Buffer} container
 * @param {string} privatePem  PKCS#8 PEM
 */
export function unseal(container, privatePem) {
  const { header, aad, ciphertext } = parse(container);
  if (header.kem?.alg !== KEM_ALG) throw new TencError(`unsupported key wrapping ${header.kem?.alg}`);
  if (header.aead?.alg !== AEAD_ALG) throw new TencError(`unsupported cipher ${header.aead?.alg}`);
  if (ciphertext.length < TAG_BYTES) throw new TencError('container truncated');

  let cek;
  try {
    cek = privateDecrypt(
      { key: privatePem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      Buffer.from(header.kem.wrappedKey, 'base64'));
  } catch {
    throw new TencError(
      'the content key could not be unwrapped — the private key in THERMITE_SOURCE_KEY does not match ' +
      `the public key this pour was sealed for (${header.kem.keyId})`);
  }

  const tag = ciphertext.subarray(ciphertext.length - TAG_BYTES);
  const ct = ciphertext.subarray(0, ciphertext.length - TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', cek, Buffer.from(header.aead.iv, 'base64'),
    { authTagLength: TAG_BYTES });
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);

  let body;
  try { body = Buffer.concat([decipher.update(ct), decipher.final()]); }
  catch { throw new TencError('authentication failed — the container was modified or corrupted'); }

  if (header.payload?.compression === 'gzip') body = gunzipSync(body);
  if (header.payload?.bytes != null && body.length !== header.payload.bytes) {
    throw new TencError('decrypted payload length does not match the header');
  }
  return { bytes: body, header };
}
