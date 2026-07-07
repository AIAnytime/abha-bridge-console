import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, '..', 'data');
mkdirSync(dataDir, { recursive: true });

export const db = new DatabaseSync(join(dataDir, 'abha.db'));

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS config (
    key   TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    access_token  TEXT,
    refresh_token TEXT,
    token_type    TEXT,
    expires_in    INTEGER,
    expires_at    INTEGER,
    raw           TEXT,
    created_at    INTEGER
  );

  CREATE TABLE IF NOT EXISTS api_logs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    direction    TEXT,            -- 'outbound' | 'inbound'
    method       TEXT,
    url          TEXT,
    status       INTEGER,
    req_headers  TEXT,
    req_body     TEXT,
    resp_body    TEXT,
    error        TEXT,
    created_at   INTEGER
  );

  CREATE TABLE IF NOT EXISTS services (
    id           TEXT PRIMARY KEY,   -- ABDM service id
    name         TEXT,
    type         TEXT,
    active       INTEGER,
    payload      TEXT,               -- full JSON we sent
    created_at   INTEGER
  );

  CREATE TABLE IF NOT EXISTS abha_profiles (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    abha_number    TEXT,
    abha_address   TEXT,
    name           TEXT,
    gender         TEXT,
    dob            TEXT,
    mobile         TEXT,
    x_token        TEXT,             -- X-Token for profile/PHR calls
    raw            TEXT,
    created_at     INTEGER
  );

  CREATE TABLE IF NOT EXISTS hi_requests (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id     TEXT,             -- our outgoing requestId (correlates on-request)
    consent_id     TEXT,
    transaction_id TEXT,             -- assigned by gateway via on-request
    hi_from        TEXT,
    hi_to          TEXT,
    status         TEXT,
    private_key    TEXT,             -- our ephemeral X25519 private key (PEM)
    public_key     TEXT,             -- our X25519 public key (base64 raw)
    nonce          TEXT,             -- our nonce (base64)
    created_at     INTEGER
  );

  CREATE TABLE IF NOT EXISTS hi_data (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    transaction_id TEXT,
    care_context   TEXT,
    checksum       TEXT,
    media          TEXT,
    decrypted      TEXT,             -- decrypted FHIR bundle (JSON/text)
    error          TEXT,
    created_at     INTEGER
  );

  CREATE TABLE IF NOT EXISTS consent_events (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    role           TEXT,             -- 'HIP' | 'HIU'
    type           TEXT,             -- classified callback type
    consent_id     TEXT,
    request_id     TEXT,             -- incoming ABDM requestId we must echo
    status         TEXT,
    acknowledged   INTEGER DEFAULT 0,
    ack_status     INTEGER,          -- HTTP status of our on-* acknowledgement
    payload        TEXT,             -- full inbound body
    created_at     INTEGER
  );
`);

// ---- config helpers -------------------------------------------------------
const getStmt = db.prepare('SELECT value FROM config WHERE key = ?');
const setStmt = db.prepare(
  'INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
);

export function getConfig(key, fallback = null) {
  const row = getStmt.get(key);
  return row ? row.value : fallback;
}

export function setConfig(key, value) {
  setStmt.run(key, value == null ? '' : String(value));
}

export function getAllConfig() {
  return db.prepare('SELECT key, value FROM config').all();
}

// Seed config from environment on first run (does not overwrite existing values).
export function seedConfig(env) {
  const seeds = {
    clientId: env.ABDM_CLIENT_ID || '',
    clientSecret: env.ABDM_CLIENT_SECRET || '',
    gatewayBase: env.ABDM_GATEWAY_BASE || 'https://dev.abdm.gov.in/gateway',
    sessionPath: env.ABDM_SESSION_PATH || '/v1/sessions',
    xCmId: env.ABDM_X_CM_ID || 'sbx',
    bridgeUrl: env.ABDM_BRIDGE_URL || '',
    abhaBase: env.ABDM_ABHA_BASE || 'https://abhasbx.abdm.gov.in/abha/api/v3',
  };
  for (const [k, v] of Object.entries(seeds)) {
    if (getConfig(k) == null) setConfig(k, v);
  }
}

// ---- session helpers ------------------------------------------------------
export function saveSession(tok) {
  const now = Date.now();
  const expiresIn = Number(tok.expiresIn ?? tok.expires_in ?? 0);
  const expiresAt = expiresIn ? now + expiresIn * 1000 : null;
  db.prepare(
    `INSERT INTO sessions (access_token, refresh_token, token_type, expires_in, expires_at, raw, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    tok.accessToken ?? tok.access_token ?? null,
    tok.refreshToken ?? tok.refresh_token ?? null,
    tok.tokenType ?? tok.token_type ?? 'bearer',
    expiresIn || null,
    expiresAt,
    JSON.stringify(tok),
    now
  );
  return getLatestSession();
}

export function getLatestSession() {
  return db.prepare('SELECT * FROM sessions ORDER BY id DESC LIMIT 1').get();
}

export function getValidAccessToken() {
  const s = getLatestSession();
  if (!s || !s.access_token) return null;
  if (s.expires_at && Date.now() > s.expires_at - 30_000) return null; // 30s skew
  return s.access_token;
}

// ---- log helpers ----------------------------------------------------------
export function logApi(entry) {
  db.prepare(
    `INSERT INTO api_logs (direction, method, url, status, req_headers, req_body, resp_body, error, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    entry.direction,
    entry.method || null,
    entry.url || null,
    entry.status ?? null,
    entry.reqHeaders ? JSON.stringify(entry.reqHeaders) : null,
    entry.reqBody != null ? (typeof entry.reqBody === 'string' ? entry.reqBody : JSON.stringify(entry.reqBody)) : null,
    entry.respBody != null ? (typeof entry.respBody === 'string' ? entry.respBody : JSON.stringify(entry.respBody)) : null,
    entry.error || null,
    Date.now()
  );
}

export function getLogs(limit = 100, direction = null) {
  if (direction) {
    return db
      .prepare('SELECT * FROM api_logs WHERE direction = ? ORDER BY id DESC LIMIT ?')
      .all(direction, limit);
  }
  return db.prepare('SELECT * FROM api_logs ORDER BY id DESC LIMIT ?').all(limit);
}

// ---- service cache --------------------------------------------------------
export function upsertService(svc) {
  db.prepare(
    `INSERT INTO services (id, name, type, active, payload, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name=excluded.name, type=excluded.type, active=excluded.active, payload=excluded.payload`
  ).run(
    svc.id,
    svc.name || null,
    svc.type || null,
    svc.active ? 1 : 0,
    JSON.stringify(svc),
    Date.now()
  );
}

export function getServices() {
  return db.prepare('SELECT * FROM services ORDER BY created_at DESC').all();
}

// ---- ABHA profiles --------------------------------------------------------
export function saveAbhaProfile(p) {
  db.prepare(
    `INSERT INTO abha_profiles (abha_number, abha_address, name, gender, dob, mobile, x_token, raw, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    p.ABHANumber || p.abhaNumber || null,
    p.preferredAbhaAddress || p.abhaAddress || null,
    p.name || [p.firstName, p.middleName, p.lastName].filter(Boolean).join(' ') || null,
    p.gender || null,
    p.dob || [p.yearOfBirth, p.monthOfBirth, p.dayOfBirth].filter(Boolean).join('-') || null,
    p.mobile || null,
    p.xToken || null,
    JSON.stringify(p),
    Date.now()
  );
  return db.prepare('SELECT * FROM abha_profiles ORDER BY id DESC LIMIT 1').get();
}

export function getAbhaProfiles() {
  return db.prepare('SELECT id, abha_number, abha_address, name, gender, dob, mobile, created_at FROM abha_profiles ORDER BY id DESC').all();
}

// ---- consent events -------------------------------------------------------
export function saveConsentEvent(e) {
  const info = db.prepare(
    `INSERT INTO consent_events (role, type, consent_id, request_id, status, payload, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    e.role || null,
    e.type || null,
    e.consentId || null,
    e.requestId || null,
    e.status || null,
    e.payload != null ? (typeof e.payload === 'string' ? e.payload : JSON.stringify(e.payload)) : null,
    Date.now()
  );
  return info.lastInsertRowid;
}

export function markConsentAcknowledged(id, ackStatus) {
  db.prepare('UPDATE consent_events SET acknowledged = 1, ack_status = ? WHERE id = ?').run(ackStatus ?? null, id);
}

export function getConsentEvents(limit = 100) {
  return db.prepare('SELECT * FROM consent_events ORDER BY id DESC LIMIT ?').all(limit);
}

// ---- health information ---------------------------------------------------
export function saveHiRequest(r) {
  const info = db.prepare(
    `INSERT INTO hi_requests (request_id, consent_id, hi_from, hi_to, status, private_key, public_key, nonce, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(r.requestId, r.consentId, r.from, r.to, r.status || 'REQUESTED', r.privateKey, r.publicKey, r.nonce, Date.now());
  return info.lastInsertRowid;
}

export function setHiTransaction(requestId, transactionId, status) {
  db.prepare('UPDATE hi_requests SET transaction_id = ?, status = ? WHERE request_id = ?')
    .run(transactionId, status || 'ACKNOWLEDGED', requestId);
}

export function getHiRequestByTxn(transactionId) {
  return db.prepare('SELECT * FROM hi_requests WHERE transaction_id = ? ORDER BY id DESC LIMIT 1').get(transactionId);
}

export function getHiRequests(limit = 100) {
  return db.prepare('SELECT id, request_id, consent_id, transaction_id, hi_from, hi_to, status, created_at FROM hi_requests ORDER BY id DESC LIMIT ?').all(limit);
}

export function saveHiData(d) {
  db.prepare(
    `INSERT INTO hi_data (transaction_id, care_context, checksum, media, decrypted, error, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(d.transactionId, d.careContext || null, d.checksum || null, d.media || null, d.decrypted || null, d.error || null, Date.now());
}

export function getHiData(limit = 100) {
  return db.prepare('SELECT * FROM hi_data ORDER BY id DESC LIMIT ?').all(limit);
}
