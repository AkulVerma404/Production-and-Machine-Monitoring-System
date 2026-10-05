'use strict';

// STATE
var API_BASE = localStorage.getItem('panel_api_base') || '';
var PANEL_TOKEN = sessionStorage.getItem('panel_token') || '';
var failCount = 0;
var cooldownActive = false;
var devices = [];
var openSerialDeviceId = null;
var serialInterval = null;
var cdTimer = null;
var cdVal = 30;
var detailsDeviceId = null;

// LOGIN
document.getElementById('lg-pass').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') doLogin();
});

async function doLogin() {
    if (cooldownActive) return;
    var url = document.getElementById('lg-url').value.trim().replace(/\/$/, '');
    var pass = document.getElementById('lg-pass').value;
    if (!url || !pass) { showLoginError('Please fill in all fields.'); return; }

    var btn = document.getElementById('login-btn');
    btn.disabled = true;
    btn.textContent = 'Authenticating…';
    hideLoginError();

    try {
        var r = await fetch(url + '/api/panel/auth', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: pass })
        });
        var j = await r.json();
        if (!r.ok) throw new Error(j.error || 'Wrong password');
        API_BASE = url;
        PANEL_TOKEN = j.token;
        localStorage.setItem('panel_api_base', API_BASE);
        sessionStorage.setItem('panel_token', PANEL_TOKEN);
        failCount = 0;
        document.getElementById('login-gate').style.display = 'none';
        document.getElementById('app').style.display = 'block';
        startAutoRefresh();
        loadDevices();
    } catch (err) {
        failCount++;
        showLoginError('⚠ ' + err.message);
        var card = document.querySelector('.login-card');
        if (card) {
            card.classList.remove('shake');
            void card.offsetWidth;
            card.classList.add('shake');
        }
        if (failCount >= 3) startCooldown();
    } finally {
        btn.disabled = false;
        btn.textContent = 'Authenticate →';
    }
}

function showLoginError(msg) {
    var el = document.getElementById('login-error');
    if (el) { el.textContent = msg; el.style.display = 'block'; }
}
function hideLoginError() { 
    var el = document.getElementById('login-error');
    if (el) el.style.display = 'none'; 
}

function startCooldown() {
    cooldownActive = true;
    var btn = document.getElementById('login-btn');
    var cd = document.getElementById('login-cooldown');
    if (btn) btn.disabled = true;
    var secs = 10;
    if (cd) {
        cd.style.display = 'block';
        cd.textContent = 'Too many attempts. Wait ' + secs + 's…';
    }
    var t = setInterval(function () {
        secs--;
        if (secs <= 0) {
            clearInterval(t);
            cooldownActive = false;
            failCount = 0;
            if (cd) cd.style.display = 'none';
            if (btn) btn.disabled = false;
        } else {
            if (cd) cd.textContent = 'Too many attempts. Wait ' + secs + 's…';
        }
    }, 1000);
}

function doLogout() {
    sessionStorage.removeItem('panel_token');
    PANEL_TOKEN = '';
    stopAutoRefresh();
    document.getElementById('app').style.display = 'none';
    document.getElementById('login-gate').style.display = 'flex';
    document.getElementById('lg-pass').value = '';
    showToast('Logged out successfully.', 'info');
}

(function () {
    if (API_BASE && PANEL_TOKEN) {
        var urlEl = document.getElementById('lg-url');
        if (urlEl) urlEl.value = API_BASE;
        document.getElementById('login-gate').style.display = 'none';
        document.getElementById('app').style.display = 'block';
        startAutoRefresh();
        loadDevices();
    }
})();

function getStatus(d) {
    if (!d.last_seen) return 'offline';
    var diffSec = (Date.now() - new Date(d.last_seen).getTime()) / 1000;
    if (diffSec > 15) return 'offline';
    if (d.status && d.status !== 'Running Normally' && d.status !== 'Unknown' && d.status !== '') return 'warning';
    if (d.idle_time !== undefined && d.idle_time > 300) return 'idle';
    return 'online';
}

function statusBadge(s) {
    if (s === 'online') return '<span class="badge bb-on">● Online</span>';
    if (s === 'idle') return '<span class="badge" style="background:#2d3340;color:var(--c1);border:1px solid #3d4350;">◷ Idle</span>';
    if (s === 'warning') return '<span class="badge bb-warn">⚠ Warning</span>';
    return '<span class="badge bb-off">✕ Offline</span>';
}

function sysAlerts(d) {
    var html = '';
    if (!d.status || d.status === 'Running Normally' || d.status === 'Unknown') {
        html = '<span style="color:var(--grn);font-size:12px;">All Systems Go</span>';
    } else {
        html = '<div style="color:var(--red);font-weight:600;font-size:12px;">' + esc(d.status) + '</div>' +
            '<div style="color:var(--mut);font-size:11px;margin-top:2px;" title="' + esc(d.error_solution) + '">' + esc(d.error_msg) + '</div>';
    }
    // Show live stroke count + lot attribution when a batch is actively running
    if (d.current_strokes > 0) {
        var lot = d.batch_lot && d.batch_lot !== 'Idle' ? esc(d.batch_lot) : 'No Lot';
        html += '<div style="margin-top:4px;font-size:11px;color:var(--c1);">' +
                '⚙ <strong>' + d.current_strokes + '</strong> strokes &nbsp;·&nbsp; Lot: <span style="color:var(--txt)">' + lot + '</span>' +
                '</div>';
    }
    return html;
}

function fmtRel(dt) {
    if (!dt) return '—';
    var diff = Math.floor((Date.now() - new Date(dt).getTime()) / 1000);
    if (diff < 60) return diff + 's ago';
    if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    return Math.floor(diff / 86400) + 'd ago';
}

function getPG(id) { return id ? id.split('-')[0] : '—'; }

async function loadDevices() {
    var stText = document.getElementById('status-text');
    if (stText) stText.textContent = 'Fetching…';
    try {
        var r = await fetch(API_BASE + '/api/devices', {
            headers: { 'x-panel-token': PANEL_TOKEN }
        });
        if (r.status === 401) { handleExpiredToken(); return; }
        if (!r.ok) throw new Error('Server error ' + r.status);
        var j = await r.json();
        devices = j.devices || [];
        renderDevices();
        if (stText) stText.textContent = 'Live · ' + new Date().toLocaleTimeString('en-IN', { hour12: false });
        
        // REFRESH PERSISTENCE: If a detail/history modal is open, update its content from the new data
        if (detailsDeviceId) {
            var exists = devices.some(function(d){ return d.device_id === detailsDeviceId; });
            if (exists) openDetails(detailsDeviceId, true); // Silent update
            else closeDetails(); // Device disappeared
        }
        if (historyDeviceId) {
            var exists = devices.some(function(d){ return d.device_id === historyDeviceId; });
            if (!exists) closeHistory(); // Device disappeared
            else loadHistory(); // Refresh history data if needed (optional, depends if history is live)
        }
    } catch (e) {
        var tbody = document.getElementById('dev-tbody');
        if (tbody) tbody.innerHTML = '<tr><td colspan="8"><div class="err-msg">⚠ ' + esc(e.message) + '</div></td></tr>';
        if (stText) stText.textContent = 'Error';
    }
    resetCountdown();
}

function renderDevices() {
    var tbody = document.getElementById('dev-tbody');
    if (!tbody) return;
    if (!devices.length) {
        tbody.innerHTML = '<tr><td colspan="8"><div class="ld">No devices found. Data appears once ESP32 devices start uploading.</div></td></tr>';
        renderKPIs([]);
        return;
    }
    renderKPIs(devices);
    var dCount = document.getElementById('dev-count');
    if (dCount) dCount.textContent = devices.length + ' device' + (devices.length !== 1 ? 's' : '');
    Array.from(tbody.querySelectorAll('tr:not([data-device-id])')).forEach(function (r) { r.remove(); });
    var currentIds = new Set(Array.from(tbody.querySelectorAll('tr[data-device-id]')).map(function (r) { return r.dataset.deviceId; }));
    var newIds = new Set(devices.map(function (d) { return d.device_id; }));
    currentIds.forEach(function (id) { 
        if (!newIds.has(id)) { 
            var el = tbody.querySelector('tr[data-device-id="' + CSS.escape(id) + '"]'); 
            if (el) el.remove(); 
        } 
    });
    devices.forEach(function (d, idx) {
        var st = getStatus(d);
        var hasPending = d.pending_commands > 0;
        var statusCell = '<td>' + statusBadge(st) + '</td>';
        var alertsCell = '<td>' + sysAlerts(d) + '</td>';
        var lastSeenCell = '<td class="mono" title="' + (d.last_seen || '') + '">' + fmtRel(d.last_seen) + '</td>';
        var batchCell = '<td><strong>' + (d.batches_today || 0) + '</strong></td>';
        var unitsCell = '<td><strong>' + Number(d.units_today || 0).toLocaleString() + '</strong></td>';
        var cmdsCell = '<td class="mono">' + (d.pending_commands || 0) + '</td>';
        var row = tbody.querySelector('tr[data-device-id="' + CSS.escape(d.device_id) + '"]');
        if (row) {
            var cells = row.querySelectorAll('td');
            if (cells[2]) cells[2].outerHTML = statusCell;
            if (cells[3]) cells[3].outerHTML = alertsCell;
            if (cells[4]) cells[4].outerHTML = lastSeenCell;
            if (cells[5]) cells[5].outerHTML = batchCell;
            if (cells[6]) cells[6].outerHTML = unitsCell;
            if (cells[7]) cells[7].outerHTML = cmdsCell;
        } else {
            var actionsCell = '<td>' +
                '<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">' +
                '<button class="br" onclick="confirmRestart(\'' + d.device_id + '\')" title="Queue restart command">⟳ Restart</button>' +
                '<button class="bp" style="background:var(--sur2);color:var(--txt);border:1px solid var(--brd);" onclick="openDetails(\'' + d.device_id + '\')">ℹ Details</button>' +
                '<button class="bg2" onclick="openPersistentSerial(\'' + d.device_id + '\')" id="serial-btn-' + idx + '">📟 Serial</button>' +
                '<div class="drop-wrap">' +
                '<button class="bpu" onclick="toggleDrop(event,' + idx + ')">⋮ Actions</button>' +
                '<div class="drop-menu" id="drop-' + idx + '">' +
                '<button class="drop-item" onclick="pingDevice(\'' + d.device_id + '\')">📡 Device Uptime Report</button>' +
                '<button class="drop-item" onclick="openHistoryModal(\'' + d.device_id + '\')">📊 View History</button>' +
                '<button class="drop-item" onclick="sendCmd(\'' + d.device_id + '\',\'CLEAR_FLAGS\')">🔄 Clear Error Flags</button>' +
                '<button class="drop-item" onclick="sendCmd(\'' + d.device_id + '\',\'FORCE_SYNC\')">⬆ Force Sync</button>' +
                '<div class="drop-sep"></div>' +
                '<button class="drop-item" onclick="openDetails(\'' + d.device_id + '\')">ℹ View Details</button>' +
                '<button class="drop-item" onclick="openFullLogs(\'' + d.device_id + '\')">📋 View Full Logs</button>' +
                '<div class="drop-sep"></div>' +
                '<button class="drop-item" onclick="resetUptime(\'' + d.device_id + '\')">⏱ Reset Uptime Counters</button>' +
                '<div class="drop-sep"></div>' +
                '<button class="drop-item danger" onclick="confirmRestart(\'' + d.device_id + '\')">⟳ Restart Device</button>' +
                '</div></div></div></td>';
            var tr = document.createElement('tr');
            tr.dataset.deviceId = d.device_id;
            tr.innerHTML = '<td><span class="mono" style="color:var(--txt);font-size:13px">' + esc(d.device_id) + '</span>' +
                (hasPending ? ' <span class="badge bb-org" title="Pending commands">' + d.pending_commands + ' cmd</span>' : '') + '</td>' +
                '<td><span class="badge bb-pur">' + esc(getPG(d.device_id)) + '</span></td>' +
                statusCell + alertsCell + lastSeenCell + batchCell + unitsCell + cmdsCell + actionsCell;
            tbody.appendChild(tr);
        }
    });
}

function renderKPIs(devs) {
    var total = devs.length, online = 0, idle = 0, warn = 0, offline = 0, cmds = 0, units = 0;
    devs.forEach(function(d) {
        var st = getStatus(d);
        if (st === 'online') online++; else if (st === 'idle') idle++; else if (st === 'warning') warn++; else offline++;
        cmds += (d.pending_commands || 0); units += Number(d.units_today || 0);
    });
    var elTotal = document.getElementById('k-total'); if (elTotal) elTotal.textContent = total;
    var elOn = document.getElementById('k-online'); if (elOn) elOn.textContent = online;
    var elWarn = document.getElementById('k-warn'); if (elWarn) elWarn.textContent = warn;
    var elOff = document.getElementById('k-offline'); if (elOff) elOff.textContent = offline;
    var elCmds = document.getElementById('k-cmds'); if (elCmds) elCmds.textContent = cmds;
    var elUnits = document.getElementById('k-units'); if (elUnits) elUnits.textContent = units.toLocaleString();
}

async function confirmRestart(did) {
    closeDrop(); 
    if (!confirm('Queue RESTART command for ' + did + '?')) return;
    await queueRestart(did);
}
async function queueRestart(did) {
    try {
        var r = await fetch(API_BASE + '/api/device/restart', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-panel-token': PANEL_TOKEN }, body: JSON.stringify({ device_id: did }) });
        if (r.status === 401) { handleExpiredToken(); return; }
        showToast('⟳ Restart queued for ' + did, 'success'); setTimeout(loadDevices, 800);
    } catch (e) { showToast('⚠ Restart failed: ' + e.message, 'error'); }
}
async function sendCmd(did, cmd) {
    closeDrop();
    try {
        var r = await fetch(API_BASE + '/api/device/command', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-panel-token': PANEL_TOKEN }, body: JSON.stringify({ device_id: did, cmd: cmd }) });
        if (r.status === 401) { handleExpiredToken(); return; }
        showToast('✓ Command queued for ' + did, 'success'); setTimeout(loadDevices, 800);
    } catch (e) { showToast('⚠ Command failed: ' + e.message, 'error'); }
}
async function pingDevice(did) {
    closeDrop();
    try {
        var r = await fetch(API_BASE + '/api/device/uptime?device_id=' + encodeURIComponent(did), { headers: { 'x-panel-token': PANEL_TOKEN } });
        if (r.status === 401) { handleExpiredToken(); return; }
        var j = await r.json(); 
        var dev = devices.find(function(i){ return i.device_id === did; });
        if (dev) showUptimeModal(dev, j.uptime || {});
    } catch (e) { showToast('⚠ Error: ' + e.message, 'error'); }
}

function fmtDuration(sec) {
    sec = Math.max(0, Math.floor(sec || 0)); if (sec < 60) return sec + 's';
    var m = Math.floor(sec / 60) % 60, h = Math.floor(sec / 3600) % 24, d = Math.floor(sec / 86400);
    var out = ''; if (d) out += d + 'd '; if (h || d) out += h + 'h '; out += m + 'm'; return out.trim();
}
function showUptimeModal(d, ut) {
    var total = (ut.online||0) + (ut.idle||0) + (ut.warning||0) + (ut.offline||0) || 1;
    var pct = function(v) { return ((v / total) * 100).toFixed(1) + '%'; };
    var bars = [ { label: 'Online', val: ut.online || 0, color: 'var(--grn)', emoji: '●' }, { label: 'Idle', val: ut.idle || 0, color: 'var(--c1)', emoji: '◷' }, { label: 'Warning', val: ut.warning || 0, color: 'var(--yel)', emoji: '⚠' }, { label: 'Offline', val: ut.offline || 0, color: 'var(--red)', emoji: '✕' } ];
    var content = '<h3 style="margin:0 0 4px;color:var(--txt)">Uptime Report</h3><div style="color:var(--mut);font-size:12px;margin-bottom:16px">' + esc(d.device_id) + '</div>';
    bars.forEach(function(b) {
        content += '<div style="margin-bottom:12px"><div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px"><span style="color:' + b.color + '">' + b.emoji + ' ' + b.label + '</span><span style="color:var(--txt)">' + fmtDuration(b.val) + ' (' + pct(b.val) + ')</span></div><div style="background:var(--brd);border-radius:4px;height:6px;overflow:hidden"><div style="background:' + b.color + ';width:' + pct(b.val) + ';height:100%;border-radius:4px;"></div></div></div>';
    });
    content += '<div style="margin-top:16px;text-align:right"><button class="bp" onclick="resetUptime(\'' + d.device_id + '\')">Reset</button></div>';
    showInfoModal('Uptime — ' + d.device_id, content);
}
function showInfoModal(title, innerHtml) {
    document.getElementById('det-title').textContent = title;
    document.getElementById('det-sub').textContent = '';
    document.getElementById('det-grid').innerHTML = '<div style="padding:0">' + innerHtml + '</div>';
    var footer = document.querySelector('#details-overlay .det-footer'); if (footer) footer.style.display = 'none';
    document.getElementById('details-overlay').classList.add('open');
}
async function resetUptime(did) {
    closeDrop();
    if (!confirm('Reset uptime?')) return;
    try {
        var r = await fetch(API_BASE + '/api/device/uptime/reset', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-panel-token': PANEL_TOKEN }, body: JSON.stringify({ device_id: did }) });
        if (r.status === 401) { handleExpiredToken(); return; }
        showToast('✓ Reset successfully', 'success');
    } catch (e) { showToast('⚠ Error: ' + e.message, 'error'); }
}

function openPersistentSerial(did) {
    openSerialDeviceId = did;
    document.getElementById('persistent-serial-panel').style.display = 'block';
    document.getElementById('persistent-serial-title').textContent = 'Serial — ' + esc(did);
    fetchPersistentLogs(did); if (serialInterval) clearInterval(serialInterval);
    serialInterval = setInterval(function () { if (openSerialDeviceId === did) fetchPersistentLogs(did); }, 5000);
}
function closePersistentSerial() { document.getElementById('persistent-serial-panel').style.display = 'none'; openSerialDeviceId = null; if (serialInterval) { clearInterval(serialInterval); serialInterval = null; } }
async function fetchPersistentLogs(did) {
    var statusEl = document.getElementById('persistent-serial-status');
    try {
        var r = await fetch(API_BASE + '/api/device/logs?device_id=' + encodeURIComponent(did) + '&limit=50', { headers: { 'x-panel-token': PANEL_TOKEN } });
        if (r.status === 401) { handleExpiredToken(); return; }
        var j = await r.json(), logs = j.logs || [], body = document.getElementById('persistent-serial-body');
        if (!logs.length) body.innerHTML = '<div class="serial-empty">No logs.</div>';
        else {
            body.innerHTML = logs.map(function (l) {
                var msgLow = (l.message || '').toLowerCase(), cls = '';
                if (msgLow.includes('error') || msgLow.includes('fail')) cls = ' err'; else if (msgLow.includes('warn')) cls = ' warn'; else if (msgLow.includes('ok') || msgLow.includes('success')) cls = ' info';
                return '<div class="log-line' + cls + '"><span class="ts">' + new Date(l.ts).toLocaleTimeString() + '</span><span class="msg">' + esc(l.message) + '</span></div>';
            }).join('');
            body.scrollTop = body.scrollHeight;
        }
        if (statusEl) statusEl.textContent = 'Updated ' + new Date().toLocaleTimeString();
    } catch (e) { if (statusEl) statusEl.textContent = 'Error'; }
}
function clearPersistentLogs() { var body = document.getElementById('persistent-serial-body'); if (body) body.innerHTML = ''; }
function copyPersistentLogs() {
    var body = document.getElementById('persistent-serial-body');
    var text = Array.from(body.querySelectorAll('.log-line')).map(function (el) { return el.textContent; }).join('\n');
    if (!text) return; navigator.clipboard.writeText(text); showToast('Copied', 'success');
}
async function openFullLogs(did) {
    closeDrop();
    try {
        var r = await fetch(API_BASE + '/api/device/logs?device_id=' + encodeURIComponent(did) + '&limit=200', { headers: { 'x-panel-token': PANEL_TOKEN } });
        var j = await r.json(), logs = j.logs || [], win = window.open('', '_blank');
        var lines = logs.map(function (l) { return new Date(l.ts).toLocaleString() + ' | ' + l.message; }).join('\n');
        win.document.write('<pre>' + esc(lines) + '</pre>');
    } catch (e) { showToast('⚠ Error', 'error'); }
}
function openSerialFromModal() { 
    var did = detailsDeviceId; 
    document.getElementById('details-overlay').classList.remove('open'); 
    detailsDeviceId = null; 
    if (did !== null) openPersistentSerial(did); 
}

function openDetails(did, silentUpdate) {
    if (!silentUpdate) closeDrop(); 
    var d = devices.find(function(i){ return i.device_id === did; });
    if (!d) return;
    detailsDeviceId = did;
    var elTitle = document.getElementById('det-title'); if (elTitle) elTitle.textContent = d.device_id;
    var elSub = document.getElementById('det-sub'); if (elSub) elSub.textContent = getStatus(d).toUpperCase();
    var st = getStatus(d);
    var strokesVal = (d.current_strokes > 0)
        ? d.current_strokes + ' strokes · Lot: ' + (d.batch_lot && d.batch_lot !== 'Idle' ? d.batch_lot : 'No Lot')
        : 'Idle (no active batch)';
    var cells = [ { lbl: 'Status', val: st }, { lbl: 'Product Group', val: getPG(d.device_id) }, { lbl: 'Last Seen', val: d.last_seen ? new Date(d.last_seen).toLocaleString() : '—' }, { lbl: 'Idle Time', val: fmtDuration(d.idle_time) }, { lbl: 'Batches Today', val: d.batches_today || 0 }, { lbl: 'Units Today', val: d.units_today || 0 }, { lbl: 'Live Strokes', val: strokesVal } ];
    var elGrid = document.getElementById('det-grid');
    if (elGrid) elGrid.innerHTML = cells.map(function (c) { return '<div class="detail-cell"><div class="lbl">' + c.lbl + '</div><div class="val">' + c.val + '</div></div>'; }).join('');
    var footer = document.querySelector('#details-overlay .det-footer'); if (footer) footer.style.display = '';
    if (!silentUpdate) document.getElementById('details-overlay').classList.add('open');
}
function closeDetails(e) {
    if (e && e.target !== document.getElementById('details-overlay')) return;
    document.getElementById('details-overlay').classList.remove('open');
    var footer = document.querySelector('#details-overlay .det-footer'); if (footer) footer.style.display = ''; detailsDeviceId = null;
}

function toggleDrop(e, idx) { e.stopPropagation(); var el = document.getElementById('drop-' + idx), isOpen = el.classList.contains('open'); closeDrop(); if (!isOpen) el.classList.add('open'); }
function closeDrop() { document.querySelectorAll('.drop-menu.open').forEach(function (m) { m.classList.remove('open'); }); }
document.addEventListener('click', function (e) { if (!e.target.closest('.drop-wrap')) closeDrop(); });

function startAutoRefresh() { stopAutoRefresh(); cdVal = 5; cdTimer = setInterval(function () { cdVal--; var el = document.getElementById('cd-val'); if (el) el.textContent = cdVal; if (cdVal <= 0) { cdVal = 5; loadDevices(); } }, 1000); }
function stopAutoRefresh() { if (cdTimer) { clearInterval(cdTimer); cdTimer = null; } }
function resetCountdown() { cdVal = 5; var el = document.getElementById('cd-val'); if (el) el.textContent = cdVal; }
function doRefresh() { loadDevices(); }
function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function handleExpiredToken() { PANEL_TOKEN = ''; stopAutoRefresh(); document.getElementById('app').style.display = 'none'; document.getElementById('login-gate').style.display = 'flex'; }
function showToast(msg, type) { var t = document.createElement('div'); t.className = 'toast ' + (type || 'info'); t.textContent = msg; var container = document.getElementById('toast-container'); if (container) container.appendChild(t); setTimeout(function () { t.remove(); }, 3500); }

var historyDeviceId = null;
function openHistoryModal(did) {
    closeDrop(); historyDeviceId = did;
    document.getElementById('hist-title').textContent = 'History — ' + esc(did);
    document.getElementById('hist-body').innerHTML = 'Loading…';
    histPreset(7, false); document.getElementById('history-overlay').classList.add('open'); loadHistory();
}
function histPreset(days, doLoad) { var today = new Date(), from = new Date(today); from.setDate(today.getDate() - (days - 1)); document.getElementById('hist-to').value = today.toISOString().slice(0, 10); document.getElementById('hist-from').value = from.toISOString().slice(0, 10); if (doLoad !== false) loadHistory(); }
async function loadHistory() {
    if (historyDeviceId === null) return; 
    var from = document.getElementById('hist-from').value, to = document.getElementById('hist-to').value;
    try {
        var r1 = await fetch(API_BASE + '/api/device/stats?device_id=' + encodeURIComponent(historyDeviceId) + '&from=' + from + '&to=' + to, { headers: { 'x-panel-token': PANEL_TOKEN } });
        var r2 = await fetch(API_BASE + '/api/device/stats/summary?device_id=' + encodeURIComponent(historyDeviceId) + '&from=' + from + '&to=' + to, { headers: { 'x-panel-token': PANEL_TOKEN } });
        var j1 = await r1.json(), j2 = await r2.json(); renderHistorySummary(j2.summary || {}); renderHistoryTable(j1.rows || []);
    } catch (e) { document.getElementById('hist-body').innerHTML = 'Error'; }
}
function renderHistorySummary(s) {
    var total = (s.online||0) + (s.idle||0) + (s.warning||0) + (s.offline||0) || 1;
    var items = [ { label: 'Online', val: s.online||0, color: 'var(--grn)' }, { label: 'Idle', val: s.idle||0, color: 'var(--c1)' }, { label: 'Warning', val: s.warning||0, color: 'var(--yel)' }, { label: 'Offline', val: s.offline||0, color: 'var(--red)' } ];
    document.getElementById('hist-summary').innerHTML = items.map(function (i) { return '<div style="flex:1"><div>' + i.label + '</div><div style="color:' + i.color + '">' + fmtDuration(i.val) + '</div></div>'; }).join('');
}
function renderHistoryTable(rows) {
    var body = document.getElementById('hist-body'); if (!rows.length) { body.innerHTML = 'No data'; return; }
    var cols = [ { key: 'online', label: 'Online', color: 'var(--grn)' }, { key: 'idle', label: 'Idle', color: 'var(--c1)' }, { key: 'warning', label: 'Warning', color: 'var(--yel)' }, { key: 'offline', label: 'Offline', color: 'var(--red)' } ];
    var rowHtml = rows.map(function (r) {
        var total = (r.online||0) + (r.idle||0) + (r.warning||0) + (r.offline||0) || 1;
        var bar = cols.map(function (c) { return '<span style="display:inline-block;width:' + ((r[c.key]||0)/total*100).toFixed(1) + '%;height:8px;background:' + c.color + ';"></span>'; }).join('');
        return '<tr><td>' + r.date + '</td>' + cols.map(function (c) { return '<td>' + fmtDuration(r[c.key]||0) + '</td>'; }).join('') + '<td>' + bar + '</td></tr>';
    }).join('');
    var thead = '<thead><tr>'
        + '<th style="text-align:left;padding:6px 10px;color:#7a839a;font-size:11px;font-weight:600;border-bottom:1px solid #2a2f3f">Date</th>'
        + cols.map(function (c) { return '<th style="padding:6px 10px;color:' + c.color + ';font-size:11px;font-weight:600;border-bottom:1px solid #2a2f3f">' + c.label + '</th>'; }).join('')
        + '<th style="padding:6px 10px;color:#7a839a;font-size:11px;font-weight:600;border-bottom:1px solid #2a2f3f">Distribution</th>'
        + '</tr></thead>';
    body.innerHTML = '<table>' + thead + '<tbody>' + rowHtml + '</tbody></table>';
}
function closeHistory(e) { if (e && e.target !== document.getElementById('history-overlay')) return; document.getElementById('history-overlay').classList.remove('open'); historyDeviceId = null; }
