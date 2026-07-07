import { randomUUID } from 'node:crypto';
import { getConfig, saveSession, getValidAccessToken, logApi } from './db.js';

function base() {
  return (getConfig('gatewayBase') || 'https://dev.abdm.gov.in/gateway').replace(/\/+$/, '');
}

// Build an absolute URL from a path that may be relative to the gateway base.
export function resolveUrl(path) {
  if (/^https?:\/\//i.test(path)) return path;
  return base() + '/' + String(path).replace(/^\/+/, '');
}

// Standard ABDM gateway headers (request tracing + consent-manager id).
function standardHeaders() {
  return {
    'REQUEST-ID': randomUUID(),
    TIMESTAMP: new Date().toISOString(),
    'X-CM-ID': getConfig('xCmId') || 'sbx',
  };
}

async function parseBody(res) {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Core request helper. Logs every call to the DB.
 * @param {object} opts
 * @param {string} opts.method
 * @param {string} opts.path        relative to gateway base, or absolute
 * @param {object} [opts.body]
 * @param {object} [opts.headers]   extra headers
 * @param {boolean} [opts.auth]     attach bearer token (default true)
 * @param {boolean} [opts.standard] attach REQUEST-ID/TIMESTAMP/X-CM-ID (default true)
 */
export async function request({ method = 'GET', path, body, headers = {}, auth = true, standard = true }) {
  const url = resolveUrl(path);
  const finalHeaders = {
    accept: 'application/json',
    ...(standard ? standardHeaders() : {}),
    ...headers,
  };

  if (body !== undefined && body !== null && !finalHeaders['Content-Type'] && !finalHeaders['content-type']) {
    finalHeaders['Content-Type'] = 'application/json';
  }

  if (auth) {
    const token = getValidAccessToken();
    if (!token) {
      const err = 'No valid session token. Fetch a gateway session first.';
      logApi({ direction: 'outbound', method, url, error: err, reqHeaders: finalHeaders, reqBody: body });
      const e = new Error(err);
      e.code = 'NO_TOKEN';
      throw e;
    }
    finalHeaders.Authorization = `Bearer ${token}`;
  }

  const payload = body !== undefined && body !== null
    ? (typeof body === 'string' ? body : JSON.stringify(body))
    : undefined;

  // Redact secrets in stored headers.
  const safeHeaders = { ...finalHeaders };
  if (safeHeaders.Authorization) safeHeaders.Authorization = 'Bearer ***';

  let res, respBody, status = null, errMsg = null;
  try {
    res = await fetch(url, { method, headers: finalHeaders, body: payload });
    status = res.status;
    respBody = await parseBody(res);
  } catch (e) {
    errMsg = e.message;
  }

  logApi({
    direction: 'outbound',
    method,
    url,
    status,
    reqHeaders: safeHeaders,
    reqBody: body ?? null,
    respBody: respBody ?? null,
    error: errMsg,
  });

  if (errMsg) {
    const e = new Error(errMsg);
    e.code = 'NETWORK';
    throw e;
  }

  return { ok: res.ok, status, body: respBody };
}

/**
 * Fetch a gateway session token using clientId/clientSecret and persist it.
 */
export async function fetchSession() {
  const clientId = getConfig('clientId');
  const clientSecret = getConfig('clientSecret');
  if (!clientId || !clientSecret) {
    throw new Error('clientId / clientSecret not configured. Set them in Settings.');
  }
  const path = getConfig('sessionPath') || '/v1/sessions';
  const { ok, status, body } = await request({
    method: 'POST',
    path,
    body: { clientId, clientSecret },
    auth: false,
    standard: true,
  });

  const token = body && (body.accessToken || body.access_token);
  if (!ok || !token) {
    const msg = typeof body === 'string' ? body : JSON.stringify(body);
    throw new Error(`Session request failed (HTTP ${status}): ${msg}`);
  }
  return saveSession(body);
}

// ---- convenience wrappers for the bridge setup steps in creds.txt ---------

export function patchBridgeUrl(url) {
  return request({ method: 'PATCH', path: '/v1/bridges', body: { url } });
}

export function addUpdateServices(services) {
  return request({ method: 'POST', path: '/v1/bridges/addUpdateServices', body: services });
}

export function getBridgeServices() {
  return request({ method: 'GET', path: '/v1/bridges/getServices' });
}
