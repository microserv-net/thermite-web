// THERMITE — THERMITE-ENC v1.
//
// Hybrid encryption, built entirely from Web Crypto primitives. Nothing here is
// invented: a random AES-256-GCM content key encrypts the data, and that key is
// wrapped with the recipient's RSA-OAEP public key. The header is authenticated
// as additional data, so the algorithm, purpose and recipient cannot be swapped
// without the tag failing.
//
//   ┌────────────┬─────────────┬──────────────┬──────────────────────────┐
//   │ "THRMENC1" │ u32be hdrLen│ header (JSON)│ ciphertext ‖ GCM tag     │
//   └────────────┴─────────────┴──────────────┴──────────────────────────┘
//         8 B          4 B          hdrLen                rest
//
//   AAD = everything before the ciphertext.
//
// The header deliberately carries no hash of the plaintext. In a public
// repository that would let anyone confirm a guess at the contents.
//
// The identical format is implemented for the runner in
// build-repo-template/scripts/tenc.mjs. Change one, change both.

import { toBase64, enc, dec, sha256Hex } from './util.js';

export const FORMAT = 'THERMITE-ENC';
export const VERSION = 1;
export const MAGIC = 'THRMENC1';
export const KEM_ALG = 'RSA-OAEP-4096-SHA256';
export const AEAD_ALG = 'AES-256-GCM';

const RSA_PARAMS = {
  name: 'RSA-OAEP',
  modulusLength: 4096,
  publicExponent: new Uint8Array([1, 0, 1]),
  hash: 'SHA-256',
};

export class CryptoError extends Error {}

// ------------------------------------------------------------------ keys ----

export async function generateKeypair() {
  const pair = await crypto.subtle.generateKey(RSA_PARAMS, true, ['encrypt', 'decrypt']);
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey));
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  return {
    keyId: await keyIdOf(spki),
    publicPem: toPem(spki, 'PUBLIC KEY'),
    privatePem: toPem(pkcs8, 'PRIVATE KEY'),
    publicKey: pair.publicKey,
    privateKey: pair.privateKey,
  };
}

export async function keyIdOf(spkiBytes) {
  return (await sha256Hex(spkiBytes)).slice(0, 16);
}

export function toPem(bytes, label) {
  const b64 = toBase64(bytes);
  const wrapped = b64.match(/.{1,64}/g).join('\n');
  return `-----BEGIN ${label}-----\n${wrapped}\n-----END ${label}-----\n`;
}

export function fromPem(pem, label) {
  const re = new RegExp(`-----BEGIN ${label}-----([\\s\\S]*?)-----END ${label}-----`);
  const m = re.exec(String(pem || ''));
  if (!m) throw new CryptoError(`That does not look like a PEM ${label.toLowerCase()}.`);
  const raw = atob(m[1].replace(/\s+/g, ''));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export async function importPublicPem(pem) {
  const spki = fromPem(pem, 'PUBLIC KEY');
  const key = await crypto.subtle.importKey('spki', spki,
    { name: 'RSA-OAEP', hash: 'SHA-256' }, true, ['encrypt'])
    .catch(() => { throw new CryptoError('That public key is not an RSA-OAEP key Thermite can use.'); });
  return { key, keyId: await keyIdOf(spki) };
}

export async function importPrivatePem(pem) {
  const pkcs8 = fromPem(pem, 'PRIVATE KEY');
  const key = await crypto.subtle.importKey('pkcs8', pkcs8,
    { name: 'RSA-OAEP', hash: 'SHA-256' }, true, ['decrypt'])
    .catch(() => { throw new CryptoError('That private key could not be read. Check you pasted the whole PEM block.'); });
  // Derive the matching key id so a mismatched key is caught before decryption.
  const jwk = await crypto.subtle.exportKey('jwk', key);
  const pub = await crypto.subtle.importKey('jwk',
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RSA-OAEP-256', ext: true },
    { name: 'RSA-OAEP', hash: 'SHA-256' }, true, ['encrypt']);
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', pub));
  return { key, keyId: await keyIdOf(spki) };
}

// ------------------------------------------------------------- container ----

function b64(bytes) { return toBase64(bytes); }
function unb64(s) {
  const raw = atob(s);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function frame(headerObj, ciphertext) {
  const header = enc.encode(JSON.stringify(headerObj));
  const out = new Uint8Array(8 + 4 + header.length + ciphertext.length);
  out.set(enc.encode(MAGIC), 0);
  new DataView(out.buffer).setUint32(8, header.length, false);
  out.set(header, 12);
  out.set(ciphertext, 12 + header.length);
  return out;
}

export function parseHeader(container) {
  if (container.length < 13) throw new CryptoError('This is not a Thermite container.');
  if (dec.decode(container.subarray(0, 8)) !== MAGIC) {
    throw new CryptoError('This file is not a THERMITE-ENC container.');
  }
  const headerLen = new DataView(container.buffer, container.byteOffset).getUint32(8, false);
  if (headerLen > 64 * 1024 || 12 + headerLen > container.length) {
    throw new CryptoError('This container\u2019s header is malformed.');
  }
  let header;
  try { header = JSON.parse(dec.decode(container.subarray(12, 12 + headerLen))); }
  catch { throw new CryptoError('This container\u2019s header is not readable.'); }
  if (header.format !== FORMAT || header.version !== VERSION) {
    throw new CryptoError(`Unsupported container: ${header.format} v${header.version}. This build of Thermite reads ${FORMAT} v${VERSION}.`);
  }
  return {
    header,
    aad: container.subarray(0, 12 + headerLen),
    ciphertext: container.subarray(12 + headerLen),
  };
}

/**
 * @param {Uint8Array} plaintext
 * @param {{key:CryptoKey, keyId:string}} recipient
 * @param {{purpose:string, jobId:string, compression?:'gzip'|'none', note?:string}} ctx
 */
export async function seal(plaintext, recipient, ctx) {
  let body = plaintext;
  let compression = 'none';
  if (ctx.compression !== 'none' && typeof CompressionStream !== 'undefined') {
    const stream = new Blob([plaintext]).stream().pipeThrough(new CompressionStream('gzip'));
    body = new Uint8Array(await new Response(stream).arrayBuffer());
    compression = 'gzip';
  }

  const cek = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const rawCek = new Uint8Array(await crypto.subtle.exportKey('raw', cek));
  const wrapped = new Uint8Array(await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, recipient.key, rawCek));

  const header = {
    format: FORMAT,
    version: VERSION,
    purpose: ctx.purpose,
    jobId: ctx.jobId || null,
    kem: { alg: KEM_ALG, keyId: recipient.keyId, wrappedKey: b64(wrapped) },
    aead: { alg: AEAD_ALG, iv: b64(iv), tagBits: 128 },
    payload: { compression, bytes: plaintext.length },
    createdAt: new Date().toISOString(),
    note: ctx.note || undefined,
  };

  // The header must be byte-identical between AAD computation and framing, so
  // it is serialised once and reused.
  const headerBytes = enc.encode(JSON.stringify(header));
  const aad = new Uint8Array(12 + headerBytes.length);
  aad.set(enc.encode(MAGIC), 0);
  new DataView(aad.buffer).setUint32(8, headerBytes.length, false);
  aad.set(headerBytes, 12);

  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, cek, body));

  const out = new Uint8Array(aad.length + ciphertext.length);
  out.set(aad, 0);
  out.set(ciphertext, aad.length);
  return out;
}

/**
 * @param {Uint8Array} container
 * @param {{key:CryptoKey, keyId:string}} recipient  the private key holder
 */
export async function unseal(container, recipient) {
  const { header, aad, ciphertext } = parseHeader(container);

  if (header.kem?.alg !== KEM_ALG) throw new CryptoError(`Unsupported key wrapping: ${header.kem?.alg}`);
  if (header.aead?.alg !== AEAD_ALG) throw new CryptoError(`Unsupported cipher: ${header.aead?.alg}`);
  if (recipient.keyId && header.kem.keyId !== recipient.keyId) {
    throw new CryptoError(
      `This was sealed for key ${header.kem.keyId}, but the key you loaded is ${recipient.keyId}. ` +
      'Load the private key that matches this pour.');
  }

  let rawCek;
  try {
    rawCek = await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, recipient.key, unb64(header.kem.wrappedKey));
  } catch {
    throw new CryptoError('The content key could not be unwrapped with this private key.');
  }
  const cek = await crypto.subtle.importKey('raw', rawCek, { name: 'AES-GCM' }, false, ['decrypt']);

  let body;
  try {
    body = new Uint8Array(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: unb64(header.aead.iv), additionalData: aad, tagLength: 128 },
      cek, ciphertext));
  } catch {
    // GCM failing is either tampering or corruption. It is never "wrong password".
    throw new CryptoError('Authentication failed. This container has been modified or truncated — it is not safe to use.');
  }

  if (header.payload?.compression === 'gzip') {
    const stream = new Blob([body]).stream().pipeThrough(new DecompressionStream('gzip'));
    body = new Uint8Array(await new Response(stream).arrayBuffer());
  }
  if (header.payload?.bytes != null && body.length !== header.payload.bytes) {
    throw new CryptoError('The decrypted payload is not the length it claims to be.');
  }
  return { bytes: body, header };
}

// ------------------------------------------------------------- bundling -----

/** Pack a set of source files into one payload. Paths are validated upstream. */
export function packCharge(files) {
  return enc.encode(JSON.stringify({
    kind: 'thermite-charge', version: 1,
    files: files.map((f) => ({ path: f.path, data: toBase64(f.bytes) })),
  }));
}

export { frame };
