import crypto from 'node:crypto';
import { getConfig } from './db.js';
import { request } from './abdm.js';

let cached = { key: null, at: 0 };
const TTL = 30 * 60 * 1000; // 30 min

function abhaBase() {
  return (getConfig('abhaBase') || 'https://abhasbx.abdm.gov.in/abha/api/v3').replace(/\/+$/, '');
}

function toPem(b64) {
  const body = b64.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  return '-----BEGIN PUBLIC KEY-----\n' + body.match(/.{1,64}/g).join('\n') + '\n-----END PUBLIC KEY-----\n';
}

/** Fetch (and cache) ABDM's public certificate as a KeyObject. */
export async function getPublicKey(force = false) {
  if (!force && cached.key && Date.now() - cached.at < TTL) return cached.key;
  const { ok, status, body } = await request({
    method: 'GET',
    path: abhaBase() + '/profile/public/certificate',
    auth: true,
    standard: true,
  });
  const raw = body && (body.publicKey || body.certificate || (typeof body === 'string' ? body : null));
  if (!ok || !raw) throw new Error(`Could not fetch public certificate (HTTP ${status}).`);
  const key = crypto.createPublicKey(toPem(raw));
  cached = { key, at: Date.now() };
  return key;
}

/**
 * Encrypt a value with ABDM's public key.
 * ABDM uses RSA/ECB/OAEPWithSHA-1AndMGF1Padding (verified empirically against the sandbox).
 */
export async function encryptRSA(plaintext) {
  const key = await getPublicKey();
  return crypto.publicEncrypt(
    { key, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha1' },
    Buffer.from(String(plaintext), 'utf8')
  ).toString('base64');
}
