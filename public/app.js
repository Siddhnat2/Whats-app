/* WhatsApp Campaign Studio — front-end controller */
'use strict';

// ----------------------------------------------------------------- helpers
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    headers: opts.body && !(opts.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {},
    ...opts,
  });
  if (res.status === 401) { window.location.href = '/login'; throw new Error('unauthorized'); }
  const data = await res.json().catch(() => ({ ok: false, error: 'bad response' }));
  if (!res.ok || data.ok === false) throw new Error(data.error || 'request failed');
  return data;
}

function toast(msg, type = 'info', ms = 3500) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 300); }, ms);
}

function confirmModal(title, body, okLabel = 'Confirm', danger = false) {
  return new Promise((resolve) => {
    const root = $('#modalRoot');
    root.innerHTML = `
      <div class="modal-backdrop">
        <div class="modal">
          <h3>${esc(title)}</h3>
          <div class="muted" style="margin-top:6px">${body}</div>
          <div class="actions">
            <button class="btn" data-act="cancel">Cancel</button>
            <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-act="ok">${esc(okLabel)}</button>
          </div>
        </div>
      </div>`;
    const close = (val) => { root.innerHTML = ''; resolve(val); };
    $('[data-act=cancel]', root).onclick = () => close(false);
    $('[data-act=ok]', root).onclick = () => close(true);
    $('.modal-backdrop', root).onclick = (e) => { if (e.target.classList.contains('modal-backdrop')) close(false); };
  });
}

function timeAgo(sec) {
  if (!sec) return '—';
  const d = new Date(sec * 1000);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function fmtSize(b) {
  if (!b) return '';
  const u = ['B', 'KB', 'MB', 'GB']; let i = 0; let n = b;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

// ----------------------------------------------------------------- state
const state = {
  connection: { status: 'disconnected', ready: false, sending: false },
  contacts: [],
  templates: [],
  attachments: [],
  activeTemplateId: null,
  composeSelected: new Set(),
  composeAttachSelected: new Set(),
};

// ----------------------------------------------------------------- routing
function showPage(name) {
  $$('.nav-item[data-page]').forEach((n) => n.classList.toggle('active', n.dataset.page === name));
  $$('section.page').forEach((s) => s.classList.toggle('hidden', s.dataset.page !== name));
  const loaders = {
    dashboard: loadDashboard, compose: loadCompose, contacts: loadContacts,
    templates: loadTemplates, history: loadHistory, connect: loadConnect,
  };
  if (loaders[name]) loaders[name]();
}
$$('.nav-item[data-page]').forEach((n) => n.addEventListener('click', () => showPage(n.dataset.page)));
$$('[data-goto]').forEach((b) => b.addEventListener('click', () => showPage(b.dataset.goto)));

$('#logoutBtn').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  window.location.href = '/login';
});

// ----------------------------------------------------------------- connection UI
function renderConnection() {
  const c = state.connection;
  const map = {
    ready: ['on', 'Connected'],
    qr: ['warn', 'Scan QR code'],
    authenticated: ['warn', 'Linking…'],
    initializing: ['warn', 'Starting…'],
    disconnected: ['off', 'Not connected'],
  };
  const [cls, label] = map[c.status] || ['off', 'Not connected'];
  const info = c.info && c.info.pushname ? `Connected as ${c.info.pushname}` : label;
  $('#sideDot').className = `dot ${cls}`;
  $('#sideConn').textContent = c.ready ? (c.info && c.info.pushname || 'Connected') : label;
  $('#dashDot').className = `dot ${cls}`;
  $('#dashConnText').textContent = c.ready ? info : 'WhatsApp is not connected.';
  // compose badge
  const cs = $('#composeStatus');
  if (cs) {
    cs.textContent = c.ready ? 'WhatsApp connected' : 'Not connected — link it first';
    cs.className = `badge ${c.ready ? 'sent' : 'invalid'}`;
  }
  // connect page
  updateConnectPage();
}

function updateConnectPage() {
  const c = state.connection;
  const box = $('#qrBox');
  const title = $('#connTitle');
  const desc = $('#connDesc');
  const info = $('#connInfo');
  const connectBtn = $('#connConnect');
  const logoutBtn = $('#connLogout');
  if (!box) return;

  if (c.ready) {
    title.textContent = c.mock ? 'Connected (mock mode)' : 'Connected';
    desc.textContent = 'Your WhatsApp account is linked and ready to send.';
    info.innerHTML = c.info ? `Account: <b>${esc(c.info.pushname || '')}</b><br><span class="mono muted">${esc(c.info.wid || '')}</span>` : '';
    box.innerHTML = '<div><div style="font-size:56px">✅</div><div class="muted">Linked & ready</div></div>';
    connectBtn.classList.add('hidden');
    logoutBtn.classList.remove('hidden');
  } else if (c.status === 'qr' && c.qrImage) {
    title.textContent = 'Scan to link';
    desc.innerHTML = 'On your phone: <b>WhatsApp → Settings → Linked devices → Link a device</b>, then scan.';
    info.innerHTML = '';
    box.innerHTML = `<div><img src="${c.qrImage}" alt="QR code" /><div class="muted small" style="margin-top:8px">Waiting for scan…</div></div>`;
    connectBtn.classList.add('hidden');
    logoutBtn.classList.remove('hidden');
  } else if (c.status === 'initializing' || c.status === 'authenticated') {
    title.textContent = c.status === 'authenticated' ? 'Linking device…' : 'Starting engine…';
    desc.textContent = 'This can take a few seconds while the browser session boots.';
    box.innerHTML = '<div style="text-align:center"><div class="spinner" style="margin:0 auto 12px"></div><div class="muted">Please wait…</div></div>';
    connectBtn.classList.add('hidden');
    logoutBtn.classList.remove('hidden');
  } else {
    title.textContent = 'Not connected';
    desc.innerHTML = 'Press <b>Connect</b>, then scan the QR code with WhatsApp on your phone.';
    info.innerHTML = '';
    box.innerHTML = '<div><div style="font-size:48px">🔗</div><div class="muted">Click connect to start.</div></div>';
    connectBtn.classList.remove('hidden');
    logoutBtn.classList.add('hidden');
  }
}

// ----------------------------------------------------------------- Dashboard
async function loadDashboard() {
  try {
    const d = await api('/stats');
    $('#dashContacts').textContent = d.contacts.total;
    $('#dashValid').textContent = `${d.contacts.valid} valid · ${d.contacts.invalid} invalid`;
    $('#dashSent').textContent = d.history.sent;
    $('#dashNotReg').textContent = d.history.not_registered;
    $('#dashFailed').textContent = d.history.failed;
    state.connection = d.connection;
    renderConnection();
    const h = await api('/history?limit=6');
    if (!h.history.length) { $('#dashRecent').textContent = 'No campaigns yet.'; return; }
    $('#dashRecent').innerHTML = h.history.map((r) =>
      `<div class="row" style="padding:6px 0;border-bottom:1px solid var(--border)">
        <span class="badge ${r.status}">${statusLabel(r.status)}</span>
        <span>${esc(r.name || r.phone)}</span><div class="spacer"></div>
        <span class="muted small">${timeAgo(r.sent_at)}</span></div>`).join('');
  } catch (e) { toast(e.message, 'error'); }
}

function statusLabel(s) {
  return { sent: 'SENT', failed: 'FAILED', not_registered: 'NOT ON WA' }[s] || (s || '').toUpperCase();
}

// ----------------------------------------------------------------- Contacts
async function loadContacts() {
  const search = $('#contactsSearch').value;
  const onlyValid = $('#contactsOnlyValid').checked;
  try {
    const d = await api(`/contacts?search=${encodeURIComponent(search)}&onlyValid=${onlyValid ? 1 : 0}`);
    state.contacts = d.contacts;
    $('#contactsSub').textContent = `${d.counts.total} total · ${d.counts.valid} valid · ${d.counts.invalid} invalid`;
    renderContactsTable();
  } catch (e) { toast(e.message, 'error'); }
}
function renderContactsTable() {
  const body = $('#contactsBody');
  if (!state.contacts.length) {
    body.innerHTML = '<tr><td colspan="7" class="empty">No contacts. Import an Excel/CSV to get started.</td></tr>';
    return;
  }
  body.innerHTML = state.contacts.map((c) => `
    <tr>
      <td class="checkcol"><input type="checkbox" class="rowchk" data-id="${c.id}" /></td>
      <td>${esc(c.company)}</td><td>${esc(c.name)}</td><td>${esc(c.designation)}</td>
      <td class="mono">+${esc(c.phone)}</td>
      <td>${c.valid ? '<span class="badge valid">valid</span>' : `<span class="badge invalid">${esc(c.reason || 'invalid')}</span>`}</td>
      <td>${c.sent_count || 0}</td>
    </tr>`).join('');
  $$('.rowchk', body).forEach((chk) => chk.addEventListener('change', updateContactsSelState));
  updateContactsSelState();
}
function selectedContactIds() { return $$('#contactsBody .rowchk:checked').map((c) => Number(c.dataset.id)); }
function updateContactsSelState() {
  const n = selectedContactIds().length;
  $('#contactsDeleteSel').disabled = n === 0;
  $('#contactsDeleteSel').textContent = n ? `🗑 Delete (${n})` : '🗑 Delete selected';
}
$('#contactsCheckAll').addEventListener('change', (e) => {
  $$('#contactsBody .rowchk').forEach((c) => { c.checked = e.target.checked; });
  updateContactsSelState();
});
let contactsSearchT;
$('#contactsSearch').addEventListener('input', () => { clearTimeout(contactsSearchT); contactsSearchT = setTimeout(loadContacts, 250); });
$('#contactsOnlyValid').addEventListener('change', loadContacts);
$('#contactsFile').addEventListener('change', async (e) => {
  const file = e.target.files[0]; if (!file) return;
  const fd = new FormData(); fd.append('file', file);
  try {
    const d = await api('/contacts/import', { method: 'POST', body: fd });
    const s = d.summary;
    toast(`Imported: ${s.inserted} new, ${s.updated} updated, ${s.invalid} invalid, ${s.duplicate} dupes.`, 'success', 5000);
    loadContacts();
  } catch (err) { toast(err.message, 'error'); }
  e.target.value = '';
});
$('#contactsDeleteSel').addEventListener('click', async () => {
  const ids = selectedContactIds(); if (!ids.length) return;
  if (!await confirmModal('Delete contacts', `Delete ${ids.length} selected contact(s)?`, 'Delete', true)) return;
  try { await api('/contacts', { method: 'DELETE', body: JSON.stringify({ ids }) }); toast('Deleted', 'success'); loadContacts(); }
  catch (e) { toast(e.message, 'error'); }
});
$('#contactsClear').addEventListener('click', async () => {
  if (!await confirmModal('Clear all contacts', 'This removes <b>every</b> contact. Continue?', 'Clear all', true)) return;
  try { await api('/contacts', { method: 'DELETE', body: JSON.stringify({ all: true }) }); toast('All contacts cleared', 'success'); loadContacts(); }
  catch (e) { toast(e.message, 'error'); }
});
$('#contactsAddBtn').addEventListener('click', () => {
  const root = $('#modalRoot');
  root.innerHTML = `
    <div class="modal-backdrop"><div class="modal">
      <h3>Add contact</h3>
      <div style="margin-top:12px"><label class="field">Company</label><input type="text" id="acCompany" /></div>
      <div style="margin-top:10px"><label class="field">Name</label><input type="text" id="acName" /></div>
      <div style="margin-top:10px"><label class="field">Designation</label><input type="text" id="acDesig" /></div>
      <div style="margin-top:10px"><label class="field">Phone number</label><input type="text" id="acPhone" placeholder="+91 98765 43210" /></div>
      <div class="actions"><button class="btn" data-act="cancel">Cancel</button><button class="btn btn-primary" data-act="ok">Add</button></div>
    </div></div>`;
  $('[data-act=cancel]', root).onclick = () => { root.innerHTML = ''; };
  $('[data-act=ok]', root).onclick = async () => {
    try {
      await api('/contacts', { method: 'POST', body: JSON.stringify({
        company: $('#acCompany').value, name: $('#acName').value,
        designation: $('#acDesig').value, phone: $('#acPhone').value }) });
      root.innerHTML = ''; toast('Contact saved', 'success'); loadContacts();
    } catch (e) { toast(e.message, 'error'); }
  };
});

// ----------------------------------------------------------------- Templates
async function loadTemplates() {
  try {
    const d = await api('/templates');
    state.templates = d.templates;
    renderTemplateList();
    renderTemplateChips(d.variables);
    if (state.activeTemplateId == null && d.templates.length) selectTemplate(d.templates[0].id);
    else if (state.activeTemplateId != null) selectTemplate(state.activeTemplateId);
    else renderTemplateEditor(null);
    loadAttachments();
  } catch (e) { toast(e.message, 'error'); }
}
function renderTemplateList() {
  const el = $('#tplList');
  if (!state.templates.length) { el.innerHTML = '<div class="empty small">No templates yet.</div>'; return; }
  el.innerHTML = state.templates.map((t) => `
    <div class="file-item" data-id="${t.id}" style="cursor:pointer;${t.id === state.activeTemplateId ? 'border-color:var(--wa-green)' : ''}">
      <span class="grow"><b>${esc(t.name)}</b><br><span class="muted small">${esc((t.body || '').slice(0, 50))}${(t.body || '').length > 50 ? '…' : ''}</span></span>
    </div>`).join('');
  $$('#tplList .file-item').forEach((it) => it.addEventListener('click', () => selectTemplate(Number(it.dataset.id))));
}
function renderTemplateChips(vars) {
  $('#tplChips').innerHTML = (vars || []).map((v) => `<span class="chip" data-var="{${v}}">{${v}}</span>`).join('');
  $$('#tplChips .chip').forEach((c) => c.addEventListener('click', () => insertAtCursor($('#tplBody'), c.dataset.var)));
}
function insertAtCursor(ta, text) {
  const s = ta.selectionStart || 0; const e = ta.selectionEnd || 0;
  ta.value = ta.value.slice(0, s) + text + ta.value.slice(e);
  ta.focus(); ta.selectionStart = ta.selectionEnd = s + text.length;
  updateTemplatePreview();
}
function selectTemplate(id) {
  state.activeTemplateId = id;
  const t = state.templates.find((x) => x.id === id);
  renderTemplateEditor(t);
  renderTemplateList();
}
function renderTemplateEditor(t) {
  $('#tplEditorTitle').textContent = t ? 'Edit template' : 'New template';
  $('#tplName').value = t ? t.name : '';
  $('#tplBody').value = t ? (t.body || '') : '';
  $('#tplDelete').style.display = t ? '' : 'none';
  updateTemplatePreview();
}
let tplPrevT;
async function updateTemplatePreview() {
  clearTimeout(tplPrevT);
  tplPrevT = setTimeout(async () => {
    try { const d = await api('/templates/preview', { method: 'POST', body: JSON.stringify({ body: $('#tplBody').value }) });
      $('#tplPreview').textContent = d.preview || '—'; } catch (_) {}
  }, 200);
}
$('#tplBody').addEventListener('input', updateTemplatePreview);
$('#tplNew').addEventListener('click', () => { state.activeTemplateId = null; renderTemplateEditor(null); renderTemplateList(); $('#tplName').focus(); });
$('#tplSave').addEventListener('click', async () => {
  const name = $('#tplName').value.trim(); const body = $('#tplBody').value;
  if (!name) { toast('Template name is required', 'warning'); return; }
  try {
    if (state.activeTemplateId != null) {
      const d = await api(`/templates/${state.activeTemplateId}`, { method: 'PUT', body: JSON.stringify({ name, body }) });
      toast('Template saved', 'success');
    } else {
      const d = await api('/templates', { method: 'POST', body: JSON.stringify({ name, body }) });
      state.activeTemplateId = d.id; toast('Template created', 'success');
    }
    loadTemplates();
  } catch (e) { toast(e.message, 'error'); }
});
$('#tplDelete').addEventListener('click', async () => {
  if (state.activeTemplateId == null) return;
  if (!await confirmModal('Delete template', 'Delete this template?', 'Delete', true)) return;
  try { await api(`/templates/${state.activeTemplateId}`, { method: 'DELETE' }); state.activeTemplateId = null; toast('Deleted', 'success'); loadTemplates(); }
  catch (e) { toast(e.message, 'error'); }
});

// ----------------------------------------------------------------- Attachments
async function loadAttachments() {
  try { const d = await api('/attachments'); state.attachments = d.attachments; renderAttachList(); }
  catch (e) { /* silent */ }
}
function renderAttachList() {
  const el = $('#attachList');
  if (!state.attachments.length) { el.innerHTML = '<div class="empty small">No files uploaded.</div>'; return; }
  el.innerHTML = state.attachments.map((a) => `
    <div class="attach-item">
      <span>📎</span><span class="grow">${esc(a.filename)} <span class="muted small">${fmtSize(a.size_bytes)}</span></span>
      <button class="btn btn-sm btn-ghost" data-del="${a.id}">✕</button>
    </div>`).join('');
  $$('#attachList [data-del]').forEach((b) => b.addEventListener('click', async () => {
    try { await api(`/attachments/${b.dataset.del}`, { method: 'DELETE' }); loadAttachments(); } catch (e) { toast(e.message, 'error'); }
  }));
}
$('#attachFile').addEventListener('change', async (e) => {
  if (!e.target.files.length) return;
  const fd = new FormData(); for (const f of e.target.files) fd.append('files', f);
  try { await api('/attachments', { method: 'POST', body: fd }); toast('Files uploaded', 'success'); loadAttachments(); }
  catch (err) { toast(err.message, 'error'); }
  e.target.value = '';
});

// ----------------------------------------------------------------- Compose
async function loadCompose() {
  try {
    const [t, c, a, s] = await Promise.all([api('/templates'), api('/contacts?onlyValid=1'), api('/attachments'), api('/settings')]);
    state.templates = t.templates; state.attachments = a.attachments;
    const sel = $('#composeTemplate');
    sel.innerHTML = t.templates.length
      ? t.templates.map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join('')
      : '<option value="">— create a template first —</option>';
    sel.onchange = updateComposePreview; updateComposePreview();
    $('#composeMin').value = Math.round((s.settings.min_delay_ms || 4000) / 1000);
    $('#composeMax').value = Math.round((s.settings.max_delay_ms || 9000) / 1000);
    state.contacts = c.contacts;
    renderComposeContacts();
    renderComposeAttachments();
    renderConnection();
  } catch (e) { toast(e.message, 'error'); }
}
async function updateComposePreview() {
  const id = Number($('#composeTemplate').value);
  const t = state.templates.find((x) => x.id === id);
  if (!t) { $('#composePreview').textContent = '—'; return; }
  try { const d = await api('/templates/preview', { method: 'POST', body: JSON.stringify({ body: t.body }) }); $('#composePreview').textContent = d.preview || '—'; }
  catch (_) {}
}
function renderComposeContacts() {
  const search = ($('#composeSearch').value || '').toLowerCase();
  const rows = state.contacts.filter((c) => !search ||
    (c.company + c.name + c.phone).toLowerCase().includes(search));
  const body = $('#composeContacts');
  if (!rows.length) { body.innerHTML = '<tr><td colspan="5" class="empty">No valid contacts. Import some first.</td></tr>'; return; }
  body.innerHTML = rows.map((c) => `
    <tr>
      <td class="checkcol"><input type="checkbox" class="cck" data-id="${c.id}" ${state.composeSelected.has(c.id) ? 'checked' : ''}/></td>
      <td>${esc(c.company)}</td><td>${esc(c.name)}</td><td class="mono">+${esc(c.phone)}</td>
      <td>${c.last_status ? `<span class="badge ${c.last_status}">${statusLabel(c.last_status)}</span>` : '<span class="muted small">—</span>'}</td>
    </tr>`).join('');
  $$('#composeContacts .cck').forEach((chk) => chk.addEventListener('change', () => {
    const id = Number(chk.dataset.id);
    if (chk.checked) state.composeSelected.add(id); else state.composeSelected.delete(id);
    updateComposeSelCount();
  }));
  updateComposeSelCount();
}
function updateComposeSelCount() { $('#composeSelCount').textContent = `${state.composeSelected.size} selected`; }
$('#composeSearch').addEventListener('input', renderComposeContacts);
$('#composeSelectAll').addEventListener('click', () => {
  state.contacts.forEach((c) => state.composeSelected.add(c.id)); renderComposeContacts();
});
$('#composeSelectNone').addEventListener('click', () => { state.composeSelected.clear(); renderComposeContacts(); });
function renderComposeAttachments() {
  const el = $('#composeAttachments');
  const none = $('#composeNoAttach');
  if (!state.attachments.length) { el.innerHTML = ''; none.classList.remove('hidden'); return; }
  none.classList.add('hidden');
  el.innerHTML = state.attachments.map((a) => `
    <label class="attach-item" style="cursor:pointer">
      <input type="checkbox" class="ack" data-id="${a.id}" style="width:auto" ${state.composeAttachSelected.has(a.id) ? 'checked' : ''}/>
      <span class="grow">${esc(a.filename)} <span class="muted small">${fmtSize(a.size_bytes)}</span></span>
    </label>`).join('');
  $$('#composeAttachments .ack').forEach((chk) => chk.addEventListener('change', () => {
    const id = Number(chk.dataset.id);
    if (chk.checked) state.composeAttachSelected.add(id); else state.composeAttachSelected.delete(id);
  }));
}
$('#composeSend').addEventListener('click', async () => {
  if (!state.connection.ready) { toast('Connect WhatsApp first (Connect page).', 'warning'); showPage('connect'); return; }
  const contactIds = [...state.composeSelected];
  if (!contactIds.length) { toast('Select at least one recipient', 'warning'); return; }
  const templateId = Number($('#composeTemplate').value);
  if (!templateId) { toast('Pick a template', 'warning'); return; }
  const attachmentIds = [...state.composeAttachSelected];
  const minDelayMs = Number($('#composeMin').value) * 1000;
  const maxDelayMs = Math.max(minDelayMs, Number($('#composeMax').value) * 1000);
  const tName = state.templates.find((t) => t.id === templateId)?.name || '';
  const extra = attachmentIds.length ? ` with ${attachmentIds.length} attachment(s)` : '';
  if (!await confirmModal('Send campaign', `Send <b>${esc(tName)}</b> to <b>${contactIds.length}</b> recipient(s)${extra}?`, 'Send now')) return;
  try {
    const d = await api('/campaign/send', { method: 'POST', body: JSON.stringify({ contactIds, templateId, attachmentIds, minDelayMs, maxDelayMs }) });
    startComposeProgress(d.total);
  } catch (e) { toast(e.message, 'error'); }
});
$('#composeCancel').addEventListener('click', () => { socket.emit('cancel_campaign'); toast('Stopping after current message…', 'info'); });

let composeCounts = { sent: 0, not_registered: 0, failed: 0 };
let composeTotal = 0;
function startComposeProgress(total) {
  composeTotal = total; composeCounts = { sent: 0, not_registered: 0, failed: 0 };
  $('#composeProgress').classList.remove('hidden');
  $('#composeSend').classList.add('hidden');
  $('#composeCancel').classList.remove('hidden');
  $('#composeBar').style.width = '0%';
  $('#composeLog').textContent = '';
  $('#composeCounts').textContent = '';
  logCompose(`Starting campaign · ${total} recipient(s)`);
}
function logCompose(line) {
  const ts = new Date().toLocaleTimeString();
  const box = $('#composeLog');
  box.textContent += `${ts}  ${line}\n`;
  box.scrollTop = box.scrollHeight;
}
function endComposeProgress(headline) {
  $('#composeSend').classList.remove('hidden');
  $('#composeCancel').classList.add('hidden');
  const c = composeCounts;
  logCompose(`${headline} — ${c.sent} sent, ${c.not_registered} not on WhatsApp, ${c.failed} failed.`);
  toast(`${headline}: ${c.sent} sent, ${c.failed} failed`, 'success', 5000);
}

// ----------------------------------------------------------------- History
async function loadHistory() {
  try {
    const d = await api('/history?limit=500');
    $('#histSent').textContent = d.stats.sent;
    $('#histNotReg').textContent = d.stats.not_registered;
    $('#histFailed').textContent = d.stats.failed;
    const body = $('#historyBody');
    body.innerHTML = d.history.length ? d.history.map((r) => `
      <tr>
        <td class="muted small">${timeAgo(r.sent_at)}</td>
        <td>${esc(r.name)}</td><td class="mono">+${esc(r.phone)}</td>
        <td>${esc(r.template_name)}</td>
        <td><span class="badge ${r.status}">${statusLabel(r.status)}</span></td>
        <td>${r.media_count || 0}</td>
        <td class="muted small">${esc(r.error || '')}</td>
      </tr>`).join('') : '<tr><td colspan="7" class="empty">No history yet.</td></tr>';
  } catch (e) { toast(e.message, 'error'); }
}
$('#historyClear').addEventListener('click', async () => {
  if (!await confirmModal('Clear history', 'Delete all send history? Contacts and templates are kept.', 'Clear', true)) return;
  try { await api('/history', { method: 'DELETE' }); toast('History cleared', 'success'); loadHistory(); }
  catch (e) { toast(e.message, 'error'); }
});

// ----------------------------------------------------------------- Connect + settings
async function loadConnect() {
  try {
    const d = await api('/settings');
    $('#setMin').value = Math.round((d.settings.min_delay_ms || 4000) / 1000);
    $('#setMax').value = Math.round((d.settings.max_delay_ms || 9000) / 1000);
    $('#setCap').value = d.settings.daily_cap || 200;
  } catch (_) {}
  const cc = await api('/connection').catch(() => null);
  if (cc) { state.connection = cc.connection; renderConnection(); }
  updateConnectPage();
}
$('#connConnect').addEventListener('click', () => { socket.emit('connect_whatsapp'); toast('Starting WhatsApp engine…', 'info'); });
$('#connLogout').addEventListener('click', async () => {
  if (!await confirmModal('Unlink WhatsApp', 'Log this device out of WhatsApp Web? You will need to re-scan the QR.', 'Unlink', true)) return;
  socket.emit('logout_whatsapp'); toast('Unlinking…', 'info');
});
$('#setSave').addEventListener('click', async () => {
  try {
    await api('/settings', { method: 'POST', body: JSON.stringify({
      min_delay_ms: Number($('#setMin').value) * 1000,
      max_delay_ms: Number($('#setMax').value) * 1000,
      daily_cap: Number($('#setCap').value) }) });
    toast('Settings saved', 'success');
  } catch (e) { toast(e.message, 'error'); }
});

// ----------------------------------------------------------------- Socket.IO
const socket = io({ transports: ['websocket', 'polling'] });
socket.on('connect_error', (e) => { if (e.message === 'unauthorized') window.location.href = '/login'; });

socket.on('status', (snap) => {
  state.connection = { ...state.connection, ...snap };
  if (snap.qr && !snap.qrImage && state.connection.qrImage && snap.status !== 'qr') state.connection.qrImage = null;
  renderConnection();
});
socket.on('qr', (evt) => {
  state.connection.status = 'qr';
  state.connection.qr = evt.data;
  state.connection.qrImage = evt.image;
  state.connection.ready = false;
  renderConnection();
});
socket.on('ready', (info) => {
  state.connection.status = 'ready'; state.connection.ready = true; state.connection.info = info; state.connection.qrImage = null;
  renderConnection(); toast('WhatsApp connected 🎉', 'success');
});
socket.on('authenticated', () => { state.connection.status = 'authenticated'; renderConnection(); });
socket.on('disconnected', (e) => {
  state.connection.status = 'disconnected'; state.connection.ready = false; state.connection.info = null; state.connection.qrImage = null;
  renderConnection();
});
socket.on('auth_failure', (e) => toast('Auth failed: ' + (e.message || ''), 'error'));
socket.on('loading', (p) => { const t = $('#connTitle'); if (t && !state.connection.ready) t.textContent = `Linking… ${p.percent}%`; });
socket.on('fatal', (e) => toast('Engine error: ' + (e.message || ''), 'error', 6000));

socket.on('send_start', (e) => { /* progress UI already started on request */ });
socket.on('send_progress', (evt) => {
  composeCounts[evt.status] = (composeCounts[evt.status] || 0) + 1;
  const pct = evt.total ? Math.round((evt.index / evt.total) * 100) : 0;
  $('#composeBar').style.width = pct + '%';
  $('#composeCounts').textContent = `${composeCounts.sent} sent · ${composeCounts.not_registered} not on WA · ${composeCounts.failed} failed`;
  logCompose(`[${evt.index}/${evt.total}] +${evt.number} → ${statusLabel(evt.status)}${evt.error ? ' (' + evt.error + ')' : ''}`);
});
socket.on('send_done', () => endComposeProgress('Campaign complete'));
socket.on('cancelled', () => endComposeProgress('Campaign stopped'));
socket.on('log', (e) => { if (!$('#composeProgress').classList.contains('hidden')) logCompose(`· ${e.message}`); });

// ----------------------------------------------------------------- boot
loadDashboard();
