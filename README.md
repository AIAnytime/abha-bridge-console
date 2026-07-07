# ABHA Bridge Console

A web UI + SQLite database to drive **ABDM (Ayushman Bharat Digital Mission)** sandbox
bridge integration. Everything is done from the browser; your config, tokens, services,
and every request/response are persisted in `data/abha.db`.

## Features

| Tab | What it does |
|-----|--------------|
| **Settings** | Store & persist Client ID/Secret + gateway URLs. Secret is write-only (never returned to the browser). |
| **Gateway Session** | Exchange credentials for a bearer token; auto-attached to every gateway call. |
| **Bridge Setup** | `PATCH /bridges` (set webhook URL), `addUpdateServices`, `getServices`. |
| **ABHA Creation** | Create an ABHA via Aadhaar OTP, **or log in an existing ABHA** (mobile / ABHA number / Aadhaar). Aadhaar/OTP/identifiers are RSA-encrypted (OAEP/SHA-1) with ABDM's public cert; profiles are persisted. |
| **Consent** | HIU: initiate a consent request. HIP & HIU: incoming consent notifications are classified, persisted, and auto-acknowledged. |
| **Health Data** | HIU: fetch a user's health data for a granted consent. Encrypted FHIR bundles are received, decrypted (X25519+AES-GCM), and stored. |
| **API Console** | Fire *any* authenticated ABDM call (method + path + JSON body). |
| **Webhook Inbox** | Persists ABDM's async callbacks to `/webhook/*` so you can inspect them. |
| **Logs** | Every outbound call + inbound webhook, newest first. Auth headers are redacted. |

## Run

```bash
npm install
npm start          # http://localhost:3000   (npm run dev = auto-reload)
```

No native dependencies — uses Node's built-in `node:sqlite` (Node ≥ 22.5, tested on 25).
The only npm dependency is Express.

## Configuration

`.env` seeds the database on first run (copy from `.env.example`). After that, edit values
in the **Settings** tab. Current working defaults:

```
ABDM_GATEWAY_BASE=https://dev.abdm.gov.in/gateway
ABDM_SESSION_PATH=/v0.5/sessions
ABDM_X_CM_ID=sbx
```

> **Note on API versions:** the endpoints in the original `creds.txt` (`/gateway/v1/sessions`,
> `/gateway/v1/bridges`) are outdated. The live session endpoint is
> **`/gateway/v0.5/sessions`** (equivalently `/api/hiecm/gateway/v3/sessions`). The bridge
> management endpoints have likewise moved; confirm the current paths in the
> [ABDM sandbox docs](https://sandbox.abdm.gov.in/sandbox/v3/new-documentation?doc=WorkingWithABDMapi)
> and use the **API Console** to call them.

## ABHA creation (Aadhaar OTP)

Base host: `https://abhasbx.abdm.gov.in/abha/api/v3` (config key `abhaBase`).

1. `GET /profile/public/certificate` → RSA public key (cached).
2. `POST /enrollment/request/otp` with the **RSA-encrypted** Aadhaar (`loginHint: aadhaar`).
3. `POST /enrollment/enrol/byAadhaar` with the **RSA-encrypted** OTP → ABHA profile.

Encryption is `RSA/ECB/OAEPWithSHA-1AndMGF1Padding` — **verified empirically** against the
sandbox (OAEP decrypts server-side; PKCS1 is rejected). Plaintext Aadhaar/OTP never leave the
server process and are never logged; only ciphertext is sent and stored. Use a sandbox test
Aadhaar whose linked mobile can receive the OTP.

### Login for existing ABHA users

Same tab, "Login — existing ABHA user". Two steps: `POST /profile/login/request/otp` then
`POST /profile/login/verify` (both against the ABHA base). The identifier and OTP are
RSA-encrypted. The `scope` / `loginHint` / `otpSystem` triples are **live-verified** against the
sandbox (the gateway 400s on any wrong value):

| Method | scope | loginHint | otpSystem |
|--------|-------|-----------|-----------|
| Mobile | `abha-login`, `mobile-verify` | `mobile` | `abdm` |
| ABHA number | `abha-login`, `mobile-verify` | `abha-number` | `abdm` |
| Aadhaar | `abha-login`, `aadhaar-verify` | `aadhaar` | `aadhaar` |

`abha-address` is **not** a valid loginHint for this endpoint, so it is not offered. On success
the returned ABHA account(s) are persisted with their auth token (the token is kept server-side;
only a preview is returned to the browser).

## Consent (HIP / HIU)

- **Initiate (HIU):** `POST /v0.5/consent-requests/init` from the Consent tab.
- **Callbacks:** ABDM's Consent Manager pushes notifications to your bridge. `src/consent.js`
  classifies them (`HIP_CONSENT_NOTIFY`, `HIU_CONSENT_NOTIFY`, `..._ON_INIT`, …), persists them
  to `consent_events`, and — when auto-ack is on — replies via the matching endpoint
  (`/v0.5/consents/hip/on-notify` or `/v0.5/consents/hiu/on-notify`) echoing the incoming
  `requestId` and the extracted `consentId`(s).

> The gateway returns **403 "API Subscription validation failed"** on the bridge-management and
> consent callback endpoints until your bridge is fully onboarded (services registered + facility
> active). The handler builds and sends correct acknowledgements regardless; onboarding is the
> remaining ABDM-side step for those to return 200.

## Fetch health data (HIU, M3)

For a **granted** consent artefact:

1. **HIU → gateway:** `POST /v0.5/health-information/cm/request` with the `consentId`, date range,
   your public `dataPushUrl` (`<bridgeUrl>/hi/transfer`), and ephemeral **X25519** key material
   (public key + 32-byte nonce). We store the private key against the outgoing `requestId`.
2. **Gateway → HIU:** `/v0.5/health-information/hiu/on-request` returns a `transactionId`, which we
   correlate back to the stored key material.
3. **HIP → your `dataPushUrl`:** encrypted FHIR bundles + the HIP's public key & nonce.
4. **Decrypt:** X25519 ECDH → shared secret → HKDF-SHA256 (salt = first 20 bytes, IV = last 12 bytes
   of `senderNonce XOR receiverNonce`) → **AES-256-GCM**. Decrypted bundles are stored in `hi_data`.

`src/hicrypto.js` implements the scheme (with `encrypt` for the self-test); `src/hi.js` runs the
flow. Both the pure crypto round-trip and the full server pipeline (request → on-request →
simulated HIP push → decrypt) are verified. The exact on-wire key encoding (raw 32-byte vs DER)
is the one thing needing a live granted-consent transfer to confirm against ABDM's own HIP; the
receiver accepts both.

## Receiving webhooks

ABDM calls your bridge asynchronously over public HTTPS. In development, expose this app
with a tunnel and set that URL as your Bridge URL:

```bash
ngrok http 3000        # or: cloudflared tunnel --url http://localhost:3000
```

Point endpoints at `https://<tunnel>/webhook/<use>` (e.g. `/webhook/registration`).
Incoming callbacks appear in the **Webhook Inbox** tab.

## Security

- Client secret and access tokens live only in the local SQLite DB; the secret is never
  sent to the browser and `Authorization` headers are redacted in the log.
- `.env`, `creds.txt`, and `data/*.db` are git-ignored. **Do not commit real credentials.**

## Layout

```
src/
  server.js   Express app: web-UI API, webhook inbox, static hosting
  abdm.js     ABDM gateway client (session, bridge helpers, generic request + logging)
  abha.js     ABHA enrolment flow (Aadhaar OTP request + enrol)
  crypto.js   Public-cert fetch/cache + RSA-OAEP encryption
  consent.js  Consent callback classify/persist/auto-ack + HIU initiate
  hi.js       Health-information request + on-request correlation + data-push decrypt
  hicrypto.js X25519 ECDH + HKDF-SHA256 + AES-256-GCM (data-transfer encryption)
  db.js       node:sqlite schema + helpers (config, sessions, api_logs, services,
              abha_profiles, consent_events, hi_requests, hi_data)
public/       Single-page UI (index.html, app.js, style.css)
data/         SQLite database (created at runtime)
```
