import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

import {
  seedConfig, getConfig, setConfig, getAllConfig,
  getLatestSession, getLogs, logApi,
  upsertService, getServices,
  getAbhaProfiles, getConsentEvents, getHiRequests, getHiData,
} from './db.js';
import {
  fetchSession, request, patchBridgeUrl, addUpdateServices, getBridgeServices,
} from './abdm.js';
import { requestAadhaarOtp, enrolByAadhaar, abhaAddressSuggestions, loginRequestOtp, loginVerify } from './abha.js';
import { handleConsentCallback, initiateConsentRequest } from './consent.js';
import { requestHealthInformation, handleOnRequest, handleDataPush } from './hi.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---- minimal .env loader (no dependency) ----------------------------------
function loadEnv() {
  try {
    const txt = readFileSync(join(__dirname, '..', '.env'), 'utf8');
    for (const line of txt.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    }
  } catch { /* no .env, fine */ }
}
loadEnv();
seedConfig(process.env);

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.text({ type: ['text/*', 'application/xml'], limit: '2mb' }));

// ---------------------------------------------------------------------------
// Webhook inbox: ABDM calls back into the bridge here. Catch everything and
// persist it so it shows up in the UI. Always answer 200/202 quickly.
// ---------------------------------------------------------------------------
app.all('/webhook/*', async (req, res) => {
  logApi({
    direction: 'inbound',
    method: req.method,
    url: req.originalUrl,
    status: 202,
    reqHeaders: req.headers,
    reqBody: req.body ?? null,
    respBody: null,
  });

  const u = String(req.originalUrl).toLowerCase();
  try {
    // Consent notifications: classify, persist, auto-acknowledge.
    if (u.includes('consent') && req.method === 'POST') {
      const result = await handleConsentCallback({ url: req.originalUrl, body: req.body });
      return res.status(202).json({ received: true, ...result });
    }
    // Health-information on-request callback: correlate the assigned transactionId.
    if (u.includes('health-information') && u.includes('on-request') && req.method === 'POST') {
      return res.status(202).json({ received: true, hi: handleOnRequest(req.body) });
    }
    // Health-information data push routed through /webhook (also handled at /hi/transfer).
    if (u.includes('health-information') && (u.includes('transfer') || req.body?.entries)) {
      return res.status(202).json({ received: true, hi: handleDataPush(req.body) });
    }
  } catch (e) {
    return res.status(202).json({ received: true, error: e.message });
  }
  res.status(202).json({ received: true });
});

// Dedicated public endpoint the HIP pushes encrypted health data to (dataPushUrl).
app.post('/hi/transfer', (req, res) => {
  logApi({ direction: 'inbound', method: 'POST', url: req.originalUrl, status: 202, reqHeaders: req.headers, reqBody: req.body ?? null });
  try {
    res.status(202).json({ received: true, hi: handleDataPush(req.body) });
  } catch (e) {
    res.status(202).json({ received: true, error: e.message });
  }
});

// ---------------------------------------------------------------------------
// API for the web UI
// ---------------------------------------------------------------------------
const api = express.Router();

function wrap(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (e) {
      res.status(400).json({ error: e.message, code: e.code });
    }
  };
}

// --- config / settings ---
const CONFIG_KEYS = ['clientId', 'clientSecret', 'gatewayBase', 'sessionPath', 'xCmId', 'bridgeUrl'];

api.get('/config', (req, res) => {
  const cfg = Object.fromEntries(getAllConfig().map((r) => [r.key, r.value]));
  // Never ship the raw secret to the browser; send a masked hint instead.
  if (cfg.clientSecret) {
    cfg.clientSecretSet = true;
    cfg.clientSecret = cfg.clientSecret.slice(0, 4) + '…' + cfg.clientSecret.slice(-4);
  } else {
    cfg.clientSecretSet = false;
  }
  res.json(cfg);
});

api.post('/config', (req, res) => {
  for (const key of CONFIG_KEYS) {
    if (key in req.body) {
      // Ignore the masked secret placeholder so we don't clobber the real value.
      if (key === 'clientSecret' && String(req.body[key]).includes('…')) continue;
      if (key === 'clientSecret' && req.body[key] === '') continue;
      setConfig(key, req.body[key]);
    }
  }
  res.json({ ok: true });
});

// --- session ---
api.get('/session', (req, res) => {
  const s = getLatestSession();
  if (!s) return res.json({ hasSession: false });
  res.json({
    hasSession: true,
    tokenType: s.token_type,
    expiresAt: s.expires_at,
    expiresIn: s.expires_in,
    createdAt: s.created_at,
    valid: s.expires_at ? Date.now() < s.expires_at - 30000 : true,
    tokenPreview: s.access_token ? s.access_token.slice(0, 12) + '…' : null,
  });
});

api.post('/session', wrap(async (req, res) => {
  const s = await fetchSession();
  res.json({ ok: true, expiresIn: s.expires_in, expiresAt: s.expires_at });
}));

// --- bridge setup ---
api.post('/bridge/url', wrap(async (req, res) => {
  const url = req.body.url || getConfig('bridgeUrl');
  if (!url) throw new Error('No bridge URL provided.');
  setConfig('bridgeUrl', url);
  const r = await patchBridgeUrl(url);
  res.json(r);
}));

api.post('/bridge/services', wrap(async (req, res) => {
  const services = Array.isArray(req.body) ? req.body : req.body.services;
  if (!Array.isArray(services) || !services.length) throw new Error('Provide a non-empty services array.');
  const r = await addUpdateServices(services);
  if (r.ok || r.status < 300) services.forEach((s) => s.id && upsertService(s));
  res.json(r);
}));

api.get('/bridge/services', wrap(async (req, res) => {
  const r = await getBridgeServices();
  res.json({ remote: r, cached: getServices() });
}));

// --- generic API console: fire any authenticated ABDM call ---
api.post('/call', wrap(async (req, res) => {
  const { method = 'GET', path, body, auth = true, standard = true } = req.body;
  if (!path) throw new Error('path is required.');
  const r = await request({ method, path, body, auth, standard });
  res.json(r);
}));

// --- ABHA enrolment (Aadhaar OTP) ---
api.post('/abha/otp', wrap(async (req, res) => {
  const r = await requestAadhaarOtp(req.body.aadhaar);
  res.json(r); // { txnId, message }
}));

api.post('/abha/enrol', wrap(async (req, res) => {
  const { txnId, otp, mobile } = req.body;
  const r = await enrolByAadhaar({ txnId, otp, mobile });
  res.json({ ok: true, profile: r.profile, saved: r.saved });
}));

api.get('/abha/suggestions', wrap(async (req, res) => {
  res.json(await abhaAddressSuggestions(req.query.txnId));
}));

// --- ABHA login (existing user) ---
api.post('/abha/login/otp', wrap(async (req, res) => {
  res.json(await loginRequestOtp(req.body));
}));

api.post('/abha/login/verify', wrap(async (req, res) => {
  res.json(await loginVerify(req.body));
}));

api.get('/abha/profiles', (req, res) => res.json(getAbhaProfiles()));

// --- consent (HIU initiate + event log) ---
api.post('/consent/init', wrap(async (req, res) => {
  const r = await initiateConsentRequest(req.body);
  res.json(r);
}));

api.get('/consent/events', (req, res) => res.json(getConsentEvents(200)));

// --- health information (M3: fetch a user's health data) ---
api.post('/hi/request', wrap(async (req, res) => {
  const { consentId, from, to } = req.body;
  const r = await requestHealthInformation({ consentId, from, to });
  res.json(r);
}));

api.get('/hi/requests', (req, res) => res.json(getHiRequests(200)));
api.get('/hi/data', (req, res) => res.json(getHiData(200)));

// --- logs ---
api.get('/logs', (req, res) => {
  const dir = req.query.direction || null;
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  res.json(getLogs(limit, dir));
});

app.use('/api', api);

// ---- static UI ----
app.use(express.static(join(__dirname, '..', 'public')));

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => {
  console.log(`\n  ABHA Bridge Console → http://localhost:${PORT}\n`);
  console.log(`  Gateway base : ${getConfig('gatewayBase')}`);
  console.log(`  Client ID    : ${getConfig('clientId') || '(not set)'}`);
  console.log(`  Webhook base : http://localhost:${PORT}/webhook/...  (expose via a tunnel)\n`);
});
