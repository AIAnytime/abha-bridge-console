import { getConfig, saveAbhaProfile } from './db.js';
import { request } from './abdm.js';
import { encryptRSA } from './crypto.js';

function base() {
  return (getConfig('abhaBase') || 'https://abhasbx.abdm.gov.in/abha/api/v3').replace(/\/+$/, '');
}

function nowStamp() {
  // ABDM expects "yyyy-MM-dd HH:mm:ss"
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

/**
 * Step 1 — request an OTP to the Aadhaar-linked mobile.
 * The Aadhaar number is RSA-encrypted before sending.
 * @returns {{ txnId: string, raw: object }}
 */
export async function requestAadhaarOtp(aadhaar) {
  const clean = String(aadhaar).replace(/\s+/g, '');
  if (!/^\d{12}$/.test(clean)) throw new Error('Aadhaar must be 12 digits.');
  const loginId = await encryptRSA(clean);
  const { ok, status, body } = await request({
    method: 'POST',
    path: base() + '/enrollment/request/otp',
    body: { txnId: '', scope: ['abha-enrol'], loginHint: 'aadhaar', loginId, otpSystem: 'aadhaar' },
    auth: true,
    standard: true,
  });
  const txnId = body && body.txnId;
  if (!ok || !txnId) throw new Error(errMsg('OTP request failed', status, body));
  return { txnId, message: body.message, raw: body };
}

/**
 * Step 2 — verify OTP and enrol, creating the ABHA.
 * The OTP is RSA-encrypted before sending. On success the profile is persisted.
 * @returns {{ profile: object, saved: object }}
 */
export async function enrolByAadhaar({ txnId, otp, mobile }) {
  if (!txnId) throw new Error('txnId is required (request an OTP first).');
  if (!/^\d{4,8}$/.test(String(otp || ''))) throw new Error('OTP must be numeric.');
  const otpValue = await encryptRSA(String(otp));
  const payload = {
    authData: {
      authMethods: ['otp'],
      otp: { timeStamp: nowStamp(), txnId, otpValue },
    },
    consent: { code: 'abha-enrollment', version: '1.4' },
  };
  if (mobile) payload.authData.otp.mobile = String(mobile);

  const { ok, status, body } = await request({
    method: 'POST',
    path: base() + '/enrollment/enrol/byAadhaar',
    body: payload,
    auth: true,
    standard: true,
  });
  if (!ok) throw new Error(errMsg('Enrolment failed', status, body));

  const profile = (body && (body.ABHAProfile || body.abhaProfile)) || body || {};
  // carry tokens alongside the profile for later PHR/profile calls
  if (body && body.tokens) profile.tokens = body.tokens;
  const saved = saveAbhaProfile(profile);
  return { profile: body, saved };
}

// ---- Login for EXISTING ABHA users (v3 profile login) ---------------------
// Each method fixes the scope / loginHint / OTP system the gateway expects.
// Values verified live against the sandbox (the gateway rejects any wrong
// scope/loginHint/otpSystem with a field-level 400). ABHA-address is NOT a
// valid loginHint for this OTP endpoint, so it is intentionally omitted.
const LOGIN_METHODS = {
  mobile:        { scope: ['abha-login', 'mobile-verify'],  loginHint: 'mobile',      otpSystem: 'abdm',    label: 'mobile' },
  'abha-number': { scope: ['abha-login', 'mobile-verify'],  loginHint: 'abha-number', otpSystem: 'abdm',    label: 'ABHA number' },
  aadhaar:       { scope: ['abha-login', 'aadhaar-verify'], loginHint: 'aadhaar',     otpSystem: 'aadhaar', label: 'Aadhaar' },
};

/**
 * Login step 1 — request an OTP for an existing ABHA.
 * The identifier (mobile / ABHA number / ABHA address / Aadhaar) is RSA-encrypted.
 * @returns {{ txnId: string }}
 */
export async function loginRequestOtp({ identifier, method = 'mobile' }) {
  const cfg = LOGIN_METHODS[method];
  if (!cfg) throw new Error(`Unsupported login method: ${method}`);
  const id = String(identifier || '').replace(/\s+/g, '');
  if (!id) throw new Error(`Enter your ${cfg.label}.`);
  if (method === 'mobile' && !/^\d{10}$/.test(id)) throw new Error('Mobile must be 10 digits.');
  if (method === 'aadhaar' && !/^\d{12}$/.test(id)) throw new Error('Aadhaar must be 12 digits.');
  if (method === 'abha-number' && !/^\d{14}$/.test(id.replace(/-/g, ''))) throw new Error('ABHA number must be 14 digits.');

  const loginId = await encryptRSA(id.replace(/-/g, ''));
  const { ok, status, body } = await request({
    method: 'POST',
    path: base() + '/profile/login/request/otp',
    body: { scope: cfg.scope, loginHint: cfg.loginHint, loginId, otpSystem: cfg.otpSystem },
    auth: true, standard: true,
  });
  const txnId = body && body.txnId;
  if (!ok || !txnId) throw new Error(errMsg('Login OTP request failed', status, body));
  return { txnId, message: body.message, raw: body };
}

/**
 * Login step 2 — verify the OTP and log in.
 * On success the returned ABHA account(s) are persisted (with the auth token).
 * A mobile that maps to multiple ABHAs returns an `accounts` list to choose from.
 * @returns {{ accounts, saved, tokenPreview, response }}
 */
export async function loginVerify({ txnId, otp, method = 'mobile' }) {
  const cfg = LOGIN_METHODS[method];
  if (!cfg) throw new Error(`Unsupported login method: ${method}`);
  if (!txnId) throw new Error('txnId is required (request a login OTP first).');
  if (!/^\d{4,8}$/.test(String(otp || ''))) throw new Error('OTP must be numeric.');

  const otpValue = await encryptRSA(String(otp));
  const { ok, status, body } = await request({
    method: 'POST',
    path: base() + '/profile/login/verify',
    body: { scope: cfg.scope, authData: { authMethods: ['otp'], otp: { txnId, otpValue } } },
    auth: true, standard: true,
  });
  if (!ok) throw new Error(errMsg('Login verification failed', status, body));

  const token = body && (body.token || (body.tokens && body.tokens.token));
  const accounts = (body && body.accounts) || [];
  let saved = 0;
  if (accounts.length) {
    for (const a of accounts) { saveAbhaProfile({ ...a, xToken: token }); saved++; }
  } else if (body && (body.ABHANumber || body.abhaNumber || body.preferredAbhaAddress)) {
    saveAbhaProfile({ ...body, xToken: token }); saved++;
  }
  return { ok: true, accounts, saved, tokenPreview: token ? String(token).slice(0, 12) + '…' : null, response: body };
}

/** Get available ABHA-address suggestions for a transaction. */
export async function abhaAddressSuggestions(txnId) {
  const { ok, status, body } = await request({
    method: 'GET',
    path: base() + '/enrollment/enrol/suggestion',
    headers: { 'Transaction-Id': txnId },
    auth: true,
    standard: true,
  });
  if (!ok) throw new Error(errMsg('Suggestion fetch failed', status, body));
  return body;
}

function errMsg(prefix, status, body) {
  let detail = body;
  if (body && body.error) detail = body.error.message || JSON.stringify(body.error);
  else if (typeof body === 'object') detail = JSON.stringify(body);
  return `${prefix} (HTTP ${status}): ${detail}`;
}
