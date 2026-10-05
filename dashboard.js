
    'use strict';

    // ── STATE ──────────────────────────────────────────────────────────
    let API_BASE = localStorage.getItem('api_base') || '';
    let API_KEY = localStorage.getItem('api_key') || '';
    let page = 1, totalPages = 1;
    let debTimer;
    let ctTimeline, ctGroups, ctShift;
    let allRows = [];

    // ── INIT ───────────────────────────────────────────────────────────
    document.addEventListener('DOMContentLoaded', function () {
      // Wire ALL event listeners FIRST — nothing must block these
      document.getElementById('connectBtn').addEventListener('click', saveConfig);
      document.getElementById('cfgBtn').addEventListener('click', showConfig);
      document.getElementById('refreshBtn').addEventListener('click', function () { refresh(1); });
      document.getElementById('csvBtn').addEventListener('click', exportCSV);
      document.getElementById('pdfBtn').addEventListener('click', exportPDF);
      document.getElementById('imgBtn').addEventListener('click', exportImage);
      document.getElementById('clearBtn').addEventListener('click', clearFilters);
      document.getElementById('prevBtn').addEventListener('click', function () { if (page > 1) refresh(page - 1); });
      document.getElementById('nextBtn').addEventListener('click', function () { if (page < totalPages) refresh(page + 1); });
      document.getElementById('f-shift').addEventListener('change', applyShiftFilter);
      document.getElementById('f-limit').addEventListener('change', function () { refresh(1); });
      ['f-lot', 'f-device', 'f-group'].forEach(function (id) {
        document.getElementById(id).addEventListener('input', debounce);
      });
      ['f-from', 'f-to'].forEach(function (id) {
        document.getElementById(id).addEventListener('change', function () { refresh(1); });
      });

      // Auto-connect if credentials already saved
      if (API_BASE && API_KEY) {
        document.getElementById('modal').style.display = 'none';
        var t = new Date(), w = new Date(); w.setDate(w.getDate() - 7);
        document.getElementById('f-to').value = t.toISOString().split('T')[0];
        document.getElementById('f-from').value = w.toISOString().split('T')[0];
        refresh(1);
      }

      // Init charts LAST — a Chart.js failure must NOT block buttons above
      try { initCharts(); } catch (e) { console.warn('Chart init failed:', e.message); }
    });


    // ── CONFIG ─────────────────────────────────────────────────────────
    function saveConfig() {
      API_BASE = document.getElementById('cfg-url').value.trim().replace(/\/$/, '');
      API_KEY = document.getElementById('cfg-key').value.trim();
      if (!API_BASE || !API_KEY) { alert('Please fill in both fields.'); return; }
      localStorage.setItem('api_base', API_BASE);
      localStorage.setItem('api_key', API_KEY);
      document.getElementById('modal').style.display = 'none';
      refresh(1);
    }
    function showConfig() {
      document.getElementById('cfg-url').value = API_BASE;
      document.getElementById('cfg-key').value = API_KEY;
      document.getElementById('modal').style.display = 'flex';
    }

    // ── HELPERS ────────────────────────────────────────────────────────
    function getShift(ts) {
      if (!ts) return '?';
      var d = new Date(ts);
      var ist = new Date(d.getTime() + 5.5 * 3600000);
      var min = ist.getUTCHours() * 60 + ist.getUTCMinutes();
      return (min >= 390 && min < 1110) ? 'Day' : 'Night';
    }
    function getProductionDate(ts) {
      if (!ts) return '?';
      var d = new Date(ts);
      var ist = new Date(d.getTime() + 5.5 * 3600000);
      // If time is before 6:30 AM IST (390 mins), it belongs to previous day's shift
      if ((ist.getUTCHours() * 60 + ist.getUTCMinutes()) < 390) {
        ist.setUTCDate(ist.getUTCDate() - 1);
      }
      return ist.toISOString().substring(0, 10);
    }
    function getPG(deviceId) {
      return deviceId ? deviceId.split('-')[0] : '—';
    }
    function fmtEpoch(ts) {
      if (!ts || ts < 1000000) return '—';
      return new Date(ts * 1000).toLocaleString('en-IN', { hour12: false, timeZone: 'Asia/Kolkata' });
    }
    function fmtDur(s, e) {
      if (!s || !e) return '—';
      var sec = e - s;
      if (sec < 60) return sec + 's';
      if (sec < 3600) return Math.floor(sec / 60) + 'm ' + sec % 60 + 's';
      return Math.floor(sec / 3600) + 'h ' + Math.floor((sec % 3600) / 60) + 'm';
    }
    // fmtDurSec: format a pre-computed duration in seconds (from DB `duration` field)
    function fmtDurSec(sec) {
      if (sec == null || isNaN(sec)) return '—';
      sec = parseInt(sec);
      if (sec < 60) return sec + 's';
      if (sec < 3600) return Math.floor(sec / 60) + 'm ' + sec % 60 + 's';
      return Math.floor(sec / 3600) + 'h ' + Math.floor((sec % 3600) / 60) + 'm';
    }
    // bestDur: use the authoritative `duration` DB field when available,
    // falling back to end_time - start_time for legacy records without it.
    function bestDur(r) {
      if (r.duration != null && r.duration >= 0) return fmtDurSec(r.duration);
      return fmtDur(r.start_time, r.end_time);
    }
    function bestDurSec(r) {
      if (r.duration != null && r.duration >= 0) return r.duration;
      return (r.end_time && r.start_time) ? r.end_time - r.start_time : '';
    }
    function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
    function debounce() { clearTimeout(debTimer); debTimer = setTimeout(function () { refresh(1); }, 500); }
    function loadLib(url) {
      return new Promise(function (res, rej) {
        if (document.querySelector('script[src="' + url + '"]')) return res();
        var s = document.createElement('script'); s.src = url; s.onload = res; s.onerror = rej;
        document.head.appendChild(s);
      });
    }

    // ── FETCH ──────────────────────────────────────────────────────────
    async function fetchData(p, lim) {
      var lot = document.getElementById('f-lot').value.trim();
      var dev = document.getElementById('f-device').value.trim();
      var grp = document.getElementById('f-group').value.trim();
      var from = document.getElementById('f-from').value;
      var to = document.getElementById('f-to').value;
      if (grp && !dev) dev = grp;
      var qs = new URLSearchParams({ page: p, limit: lim });
      if (lot) qs.set('lot_id', lot);
      if (dev) qs.set('device_id', dev);
      if (from) qs.set('from', from);
      if (to) qs.set('to', to);
      var r = await fetch(API_BASE + '/api/data?' + qs, { headers: { 'x-dashboard-key': API_KEY } });
      if (!r.ok) throw new Error('Server responded with ' + r.status);
      var json = await r.json();
      if (!json || !Array.isArray(json.data)) throw new Error('Unexpected API response — check that server.js GET /api/data is deployed');
      return json;
    }

    // ── REFRESH ────────────────────────────────────────────────────────
    async function refresh(p) {
      page = p || 1;
      var lim = parseInt(document.getElementById('f-limit').value);
      document.getElementById('tbody').innerHTML = '<tr><td colspan="11"><div class="ld"><div class="spin"></div>Loading...</div></td></tr>';
      document.getElementById('status-text').textContent = 'Fetching...';
      try {
        var res = await fetchData(page, lim);
        allRows = res.data;
        totalPages = res.meta.totalPages || 1;
        // Compute filtered subset once — all render functions use it
        var shft = document.getElementById('f-shift').value;
        var rows = shft ? allRows.filter(function (r) { return getShift(r.start_time * 1000) === shft; }) : allRows;
        renderTable(rows);
        renderKPIs(rows, res.meta);
        renderShifts(rows);
        renderCharts(rows);
        renderPages(page, totalPages, res.meta.total);
        document.getElementById('rcnt').textContent = rows.length + ' of ' + (res.meta.total || allRows.length) + ' records';
        document.getElementById('status-text').textContent = 'Live';
      } catch (e) {
        document.getElementById('tbody').innerHTML = '<tr><td colspan="11"><div class="err">⚠ ' + esc(e.message) + '</div></td></tr>';
        document.getElementById('status-text').textContent = 'Error';
      }
    }
    function applyShiftFilter() {
      var shft = document.getElementById('f-shift').value;
      // Use start_time (epoch seconds) for shift detection — consistent with getShift throughout
      var rows = shft ? allRows.filter(function (r) { return getShift(r.start_time * 1000) === shft; }) : allRows;
      renderTable(rows);
      renderKPIs(rows, { total: rows.length, totalUnits: rows.reduce(function(s,r){ return s + (r.units_produced||0); }, 0), uniqueLots: new Set(rows.map(function(r){ return r.lot_id; })).size, uniqueDevices: new Set(rows.map(function(r){ return r.device_id; })).size });
      renderShifts(rows);
      renderCharts(rows);
      document.getElementById('rcnt').textContent = rows.length + ' of ' + allRows.length + (shft ? ' (shift filter)' : ' records');
    }
    function clearFilters() {
      ['f-lot', 'f-device', 'f-group', 'f-from', 'f-to'].forEach(function (id) { document.getElementById(id).value = ''; });
      document.getElementById('f-shift').value = '';
      refresh(1);
    }

    // ── TABLE ──────────────────────────────────────────────────────────
    function renderTable(rows) {
      if (!rows.length) { document.getElementById('tbody').innerHTML = '<tr><td colspan="11"><div class="ld">No records match.</div></td></tr>'; return; }
      document.getElementById('tbody').innerHTML = rows.map(function (r) {
        var shift = getShift(r.start_time * 1000);
        var sb = shift === 'Day' ? '<span class="badge bby">&#9728; Day</span>' : '<span class="badge bbp">&#127769; Night</span>';
        var isPartial = r.notes === 'PARTIAL_RECOVERY';
        var lotBadge = isPartial
          ? '<span class="badge bbw" title="\u26A0 Partial recovery: data from this lot was salvaged after a device reboot mid-operation. Count may be incomplete.">\u26A0 ' + esc(r.lot_id) + '</span>'
          : '<span class="badge bba">' + esc(r.lot_id) + '</span>';
        return '<tr' + (isPartial ? ' class="row-partial"' : '') + '><td class="mono">' + r.id + '</td><td>' + sb + '</td>'
          + '<td><span class="badge bbo">' + esc(getPG(r.device_id)) + '</span></td>'
          + '<td>' + lotBadge + '</td>'
          + '<td><strong>' + r.units_produced + '</strong></td>'
          + '<td class="mono">' + esc(r.device_id) + '</td>'
          + '<td class="mono">' + fmtEpoch(r.start_time) + '</td>'
          + '<td class="mono">' + fmtEpoch(r.end_time) + '</td>'
          + '<td><span class="badge bbg">' + bestDur(r) + '</span></td>'
          + '<td class="mono">' + (r.created_at ? new Date(r.created_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : '-') + '</td>'
          + '<td class="mono" title="' + (r.batch_uuid || '') + '">' + (r.batch_uuid ? r.batch_uuid.substring(0, 8) + '...' : '-') + '</td></tr>';
      }).join('');
    }

    // ── KPIs ───────────────────────────────────────────────────────────
    function renderKPIs(rows, meta) {
      var day = rows.filter(function (r) { return getShift(r.start_time * 1000) === 'Day'; });
      var night = rows.filter(function (r) { return getShift(r.start_time * 1000) === 'Night'; });
      var du = day.reduce(function (s, r) { return s + (r.units_produced || 0); }, 0);
      var nu = night.reduce(function (s, r) { return s + (r.units_produced || 0); }, 0);
      var t = meta.totalUnits || rows.reduce(function (s, r) { return s + (r.units_produced || 0); }, 0);
      var b = meta.total || rows.length;
      var gs = new Set(rows.map(function (r) { return getPG(r.device_id); }));
      document.getElementById('k-bat').textContent = (+b).toLocaleString();
      document.getElementById('k-uni').textContent = (+t).toLocaleString();
      document.getElementById('k-avg').textContent = b > 0 ? Math.round(t / b).toLocaleString() : '—';
      document.getElementById('k-lot').textContent = (meta.uniqueLots || new Set(rows.map(function (r) { return r.lot_id; })).size).toLocaleString();
      document.getElementById('k-dev').textContent = (meta.uniqueDevices || new Set(rows.map(function (r) { return r.device_id; })).size).toLocaleString();
      document.getElementById('k-day').textContent = du.toLocaleString();
      document.getElementById('k-ngt').textContent = nu.toLocaleString();
      document.getElementById('k-grp').textContent = gs.size;
    }

    // ── SHIFT PANEL ────────────────────────────────────────────────────
    function renderShifts(rows) {
      var day = rows.filter(function (r) { return getShift(r.start_time * 1000) === 'Day'; });
      var night = rows.filter(function (r) { return getShift(r.start_time * 1000) === 'Night'; });
      var du = day.reduce(function (s, r) { return s + (r.units_produced || 0); }, 0);
      var nu = night.reduce(function (s, r) { return s + (r.units_produced || 0); }, 0);
      document.getElementById('sd-u').textContent = du.toLocaleString();
      document.getElementById('sd-b').textContent = day.length;
      document.getElementById('sd-a').textContent = day.length ? Math.round(du / day.length) : '—';
      document.getElementById('sn-u').textContent = nu.toLocaleString();
      document.getElementById('sn-b').textContent = night.length;
      document.getElementById('sn-a').textContent = night.length ? Math.round(nu / night.length) : '—';
    }

    // ── CHARTS ─────────────────────────────────────────────────────────
    var CLRS = ['#4f8ef7', '#7c5ce4', '#00d97e', '#f5c842', '#f05c5c', '#ff9f43', '#42c5f5', '#a29bfe', '#fd79a8', '#55efc4'];
    var AX = { ticks: { color: '#7a839a', font: { size: 10 } }, grid: { color: '#2a2f3f' } };

    function initCharts() {
      ctTimeline = new Chart(document.getElementById('cTimeline').getContext('2d'), {
        type: 'bar',
        data: {
          labels: [], datasets: [
            { label: 'Day', data: [], backgroundColor: 'rgba(245,200,66,.6)', borderColor: '#f5c842', borderWidth: 1, borderRadius: 3 },
            { label: 'Night', data: [], backgroundColor: 'rgba(124,92,228,.6)', borderColor: '#7c5ce4', borderWidth: 1, borderRadius: 3 }
          ]
        },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { color: '#7a839a', font: { size: 11 }, boxWidth: 12 } } }, scales: { x: AX, y: AX } }
      });
      ctGroups = new Chart(document.getElementById('cGroups').getContext('2d'), {
        type: 'doughnut',
        data: { labels: [], datasets: [{ data: [], backgroundColor: CLRS, borderWidth: 0, hoverOffset: 5 }] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'right', labels: { color: '#7a839a', font: { size: 10 }, boxWidth: 11, padding: 9 } } } }
      });
      ctShift = new Chart(document.getElementById('cShift').getContext('2d'), {
        type: 'doughnut',
        data: { labels: ['☀ Day', '🌙 Night'], datasets: [{ data: [0, 0], backgroundColor: ['#f5c842', '#7c5ce4'], borderWidth: 0, hoverOffset: 5 }] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'right', labels: { color: '#7a839a', font: { size: 11 }, boxWidth: 12, padding: 10 } } } }
      });
    }

    function renderCharts(rows) {
      if (!ctTimeline || !ctGroups || !ctShift) return;
      var byDate = {};
      rows.forEach(function (r) {
        // Use shift-adjusted production date (start_time, epoch seconds → ms)
        // so early-morning night-shift batches land on the *previous* calendar day
        var d = getProductionDate(r.start_time * 1000);
        var s = getShift(r.start_time * 1000);
        if (!byDate[d]) byDate[d] = { Day: 0, Night: 0 };
        byDate[d][s] += (r.units_produced || 0);
      });
      var dates = Object.keys(byDate).sort();
      ctTimeline.data.labels = dates;
      ctTimeline.data.datasets[0].data = dates.map(function (d) { return byDate[d].Day; });
      ctTimeline.data.datasets[1].data = dates.map(function (d) { return byDate[d].Night; });
      ctTimeline.update();

      var byGrp = {};
      rows.forEach(function (r) { var g = getPG(r.device_id); byGrp[g] = (byGrp[g] || 0) + (r.units_produced || 0); });
      var sg = Object.entries(byGrp).sort(function (a, b) { return b[1] - a[1]; });
      ctGroups.data.labels = sg.map(function (x) { return x[0]; });
      ctGroups.data.datasets[0].data = sg.map(function (x) { return x[1]; });
      ctGroups.update();

      var du = rows.filter(function (r) { return getShift(r.start_time * 1000) === 'Day'; }).reduce(function (s, r) { return s + (r.units_produced || 0); }, 0);
      var nu = rows.filter(function (r) { return getShift(r.start_time * 1000) === 'Night'; }).reduce(function (s, r) { return s + (r.units_produced || 0); }, 0);
      ctShift.data.datasets[0].data = [du, nu];
      ctShift.update();
    }

    // ── PAGINATION ─────────────────────────────────────────────────────
    function renderPages(p, tot, cnt) {
      document.getElementById('prevBtn').disabled = (p <= 1);
      document.getElementById('nextBtn').disabled = (p >= tot);
      document.getElementById('pinfo').textContent = 'Page ' + p + ' of ' + tot + ' · ' + (cnt || 0) + ' records';
      var c = document.getElementById('pnums'); c.innerHTML = '';
      for (var i = Math.max(1, p - 2); i <= Math.min(tot, p + 2); i++) {
        var b = document.createElement('button');
        b.className = 'pbtn' + (i === p ? ' act' : '');
        b.textContent = i;
        (function (n) { b.addEventListener('click', function () { refresh(n); }); })(i);
        c.appendChild(b);
      }
    }

    // ── EXPORTS ────────────────────────────────────────────────────────
    async function exportCSV() {
      var btn = document.getElementById('csvBtn'); btn.textContent = '⏳ CSV...';
      try {
        var res = await fetchData(1, 10000);
        var rows = res.data;
        var hdr = ['#', 'Shift', 'Group', 'Lot ID', 'Units', 'Device ID', 'Start', 'End', 'Duration(s)', 'Recorded At', 'UUID', 'Notes'];
        var body = rows.map(function (r) { return [r.id, getShift(r.created_at), getPG(r.device_id), '"' + r.lot_id + '"', r.units_produced, r.device_id, fmtEpoch(r.start_time), fmtEpoch(r.end_time), bestDurSec(r), r.created_at, r.batch_uuid, r.notes || '']; });
        var csv = [hdr].concat(body).map(function (r) { return r.join(','); }).join('\n');
        var a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
        a.download = 'production_' + new Date().toISOString().split('T')[0] + '.csv'; a.click();
      } catch (e) { alert('CSV failed: ' + e.message); }
      btn.textContent = '↓ CSV';
    }

    async function exportPDF() {
      var btn = document.getElementById('pdfBtn'); btn.textContent = '⏳ PDF...';
      try {
        await loadLib('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js');
        await loadLib('https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js');
        var res = await fetchData(1, 10000);
        var rows = res.data;
        var doc = new window.jspdf.jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
        doc.setFontSize(17); doc.setTextColor(40, 40, 40); doc.text('Production Report', 14, 15);
        doc.setFontSize(9); doc.setTextColor(120, 120, 120); doc.text('Generated: ' + new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }), 14, 22);
        var head = [['#', 'Shift', 'Group', 'Lot ID', 'Units', 'Device ID', 'Start', 'End', 'Duration', 'Recorded At']];
        var body = rows.map(function (r) { return [r.id, getShift(r.created_at), getPG(r.device_id), r.lot_id, r.units_produced, r.device_id, fmtEpoch(r.start_time), fmtEpoch(r.end_time), bestDur(r), r.created_at ? new Date(r.created_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : '']; });
        doc.autoTable({ startY: 28, head: head, body: body, headStyles: { fillColor: [30, 34, 48], textColor: 200, fontSize: 8, fontStyle: 'bold' }, bodyStyles: { fontSize: 7.5, textColor: 40 }, alternateRowStyles: { fillColor: [245, 246, 250] }, margin: { left: 14, right: 14 } });
        var pages = doc.internal.getNumberOfPages();
        for (var i = 1; i <= pages; i++) { doc.setPage(i); doc.setFontSize(8); doc.setTextColor(160); doc.text('Page ' + i + ' of ' + pages + ' | Industrial Production Monitor', 14, doc.internal.pageSize.height - 8); }
        doc.save('production_' + new Date().toISOString().split('T')[0] + '.pdf');
      } catch (e) { alert('PDF failed: ' + e.message); }
      btn.textContent = '↓ PDF';
    }

    async function exportImage() {
      var btn = document.getElementById('imgBtn'); btn.textContent = '⏳ Image...';
      try {
        await loadLib('https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js');
        var canvas = await window.html2canvas(document.querySelector('.tcard'), { backgroundColor: '#161920', scale: 2, useCORS: true, logging: false });
        var a = document.createElement('a'); a.download = 'production_' + new Date().toISOString().split('T')[0] + '.png';
        a.href = canvas.toDataURL('image/png'); a.click();
      } catch (e) { alert('Image failed: ' + e.message); }
      btn.textContent = '↓ Image';
    }
  