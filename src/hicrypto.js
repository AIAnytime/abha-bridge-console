import crypto from 'node:crypto';

// ABDM health-information data encryption:
//   key agreement : X25519 (Curve25519 ECDH)
//   KDF           : HKDF-SHA256 over the shared secret
//   salt          : first 20 bytes of (senderNonce XOR receiverNonce)
//   IV            : last 12 bytes of  (senderNonce XOR receiverNonce)
//   cipher        : AES-256-GCM (16-byte tag appended to ciphertext)
// XOR of nonces and ECDH are both symmetric, so sender and receiver derive the
// same key/IV independently.

const SPKI_X25519_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');

/** Generate an ephemeral X25519 key pair + 32-byte nonce (HIU key material). */
export function generateKeyMaterial() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  const rawPub = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicKeyB64: rawPub.toString('base64'), // raw 32-byte key
    nonceB64: crypto.randomBytes(32).toString('base64'),
  };
}

/** Wrap a remote X25519 public key (raw 32-byte OR DER SPKI, base64) into a KeyObject. */
function toPublicKey(b64) {
  const buf = Buffer.from(b64, 'base64');
  const der = buf.length === 32 ? Buffer.concat([SPKI_X25519_PREFIX, buf]) : buf;
  return crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
}

function toPrivateKey(pem) {
  return crypto.createPrivateKey(pem);
}

/** Derive AES-256 key + 12-byte IV from the shared secret and the two nonces. */
function deriveKeyIv(sharedSecret, ownNonceB64, remoteNonceB64) {
  const a = Buffer.from(ownNonceB64, 'base64');
  const b = Buffer.from(remoteNonceB64, 'base64');
  const n = Math.max(a.length, b.length);
  const xor = Buffer.alloc(n);
  for (let i = 0; i < n; i++) xor[i] = (a[i] || 0) ^ (b[i] || 0);
  const salt = xor.subarray(0, 20);
  const iv = xor.subarray(n - 12); // last 12 bytes
  const key = Buffer.from(crypto.hkdfSync('sha256', sharedSecret, salt, Buffer.alloc(0), 32));
  return { key, iv };
}

function sharedSecret(ownPrivatePem, remotePublicB64) {
  return crypto.diffieHellman({
    privateKey: toPrivateKey(ownPrivatePem),
    publicKey: toPublicKey(remotePublicB64),
  });
}

/** Decrypt a base64 content blob pushed by the HIP. */
export function decrypt({ content, ownPrivateKeyPem, ownNonceB64, remotePublicKeyB64, remoteNonceB64 }) {
  const secret = sharedSecret(ownPrivateKeyPem, remotePublicKeyB64);
  const { key, iv } = deriveKeyIv(secret, ownNonceB64, remoteNonceB64);
  const data = Buffer.from(content, 'base64');
  const tag = data.subarray(data.length - 16);
  const ct = data.subarray(0, data.length - 16);
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

/** Encrypt plaintext for a peer — used by the round-trip self-test (and if we ever act as HIP). */
export function encrypt({ plaintext, ownPrivateKeyPem, ownNonceB64, remotePublicKeyB64, remoteNonceB64 }) {
  const secret = sharedSecret(ownPrivateKeyPem, remotePublicKeyB64);
  const { key, iv } = deriveKeyIv(secret, ownNonceB64, remoteNonceB64);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(Buffer.from(plaintext, 'utf8')), c.final()]);
  return Buffer.concat([ct, c.getAuthTag()]).toString('base64');
}
