import { randomUUID } from 'node:crypto';
import {
  getConfig, saveHiRequest, setHiTransaction, getHiRequestByTxn, saveHiData,
} from './db.js';
import { request } from './abdm.js';
import { generateKeyMaterial } from './hicrypto.js';
import { decrypt } from './hicrypto.js';

function dataPushUrl() {
  const base = (getConfig('bridgeUrl') || '').replace(/\/+$/, '');
  if (!base) throw new Error('Set your public Bridge URL (Settings) first — the HIP pushes data there.');
  return base + '/hi/transfer';
}

/**
 * HIU: request health information for a granted consent.
 * Generates ephemeral X25519 key material, stores our private key against the
 * outgoing requestId, and posts the request to the gateway.
 */
export async function requestHealthInformation({ consentId, from, to }) {
  if (!consentId) throw new Error('consentId is required (a granted consent artefact id).');
  const now = new Date();
  const km = generateKeyMaterial();
  const requestId = randomUUID();
  const fromDate = from || new Date(now.getTime() - 365 * 24 * 3600 * 1000).toISOString();
  const toDate = to || now.toISOString();

  const body = {
    requestId,
    timestamp: new Date().toISOString(),
    hiRequest: {
      consent: { id: consentId },
      dateRange: { from: fromDate, to: toDate },
      dataPushUrl: dataPushUrl(),
      keyMaterial: {
        cryptoAlg: 'ECDH',
        curve: 'Curve25519',
        dhPublicKey: {
          expiry: new Date(now.getTime() + 24 * 3600 * 1000).toISOString(),
          parameters: 'Curve25519/32byte random key',
          keyValue: km.publicKeyB64,
        },
        nonce: km.nonceB64,
      },
    },
  };

  saveHiRequest({
    requestId, consentId, from: fromDate, to: toDate, status: 'REQUESTED',
    privateKey: km.privateKeyPem, publicKey: km.publicKeyB64, nonce: km.nonceB64,
  });

  const r = await request({ method: 'POST', path: '/v0.5/health-information/cm/request', body, auth: true, standard: true });
  return { requestId, request: body, response: r };
}

/**
 * Gateway → HIU callback: /v0.5/health-information/hiu/on-request.
 * Correlates the assigned transactionId back to our stored key material.
 */
export function handleOnRequest(body) {
  // ABDM correlates via the `resp.requestId` envelope field; accept `response`
  // too for tolerance against older/simulated payloads.
  const incomingReqId = body?.resp?.requestId ?? body?.response?.requestId;
  const txn = body?.hiRequest?.transactionId || body?.transactionId;
  const status = body?.hiRequest?.sessionStatus || (body?.error ? 'ERRORED' : 'ACKNOWLEDGED');
  if (incomingReqId && txn) setHiTransaction(incomingReqId, txn, status);
  return { requestId: incomingReqId, transactionId: txn, status };
}

/**
 * HIP → HIU data push (arrives at dataPushUrl). Decrypts every entry with the
 * key material we stored for this transaction and persists the FHIR bundles.
 */
export function handleDataPush(body) {
  const transactionId = body?.transactionId;
  const req = transactionId ? getHiRequestByTxn(transactionId) : null;
  if (!req) {
    saveHiData({ transactionId, error: 'No matching HI request / key material for this transactionId.' });
    return { transactionId, stored: 0, error: 'unknown transactionId' };
  }

  const remote = body?.keyMaterial || {};
  const remotePublicKeyB64 = remote?.dhPublicKey?.keyValue;
  const remoteNonceB64 = remote?.nonce;
  const entries = body?.entries || [];
  let stored = 0;

  for (const e of entries) {
    // Entry may carry inline `content` or a `link` to fetch; we handle inline content.
    if (e.content == null) {
      saveHiData({ transactionId, careContext: e.careContextReference, media: e.media, checksum: e.checksum,
        error: e.link ? `Entry uses link (${e.link}); inline content expected.` : 'Entry has no content.' });
      continue;
    }
    try {
      const decrypted = decrypt({
        content: e.content,
        ownPrivateKeyPem: req.private_key,
        ownNonceB64: req.nonce,
        remotePublicKeyB64,
        remoteNonceB64,
      });
      saveHiData({ transactionId, careContext: e.careContextReference, media: e.media, checksum: e.checksum, decrypted });
      stored++;
    } catch (err) {
      saveHiData({ transactionId, careContext: e.careContextReference, media: e.media, checksum: e.checksum,
        error: 'Decryption failed: ' + err.message });
    }
  }

  // Acknowledge receipt to the gateway (best-effort).
  const ackBody = {
    requestId: randomUUID(),
    timestamp: new Date().toISOString(),
    notification: {
      consentId: req.consent_id,
      transactionId,
      doneAt: new Date().toISOString(),
      notifier: { type: 'HIU', id: getConfig('clientId') },
      statusNotification: {
        sessionStatus: stored === entries.length ? 'TRANSFERRED' : 'PARTIALLY_TRANSFERRED',
        hipId: body?.hipId || null,
        statusResponses: entries.map((e) => ({ careContextReference: e.careContextReference, hiStatus: 'OK', description: 'ok' })),
      },
    },
  };
  request({ method: 'POST', path: '/v0.5/health-information/notify', body: ackBody, auth: true, standard: true }).catch(() => {});

  return { transactionId, stored, total: entries.length };
}
