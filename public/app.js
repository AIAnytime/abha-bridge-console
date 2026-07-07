const $ = (id) => document.getElementById(id);
const j = (o) => JSON.stringify(o, null, 2);

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ---- tabs ----
document.querySelectorAll('nav button').forEach((btn) => {
  btn.onclick = () => {
    document.querySelectorAll('nav button').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    btn.classList.add('active');
    $(btn.dataset.tab).classList.add('active');
    if (btn.dataset.tab === 'logs') loadLogs();
    if (btn.dataset.tab === 'webhooks') loadHooks();
    if (btn.dataset.tab === 'session') loadSession();
    if (btn.dataset.tab === 'abha') loadAbha();
    if (btn.dataset.tab === 'consent') loadConsent();
    if (btn.dataset.tab === 'health') loadHealth();
  };
});

// ---- settings ----
async function loadConfig() {
  const c = await api('/config');
  $('clientId').value = c.clientId || '';
  $('gatewayBase').value = c.gatewayBase || '';
  $('sessionPath').value = c.sessionPath || '';
  $('xCmId').value = c.xCmId || '';
  $('bridgeUrl').value = c.bridgeUrl || '';
  $('patchUrl').value = c.bridgeUrl || '';
  $('sessEp').textContent = c.sessionPath || '/v1/sessions';
  $('secretState').textContent = c.clientSecretSet ? `stored (${c.clientSecret})` : 'not set';
  if (c.bridgeUrl) $('svcEndpoint').placeholder = c.bridgeUrl.replace(/\/$/, '') + '/webhook/registration';
}
$('saveConfig').onclick = async () => {
  const body = {
    clientId: $('clientId').value.trim(),
    gatewayBase: $('gatewayBase').value.trim(),
    sessionPath: $('sessionPath').value.trim(),
    xCmId: $('xCmId').value.trim(),
    bridgeUrl: $('bridgeUrl').value.trim(),
  };
  const secret = $('clientSecret').value.trim();
  if (secret) body.clientSecret = secret;
  await api('/config', { method: 'POST', body: j(body) });
  $('clientSecret').value = '';
  $('cfgStatus').textContent = '✓ saved';
  $('cfgStatus').className = 'inline-status status-ok';
  setTimeout(() => ($('cfgStatus').textContent = ''), 2500);
  loadConfig();
};

// ---- session ----
async function loadSession() {
  const s = await api('/session');
  const pill = $('sessionPill');
  const info = $('sessionInfo');
  if (!s.hasSession) {
    pill.textContent = 'session: none'; pill.className = 'session bad';
    info.textContent = 'No session yet.'; info.className = 'card muted';
    return;
  }
  const exp = s.expiresAt ? new Date(s.expiresAt).toLocaleString() : 'unknown';
  pill.textContent = s.valid ? 'session: valid' : 'session: expired';
  pill.className = 'session ' + (s.valid ? 'ok' : 'bad');
  info.className = 'card';
  info.textContent = j({
    valid: s.valid, tokenPreview: s.tokenPreview, tokenType: s.tokenType,
    expiresIn: s.expiresIn, expiresAt: exp,
  });
}
$('getSession').onclick = async () => {
  const btn = $('getSession'); btn.disabled = true; btn.textContent = 'Fetching…';
  try {
    await api('/session', { method: 'POST' });
    await loadSession();
  } catch (e) {
    $('sessionInfo').className = 'card'; $('sessionInfo').textContent = '❌ ' + e.message;
  } finally { btn.disabled = false; btn.textContent = 'Fetch session token'; }
};

// ---- bridge ----
$('patchBtn').onclick = async () => {
  const url = $('patchUrl').value.trim();
  try {
    const r = await api('/bridge/url', { method: 'POST', body: j({ url }) });
    $('svcResult').className = 'card'; $('svcResult').textContent = j(r);
  } catch (e) { $('svcResult').className = 'card'; $('svcResult').textContent = '❌ ' + e.message; }
};
$('addSvcBtn').onclick = async () => {
  const svc = {
    id: $('svcId').value.trim(),
    name: $('svcName').value.trim(),
    type: $('svcType').value,
    active: $('svcActive').checked,
    endpoints: [{ address: $('svcEndpoint').value.trim(), connectionType: 'https', use: $('svcUse').value.trim() }],
  };
  try {
    const r = await api('/bridge/services', { method: 'POST', body: j([svc]) });
    $('svcResult').className = 'card'; $('svcResult').textContent = j(r);
  } catch (e) { $('svcResult').className = 'card'; $('svcResult').textContent = '❌ ' + e.message; }
};
$('getSvcBtn').onclick = async () => {
  try {
    const r = await api('/bridge/services');
    $('svcResult').className = 'card'; $('svcResult').textContent = j(r);
  } catch (e) { $('svcResult').className = 'card'; $('svcResult').textContent = '❌ ' + e.message; }
};

// ---- API console ----
$('callBtn').onclick = async () => {
  let body = null;
  const raw = $('callBody').value.trim();
  if (raw) {
    try { body = JSON.parse(raw); }
    catch { $('callResult').className = 'card'; $('callResult').textContent = '❌ Body is not valid JSON'; return; }
  }
  const payload = {
    method: $('callMethod').value,
    path: $('callPath').value.trim(),
    auth: $('callAuth').checked,
    standard: $('callStd').checked,
    body,
  };
  try {
    const r = await api('/call', { method: 'POST', body: j(payload) });
    $('callResult').className = 'card';
    $('callResult').textContent = `HTTP ${r.status}\n\n` + j(r.body);
  } catch (e) { $('callResult').className = 'card'; $('callResult').textContent = '❌ ' + e.message; }
};

// ---- ABHA creation ----
$('otpBtn').onclick = async () => {
  const btn = $('otpBtn'); btn.disabled = true; btn.textContent = 'Sending…';
  $('otpStatus').textContent = '';
  try {
    const r = await api('/abha/otp', { method: 'POST', body: j({ aadhaar: $('aadhaar').value.trim() }) });
    $('txnId').value = r.txnId;
    $('otpStatus').textContent = '✓ ' + (r.message || 'OTP sent');
    $('otpStatus').className = 'inline-status status-ok';
    $('abhaResult').className = 'card'; $('abhaResult').textContent = j(r);
  } catch (e) {
    $('otpStatus').textContent = '❌ ' + e.message; $('otpStatus').className = 'inline-status status-err';
  } finally { btn.disabled = false; btn.textContent = 'Send OTP'; }
};
$('enrolBtn').onclick = async () => {
  const btn = $('enrolBtn'); btn.disabled = true; btn.textContent = 'Creating…';
  try {
    const r = await api('/abha/enrol', { method: 'POST', body: j({
      txnId: $('txnId').value.trim(), otp: $('otp').value.trim(), mobile: $('enrolMobile').value.trim() || undefined,
    }) });
    $('abhaResult').className = 'card ok-border'; $('abhaResult').textContent = '✓ ABHA created\n\n' + j(r.profile);
    loadAbha();
  } catch (e) { $('abhaResult').className = 'card'; $('abhaResult').textContent = '❌ ' + e.message; }
  finally { btn.disabled = false; btn.textContent = 'Verify & create ABHA'; }
};
async function loadAbha() {
  const list = await api('/abha/profiles');
  const box = $('abhaList'); box.innerHTML = '';
  if (!list.length) { box.innerHTML = '<p class="hint">No ABHA profiles created yet.</p>'; return; }
  list.forEach((p) => {
    const el = document.createElement('div'); el.className = 'card';
    el.textContent = `${p.name || '(no name)'} · ${p.abha_number || '—'}\n${p.abha_address || ''}  ${p.gender || ''} ${p.dob || ''}  ${p.mobile || ''}`;
    box.appendChild(el);
  });
}
$('refreshAbha').onclick = loadAbha;

// ---- ABHA login (existing user) ----
const LOGIN_PLACEHOLDERS = {
  mobile: '10-digit mobile',
  'abha-number': '14-digit ABHA number',
  aadhaar: '12-digit Aadhaar',
};
$('loginMethod').onchange = () => {
  $('loginId').placeholder = LOGIN_PLACEHOLDERS[$('loginMethod').value] || '';
  $('loginId').value = '';
};
$('loginOtpBtn').onclick = async () => {
  const btn = $('loginOtpBtn'); btn.disabled = true; btn.textContent = 'Sending…';
  $('loginOtpStatus').textContent = '';
  try {
    const r = await api('/abha/login/otp', { method: 'POST', body: j({
      method: $('loginMethod').value, identifier: $('loginId').value.trim(),
    }) });
    $('loginTxnId').value = r.txnId;
    $('loginOtpStatus').textContent = '✓ ' + (r.message || 'OTP sent');
    $('loginOtpStatus').className = 'inline-status status-ok';
    $('loginResult').className = 'card'; $('loginResult').textContent = j(r);
  } catch (e) {
    $('loginOtpStatus').textContent = '❌ ' + e.message; $('loginOtpStatus').className = 'inline-status status-err';
  } finally { btn.disabled = false; btn.textContent = 'Send login OTP'; }
};
$('loginVerifyBtn').onclick = async () => {
  const btn = $('loginVerifyBtn'); btn.disabled = true; btn.textContent = 'Logging in…';
  try {
    const r = await api('/abha/login/verify', { method: 'POST', body: j({
      method: $('loginMethod').value, txnId: $('loginTxnId').value.trim(), otp: $('loginOtp').value.trim(),
    }) });
    const n = (r.accounts && r.accounts.length) || r.saved || 0;
    $('loginResult').className = 'card ok-border';
    $('loginResult').textContent = `✓ Logged in — ${n} account(s), token ${r.tokenPreview || '—'}\n\n` + j(r.response);
    loadAbha();
  } catch (e) { $('loginResult').className = 'card'; $('loginResult').textContent = '❌ ' + e.message; }
  finally { btn.disabled = false; btn.textContent = 'Verify & login'; }
};

// ---- consent ----
$('autoAckToggle').onchange = async () => {
  await api('/config', { method: 'POST', body: j({ autoAck: String($('autoAckToggle').checked) }) });
};
$('consentInitBtn').onclick = async () => {
  const btn = $('consentInitBtn'); btn.disabled = true; btn.textContent = 'Sending…';
  try {
    const body = {
      patientAbhaAddress: $('cPatient').value.trim(),
      hiuId: $('cHiu').value.trim() || undefined,
      requesterName: $('cReqName').value.trim() || undefined,
      purposeCode: $('cPurpose').value.trim() || undefined,
      hiTypes: $('cHiTypes').value.split(',').map((s) => s.trim()).filter(Boolean),
      accessMode: $('cAccess').value,
    };
    const r = await api('/consent/init', { method: 'POST', body: j(body) });
    $('consentResult').className = 'card';
    $('consentResult').textContent = `Sent. Gateway HTTP ${r.response.status}\n\n` + j(r.response.body) + '\n\n--- request ---\n' + j(r.request);
    setTimeout(loadConsent, 1500);
  } catch (e) { $('consentResult').className = 'card'; $('consentResult').textContent = '❌ ' + e.message; }
  finally { btn.disabled = false; btn.textContent = 'Initiate consent request'; }
};
async function loadConsent() {
  const cfg = await api('/config');
  if (cfg.autoAck !== undefined) $('autoAckToggle').checked = cfg.autoAck !== 'false';
  const events = await api('/consent/events');
  const box = $('consentList'); box.innerHTML = '';
  if (!events.length) { box.innerHTML = '<p class="hint">No consent callbacks received yet.</p>'; return; }
  events.forEach((e) => {
    const el = document.createElement('details'); el.className = 'logrow';
    const roleCls = e.role === 'HIP' ? 'patch' : 'inbound';
    const ack = e.acknowledged
      ? `<span class="chip ack">acked ${e.ack_status || ''}</span>`
      : (e.type && e.type.includes('NOTIFY') ? '<span class="chip pending">not acked</span>' : '');
    const time = new Date(e.created_at).toLocaleTimeString();
    el.innerHTML = `
      <summary>
        <span class="pill ${roleCls}">${e.role || '?'}</span>
        <span>${escapeHtml(e.type || '')}</span>
        ${ack}
        <span class="meta">${time}</span>
      </summary>
      <div class="body">${section('consentId', e.consent_id)}${section('requestId', e.request_id)}${section('status', e.status)}${section('payload', e.payload)}</div>`;
    box.appendChild(el);
  });
}
$('refreshConsent').onclick = loadConsent;

// ---- health data ----
$('hReqBtn').onclick = async () => {
  const btn = $('hReqBtn'); btn.disabled = true; btn.textContent = 'Requesting…';
  try {
    const body = {
      consentId: $('hConsent').value.trim(),
      from: $('hFrom').value ? new Date($('hFrom').value).toISOString() : undefined,
      to: $('hTo').value ? new Date($('hTo').value).toISOString() : undefined,
    };
    const r = await api('/hi/request', { method: 'POST', body: j(body) });
    $('hResult').className = 'card';
    $('hResult').textContent = `Requested (requestId ${r.requestId})\nGateway HTTP ${r.response.status}\n\n` + j(r.response.body);
    setTimeout(loadHealth, 1200);
  } catch (e) { $('hResult').className = 'card'; $('hResult').textContent = '❌ ' + e.message; }
  finally { btn.disabled = false; btn.textContent = 'Request health data'; }
};
async function loadHealth() {
  const [reqs, data] = await Promise.all([api('/hi/requests'), api('/hi/data')]);
  const rbox = $('hReqList'); rbox.innerHTML = '';
  if (!reqs.length) rbox.innerHTML = '<p class="hint">No requests yet.</p>';
  reqs.forEach((r) => {
    const el = document.createElement('div'); el.className = 'card';
    el.textContent = `consent ${r.consent_id || '—'}\ntxn ${r.transaction_id || '(awaiting on-request)'}  ·  ${r.status}\n${r.hi_from} → ${r.hi_to}`;
    rbox.appendChild(el);
  });
  const dbox = $('hDataList'); dbox.innerHTML = '';
  if (!data.length) { dbox.innerHTML = '<p class="hint">No bundles received yet.</p>'; return; }
  data.forEach((d) => {
    const el = document.createElement('details'); el.className = 'logrow';
    const ok = !d.error;
    el.innerHTML = `
      <summary>
        <span class="pill ${ok ? 'post' : 'delete'}">${ok ? 'FHIR' : 'ERR'}</span>
        <span>${escapeHtml(d.care_context || '(no careContext)')}</span>
        <span class="meta">${new Date(d.created_at).toLocaleTimeString()}</span>
      </summary>
      <div class="body">${section('transactionId', d.transaction_id)}${section('checksum', d.checksum)}${d.error ? section('error', d.error) : section('decrypted bundle', d.decrypted)}</div>`;
    dbox.appendChild(el);
  });
}
$('refreshHReq').onclick = loadHealth;
$('refreshHData').onclick = loadHealth;

// ---- logs / webhooks ----
function logRow(l) {
  const m = (l.method || '').toLowerCase();
  const cls = l.direction === 'inbound' ? 'inbound' : m;
  const statusCls = l.error ? 'status-err' : (l.status && l.status < 400 ? 'status-ok' : 'status-err');
  const time = new Date(l.created_at).toLocaleTimeString();
  const el = document.createElement('details');
  el.className = 'logrow';
  const dirTag = l.direction === 'inbound' ? '⬇ IN' : '⬆ OUT';
  el.innerHTML = `
    <summary>
      <span class="pill ${cls}">${l.method || '?'}</span>
      <span class="${statusCls}">${l.error ? 'ERR' : (l.status ?? '—')}</span>
      <span>${dirTag}</span>
      <span style="color:var(--muted)">${escapeHtml(l.url || '')}</span>
      <span class="meta">${time}</span>
    </summary>
    <div class="body">${section('request headers', l.req_headers)}${section('request body', l.req_body)}${section('response', l.resp_body)}${l.error ? section('error', l.error) : ''}</div>
  `;
  return el;
}
function section(label, val) {
  if (val == null || val === '') return '';
  let pretty = val;
  try { pretty = j(JSON.parse(val)); } catch {}
  return `<div class="section-label">${label}</div>${escapeHtml(pretty)}\n`;
}
function escapeHtml(s) { return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }

async function loadLogs() {
  const logs = await api('/logs?limit=200');
  const box = $('logList'); box.innerHTML = '';
  if (!logs.length) { box.innerHTML = '<p class="hint">No calls logged yet.</p>'; return; }
  logs.forEach((l) => box.appendChild(logRow(l)));
}
async function loadHooks() {
  const logs = await api('/logs?direction=inbound&limit=200');
  const box = $('hookList'); box.innerHTML = '';
  if (!logs.length) { box.innerHTML = '<p class="hint">No webhook callbacks received yet.</p>'; return; }
  logs.forEach((l) => box.appendChild(logRow(l)));
}
$('refreshLogs').onclick = loadLogs;
$('refreshHooks').onclick = loadHooks;

// ---- init ----
loadConfig();
loadSession();
