import { randomUUID } from 'node:crypto';
import { getConfig, saveConsentEvent, markConsentAcknowledged } from './db.js';
import { request } from './abdm.js';

// Pull a consent id from any of the shapes ABDM uses across HIP/HIU notifications.
function extractConsentIds(body) {
  const ids = new Set();
  const n = body?.notification || body || {};
  const push = (v) => v && ids.add(v);
  push(n.consentId);
  push(n.consentDetail?.consentId);
  push(n.consentRequestId);
  push(body?.consentRequestId);
  push(body?.consentRequest?.id);
  for (const a of n.consentArtefacts || []) push(a.id || a.consentId);
  return [...ids];
}

/**
 * Classify an inbound callback by its URL + body.
 * Matches keyword-wise so it works for both /v0.5/* and /api/v3/* callback paths.
 */
export function classify(url, body) {
  const u = String(url).toLowerCase();
  const n = body?.notification || body || {};
  const status = n.status || body?.status || null;
  const ids = extractConsentIds(body);
  const requestId = body?.requestId || null;
  const has = (...w) => w.every((x) => u.includes(x));

  let role = null, type = 'UNKNOWN', ackPath = null;

  if (has('consent', 'hip', 'notify')) {
    role = 'HIP'; type = 'HIP_CONSENT_NOTIFY'; ackPath = '/v0.5/consents/hip/on-notify';
  } else if (has('consent', 'hiu', 'notify')) {
    role = 'HIU'; type = 'HIU_CONSENT_NOTIFY'; ackPath = '/v0.5/consents/hiu/on-notify';
  } else if (has('consent-requests', 'on-init') || has('consent', 'request', 'on-init')) {
    role = 'HIU'; type = 'HIU_CONSENT_REQUEST_ON_INIT'; // response, no ack
  } else if (has('consents', 'on-fetch')) {
    role = 'HIU'; type = 'HIU_CONSENT_ON_FETCH';
  } else if (has('consent')) {
    role = u.includes('hip') ? 'HIP' : 'HIU'; type = 'CONSENT_OTHER';
  }

  return { role, type, ackPath, status, consentIds: ids, requestId };
}

/**
 * Build the on-notify acknowledgement body the gateway expects.
 * Both HIP and HIU on-notify take an `acknowledgement` array (one per consentId),
 * and the gateway correlates the callback via the `resp.requestId` envelope field
 * echoing the notification's original requestId (NOT `response` — a mismatch here
 * yields "No mapping found for resp.requestId").
 */
function buildAck(kind, consentIds, incomingRequestId) {
  const oks = consentIds.length ? consentIds : [null];
  return {
    requestId: randomUUID(),
    timestamp: new Date().toISOString(),
    acknowledgement: oks.map((id) => ({ status: 'OK', consentId: id })),
    error: null,
    resp: { requestId: incomingRequestId },
  };
}

/**
 * Handle one inbound ABDM callback: persist it, and if it is a HIP/HIU consent
 * notification, auto-acknowledge via the matching gateway on-* endpoint.
 * @returns summary object for the webhook response + UI.
 */
export async function handleConsentCallback({ url, body }) {
  const c = classify(url, body);
  const eventId = saveConsentEvent({
    role: c.role, type: c.type, consentId: c.consentIds[0] || null,
    requestId: c.requestId, status: c.status, payload: body,
  });

  const autoAck = (getConfig('autoAck') ?? 'true') !== 'false';
  let ack = null;

  if (c.ackPath && autoAck) {
    const ackBody = buildAck(c.role, c.consentIds, c.requestId);
    try {
      const r = await request({ method: 'POST', path: c.ackPath, body: ackBody, auth: true, standard: true });
      ack = { path: c.ackPath, status: r.status, ok: r.ok };
      markConsentAcknowledged(eventId, r.status);
    } catch (e) {
      ack = { path: c.ackPath, error: e.message };
      markConsentAcknowledged(eventId, 0);
    }
  }

  return { eventId, classification: c, ack };
}

/**
 * HIU: initiate a consent request. Builds a sensible default consent object
 * from the supplied fields.
 */
export async function initiateConsentRequest(input) {
  const now = new Date();
  const from = input.from || new Date(now.getTime() - 365 * 24 * 3600 * 1000).toISOString();
  const to = input.to || now.toISOString();
  const eraseAt = input.dataEraseAt || new Date(now.getTime() + 30 * 24 * 3600 * 1000).toISOString();

  const consent = {
    purpose: { text: input.purposeText || 'Care Management', code: input.purposeCode || 'CAREMGT', refUri: 'urn:abdm:templates' },
    patient: { id: input.patientAbhaAddress },
    hiu: { id: input.hiuId || getConfig('clientId') },
    requester: { name: input.requesterName || 'Dr. Demo', identifier: { type: 'REGNO', value: input.requesterId || 'MH1001', system: 'https://www.mciindia.org' } },
    hiTypes: input.hiTypes && input.hiTypes.length ? input.hiTypes : ['OPConsultation', 'Prescription'],
    permission: {
      accessMode: input.accessMode || 'VIEW',
      dateRange: { from, to },
      dataEraseAt: eraseAt,
      frequency: { unit: 'HOUR', value: 1, repeats: 0 },
    },
  };
  if (!consent.patient.id) throw new Error('patientAbhaAddress is required (e.g. name@sbx).');

  const body = { requestId: randomUUID(), timestamp: new Date().toISOString(), consent };
  const r = await request({ method: 'POST', path: '/v0.5/consent-requests/init', body, auth: true, standard: true });
  return { request: body, response: r };
}
