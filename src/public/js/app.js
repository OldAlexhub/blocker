'use strict';

(() => {
  const csrf = document.querySelector('meta[name="csrf-token"]').content;
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const DURATIONS = [
    ['60', '1 hour'], ['30', '30 min'], ['15', '15 min'], ['120', '2 hours'], ['240', '4 hours'],
    ['480', '8 hours'], ['720', '12 hours'], ['1440', '24 hours'], ['next', 'Until next schedule change'],
  ];
  const POLL_MS = 20_000;

  let state = null;
  let editingNameId = null;
  let scheduleDeviceKey = '';
  const durationChoice = new Map();
  let showOffline = localGet('showOffline') === '1';

  const $ = (s, root = document) => root.querySelector(s);
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  function localGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
  function localSet(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } }

  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 401) { location.href = '/login'; throw new Error('Session expired'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
    return data;
  }

  function notify(message, kind = 'info', ms = 7000) {
    const el = document.createElement('div');
    el.className = `alert alert-${kind} alert-dismissible py-2 small`;
    el.innerHTML = `${esc(message)}<button type="button" class="btn-close btn-sm" aria-label="Close"></button>`;
    el.querySelector('button').onclick = () => el.remove();
    $('#alerts').prepend(el);
    if (ms) setTimeout(() => el.remove(), ms);
  }

  const tz = () => state?.status?.timezone || undefined;
  function fmtTime(iso, withDate = false) {
    if (!iso) return '—';
    const d = new Date(iso);
    const opts = { timeZone: tz(), hour: 'numeric', minute: '2-digit' };
    if (withDate) Object.assign(opts, { month: 'short', day: 'numeric' });
    const sameDay = new Date().toDateString() === d.toDateString();
    if (!withDate && !sameDay) Object.assign(opts, { weekday: 'short' });
    return new Intl.DateTimeFormat(undefined, opts).format(d);
  }
  function fmtHM(hm) {
    const [h, m] = hm.split(':').map(Number);
    const d = new Date(Date.UTC(2000, 0, 1, h, m));
    return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }).format(d);
  }
  const deviceLabel = (d) => d.display_name || d.hostname || d.mac_address;
  const badge = (text, kind) => `<span class="badge text-bg-${kind}">${esc(text)}</span>`;

  // ---------------- status ----------------
  function renderStatus() {
    const s = state.status;
    const mode = s.standby
      ? badge('STANDBY — previous version still running; read-only', 'warning')
      : s.armed
      ? badge('ARMED — router changes enabled', 'danger')
      : s.dryRun
        ? badge('DRY RUN — no router changes', 'info')
        : badge('DISARMED — no router changes', 'secondary');
    const router = s.routerError
      ? `${badge('Unreachable', 'danger')} <span class="small text-secondary">${esc(s.routerError)}${s.nextRouterAttemptAt ? ` · retry ${fmtTime(s.nextRouterAttemptAt)}` : ''}</span>`
      : s.lastRouterOkAt ? badge('Connected', 'success') : badge('Not checked yet', 'secondary');
    const ac = s.accessControlEnabled === true ? badge('On', 'success') : s.accessControlEnabled === false ? badge('Off', 'warning') : badge('Unknown', 'secondary');
    const engineAge = s.lastTickAt ? (Date.now() - new Date(s.lastTickAt)) / 1000 : Infinity;
    const engine = s.standby
      ? badge('Waiting to take over', 'warning')
      : !s.schedulerEnabled
      ? badge('Scheduler off (SCHEDULER_ENABLED=false)', 'warning')
      : engineAge < 150 ? badge('Running', 'success') : badge('Stalled', 'danger');

    let control = '';
    if (s.armed) control = '<button class="btn btn-sm btn-outline-danger" data-act="disarm">Restore all &amp; disarm</button>';
    else if (!s.dryRun) control = '<button class="btn btn-sm btn-danger" data-act="arm">Arm router control…</button>';
    else control = '<button class="btn btn-sm btn-outline-secondary" data-act="check">Test router connection</button>';

    $('#status').innerHTML = `
      <div class="status-item"><span class="label">Mode</span><span class="value">${mode}</span></div>
      <div class="status-item"><span class="label">Scheduling engine</span><span class="value">${engine}</span></div>
      <div class="status-item"><span class="label">Router ${esc(s.routerHost)}${s.adapter === 'mock' ? ' (mock)' : ''}</span><span class="value">${router}</span></div>
      <div class="status-item"><span class="label">Access Control</span><span class="value">${ac}</span></div>
      <div class="status-item"><span class="label">Devices refreshed</span><span class="value">${fmtTime(s.lastPollAt)}</span></div>
      <div class="ms-auto">${control}</div>`;
    $('#footer-note').textContent = `Times shown in ${s.timezone}. Page updates every ${POLL_MS / 1000}s.`;
  }

  // ---------------- devices ----------------
  function internetCell(d) {
    const parts = [];
    if (d.protected) parts.push(badge('Protected', 'dark'));
    const live = d.is_online ? d.router_status : null;
    if (live === 'Block') parts.push(badge('Blocked', 'danger') + ' <span class="device-sub text-secondary">router-confirmed</span>');
    else if (live === 'Allow') parts.push(badge('Allowed', 'success'));
    else parts.push(badge(d.is_online ? 'Unknown' : 'Offline', 'secondary') + (d.router_status ? ` <span class="device-sub text-secondary">last: ${esc(d.router_status)}</span>` : ''));

    const sub = [];
    if (!state.status.armed && d.dry_state) sub.push(`Dry run: would be ${d.dry_state === 'Block' ? 'blocked' : 'allowed'}`);
    if (d.desired && !d.protected) {
      const want = d.desired === 'block' ? 'Blocked' : 'Allowed';
      const target = d.desired === 'block' ? 'Block' : 'Allow';
      const why = d.desired_reason === 'schedule' ? ` (${d.active_schedules.join(', ')})` : d.desired_reason === 'override' ? ' (override)' : '';
      if (live !== target) sub.push(`<strong>Should be: ${want}${esc(why)}</strong>`);
    }
    if (d.override) {
      sub.push(`Override: ${d.override.type === 'block' ? 'blocked' : 'allowed'} until ${fmtTime(d.override.expires_at)} <a href="#" data-act="clear-override" data-id="${d.id}">clear</a>`);
    } else if (d.next_change && d.restrictions_enabled) {
      sub.push(`Next change ${fmtTime(d.next_change)}`);
    }
    if (d.last_result === 'failed') sub.push(`<span class="text-danger">Last attempt failed${d.next_attempt_at ? `, retry ${fmtTime(d.next_attempt_at)}` : ''}</span>`);
    else if (d.last_result === 'unverified') sub.push('<span class="text-warning-emphasis">Last command unverified</span>');
    return `${parts.join(' ')}${sub.length ? `<div class="device-sub mt-1">${sub.join('<br>')}</div>` : ''}`;
  }

  function renderDevices() {
    if (editingNameId !== null) return; // don't clobber an open rename field
    const rows = state.devices.filter((d) => showOffline || d.is_online || d.app_blocked || d.restrictions_enabled);
    if (!rows.length) {
      $('#devices-body').innerHTML = `<tr><td colspan="5" class="text-secondary small p-3">${state.devices.length ? 'No online devices. Turn on "Show offline".' : 'No devices yet. Click "Refresh from router".'}</td></tr>`;
      return;
    }
    $('#devices-body').innerHTML = rows.map((d) => {
      const tags = [];
      if (!d.is_online) tags.push(badge('offline', 'light'));
      if (d.randomized_mac) tags.push('<span class="badge text-bg-warning" title="Private/random Wi-Fi address: it can change and escape schedules">private MAC</span>');
      if (d.connection_type) tags.push(`<span class="text-secondary">${esc(d.connection_type)}</span>`);
      const dur = durationChoice.get(d.id) ?? '60';
      const controls = d.protected
        ? `<span class="small text-secondary">${esc(d.protected_reason || 'Protected')}</span>`
        : `<div class="manual-controls">
             <select class="form-select form-select-sm" data-dur="${d.id}" aria-label="Duration">
               ${DURATIONS.map(([v, l]) => `<option value="${v}"${v === dur ? ' selected' : ''}>${l}</option>`).join('')}
             </select>
             <button class="btn btn-sm btn-outline-danger" data-act="block" data-id="${d.id}">Block</button>
             <button class="btn btn-sm btn-outline-success" data-act="allow" data-id="${d.id}">Restore</button>
           </div>`;
      const managed = d.protected
        ? '—'
        : `<div class="form-check form-switch d-inline-block m-0"><input class="form-check-input" type="checkbox" data-act="managed" data-id="${d.id}" ${d.restrictions_enabled ? 'checked' : ''} aria-label="Managed"></div>`;
      return `<tr class="${d.is_online ? '' : 'row-offline'}">
        <td>
          <div class="device-name">${esc(deviceLabel(d))} <a href="#" class="small" data-act="rename" data-id="${d.id}">rename</a></div>
          <div class="device-meta"><span class="mono">${esc(d.mac_address)}</span>${d.display_name && d.hostname ? ` · ${esc(d.hostname)}` : ''} ${tags.join(' ')}</div>
          <div class="device-meta d-md-none mono">${esc(d.ip_address || '')}</div>
        </td>
        <td class="d-none d-md-table-cell mono small">${esc(d.ip_address || '—')}</td>
        <td>${internetCell(d)}</td>
        <td class="text-center">${managed}</td>
        <td class="text-end">${controls}
          ${!d.protected ? `<div class="mt-1"><a href="#" class="small text-secondary" data-act="protect" data-id="${d.id}">mark protected</a></div>` : !d.auto_protected ? `<div class="mt-1"><a href="#" class="small text-secondary" data-act="unprotect" data-id="${d.id}">unprotect</a></div>` : ''}
        </td>
      </tr>`;
    }).join('');
  }

  // ---------------- schedules ----------------
  function renderScheduleForm() {
    if (!$('#sched-days').children.length) {
      $('#sched-days').innerHTML = DAYS.map((d, i) =>
        `<input type="checkbox" class="btn-check" id="day-${i}" value="${i}" autocomplete="off" ${i <= 4 ? 'checked' : ''}>
         <label class="btn btn-sm btn-outline-primary" for="day-${i}">${d}</label>`).join('');
    }
    const eligible = state.devices.filter((d) => !d.protected);
    const key = eligible.map((d) => `${d.id}:${deviceLabel(d)}`).join('|');
    if (key === scheduleDeviceKey) return;
    const checked = new Set([...document.querySelectorAll('#sched-devices input:checked')].map((i) => Number(i.value)));
    scheduleDeviceKey = key;
    $('#sched-devices').innerHTML = eligible.length
      ? eligible.map((d) => `<div class="form-check form-check-inline m-0">
          <input class="form-check-input" type="checkbox" id="sd-${d.id}" value="${d.id}" ${checked.has(d.id) ? 'checked' : ''}>
          <label class="form-check-label small" for="sd-${d.id}">${esc(deviceLabel(d))}</label></div>`).join('')
      : '<span class="small text-secondary">No devices discovered yet.</span>';
  }

  function daysText(days) {
    const s = [...days].sort().join(',');
    if (s === '0,1,2,3,4,5,6') return 'Every day';
    if (s === '1,2,3,4,5') return 'Mon–Fri';
    if (s === '0,6') return 'Weekends';
    if (s === '0,1,2,3,4') return 'Sun–Thu';
    return days.map((d) => DAYS[d]).join(', ');
  }

  function renderSchedules() {
    const byId = new Map(state.devices.map((d) => [d.id, d]));
    $('#schedules-body').innerHTML = state.schedules.length
      ? state.schedules.map((s) => `<tr>
          <td>${esc(s.name)} ${s.active_now ? badge('active now', 'danger') : ''}</td>
          <td class="text-nowrap">${fmtHM(s.start_time)} → ${fmtHM(s.end_time)}${s.overnight ? ' <span class="badge text-bg-light">overnight</span>' : ''}</td>
          <td class="small">${esc(daysText(s.days_of_week))}</td>
          <td class="d-none d-md-table-cell small">${s.device_ids.map((id) => esc(byId.get(id) ? deviceLabel(byId.get(id)) : `#${id}`)).join(', ')}</td>
          <td><div class="form-check form-switch m-0"><input class="form-check-input" type="checkbox" data-act="sched-toggle" data-id="${s.id}" ${s.enabled ? 'checked' : ''} aria-label="Enabled"></div></td>
          <td class="text-end text-nowrap">
            <button class="btn btn-sm btn-outline-secondary" data-act="sched-edit" data-id="${s.id}">Edit</button>
            <button class="btn btn-sm btn-outline-danger" data-act="sched-delete" data-id="${s.id}">Delete</button>
          </td></tr>`).join('')
      : '<tr><td colspan="6" class="text-secondary small p-3">No schedules yet.</td></tr>';
  }

  function resetScheduleForm() {
    $('#sched-id').value = '';
    $('#sched-name').value = '';
    $('#sched-start').value = '21:00';
    $('#sched-end').value = '07:00';
    $('#sched-enabled').checked = true;
    DAYS.forEach((_, i) => { $(`#day-${i}`).checked = i <= 4; });
    document.querySelectorAll('#sched-devices input').forEach((i) => { i.checked = false; });
    $('#sched-save').textContent = 'Save schedule';
    $('#sched-cancel').classList.add('d-none');
    updateHint();
  }

  function updateHint() {
    const a = $('#sched-start').value;
    const b = $('#sched-end').value;
    $('#sched-hint').textContent = a && b && a > b ? 'Overnight: access returns the next morning.' : '';
  }

  // ---------------- activity ----------------
  const RESULT_KIND = { verified: 'success', unverified: 'warning', requested: 'secondary', failed: 'danger', dry_run: 'info', skipped: 'secondary', info: 'light' };
  function renderActivity() {
    $('#activity-body').innerHTML = state.activity.length
      ? state.activity.map((a) => `<tr>
          <td class="text-nowrap">${fmtTime(a.created_at, true)}</td>
          <td>${esc(a.device_label || '—')}</td>
          <td>${esc(a.action.replace(/_/g, ' '))} <span class="text-secondary small">${esc(a.trigger)}</span></td>
          <td>${badge(a.result === 'dry_run' ? 'dry run' : a.result, RESULT_KIND[a.result] || 'secondary')}</td>
          <td class="d-none d-lg-table-cell small text-secondary">${esc(a.detail || '')}</td></tr>`).join('')
      : '<tr><td colspan="5" class="text-secondary small p-3">No activity yet.</td></tr>';
  }

  // ---------------- router health ----------------
  let health = null;
  const fmtMb = (mb) => {
    if (mb === null || mb === undefined) return '—';
    if (mb >= 1024) return `${(mb / 1024).toFixed(mb >= 10240 ? 0 : 1)} GB`;
    return `${mb >= 100 ? Math.round(mb) : mb.toFixed(1)} MB`;
  };
  const levelKind = (v, warn, bad) => (v === null ? 'secondary' : v >= bad ? 'danger' : v >= warn ? 'warning' : 'success');

  function meter(label, value, warn, bad, sub) {
    const kind = levelKind(value, warn, bad);
    return `<div class="health-meter">
      <div class="label">${esc(label)}</div>
      <div class="big text-${kind === 'success' ? 'body' : kind}">${value === null ? '—' : `${value}%`}</div>
      <div class="progress" role="progressbar" aria-label="${esc(label)}" aria-valuenow="${value ?? 0}" aria-valuemin="0" aria-valuemax="100">
        <div class="progress-bar bg-${kind}" data-pct="${value ?? 0}"></div>
      </div>
      <div class="small text-secondary mt-1">${sub}</div>
    </div>`;
  }

  function renderHealth() {
    const h = health;
    if (!h) return;
    $('#health-checked').textContent = h.checkedAt ? `Checked ${fmtTime(h.checkedAt)}` : '';
    if (h.restarting) {
      $('#health-warnings').innerHTML = `<div class="alert alert-info py-2 small mb-3">Router is restarting. Internet should be back around ${fmtTime(h.restartingUntil)}.</div>`;
      $('#health').innerHTML = '';
      return;
    }
    if (!h.ok) {
      $('#health-warnings').innerHTML = '';
      $('#health').innerHTML = `<div class="small text-${h.unsupported ? 'secondary' : 'danger'}">${esc(h.unsupported ? 'This router adapter cannot report health.' : `Could not read router health: ${h.error}`)}</div>`;
      return;
    }
    $('#health-warnings').innerHTML = h.warnings.map((w) => `<div class="alert alert-warning py-2 small mb-3">${esc(w)}</div>`).join('');
    const cpuSub = h.cpuPercent === null ? 'Not reported' : h.cpuPercent >= 80 ? 'Overloaded: the network will feel slow' : h.cpuPercent >= 50 ? 'Busy' : 'Normal';
    const memSub = h.memoryPercent === null ? 'Not reported' : `${h.memoryTotalMb ? `of ${h.memoryTotalMb} MB · ` : ''}${h.memoryPercent >= 90 ? 'Nearly full' : h.memoryPercent >= 75 ? 'High' : 'Normal'}`;
    const t = h.traffic;
    const row = (name, p) => `<tr><th class="fw-normal text-secondary">${name}</th><td class="text-end">${fmtMb(p?.downloadMb)}</td><td class="text-end">${fmtMb(p?.uploadMb)}</td></tr>`;
    const traffic = t
      ? `<div class="health-traffic">
          <div class="health-label">Internet usage (all devices)</div>
          <table><thead><tr><th></th><th class="text-end small text-secondary fw-normal">Down</th><th class="text-end small text-secondary fw-normal">Up</th></tr></thead>
          <tbody>${row('Today', t.today)}${row('Yesterday', t.yesterday)}${row('This month', t.month)}${row('Last month', t.lastMonth)}</tbody></table>
          ${h.trafficMeterEnabled === false ? '<div class="small text-secondary mt-1">Traffic Meter is off on the router, so these totals may be incomplete.</div>' : ''}
        </div>`
      : '<div class="small text-secondary">Traffic totals not available.</div>';
    $('#health').innerHTML = meter('Router CPU', h.cpuPercent, 50, 80, cpuSub) + meter('Router memory', h.memoryPercent, 75, 90, memSub) + traffic;
    // CSP forbids inline style attributes; set widths through the CSSOM instead.
    document.querySelectorAll('#health [data-pct]').forEach((el) => { el.style.width = `${Math.max(0, Math.min(100, Number(el.dataset.pct)))}%`; });
  }

  async function loadHealth() {
    try {
      health = await api('GET', '/api/router/health');
    } catch (err) {
      health = { ok: false, error: err.message };
    }
    renderHealth();
  }

  // ---------------- load ----------------
  async function load() {
    try {
      state = await api('GET', '/api/state');
      renderStatus();
      renderDevices();
      renderScheduleForm();
      renderSchedules();
      renderActivity();
    } catch (err) {
      notify(`Could not load dashboard data: ${err.message}`, 'danger');
    }
  }

  async function act(fn, okMsg) {
    try {
      const r = await fn();
      if (okMsg) notify(typeof okMsg === 'function' ? okMsg(r) : okMsg, 'success');
    } catch (err) {
      notify(err.message, 'danger', 12000);
    }
    await load();
  }

  const resultMsg = (verb) => (r) => {
    if (!r.armed) return `${verb} recorded. Dry run: no router command sent (see Activity).`;
    return {
      verified: `${verb} applied and verified by the router.`,
      unverified: `${verb} sent, but the router could not confirm it (device offline?).`,
      failed: `${verb} failed. See Activity.`,
    }[r.result] ?? `${verb} recorded.`;
  };

  // ---------------- events ----------------
  document.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-act]');
    if (!el || el.tagName === 'INPUT') return;
    e.preventDefault();
    const id = Number(el.dataset.id);
    const d = state?.devices.find((x) => x.id === id);
    switch (el.dataset.act) {
      case 'block':
      case 'allow': {
        const duration = durationChoice.get(id) ?? '60';
        const verb = el.dataset.act === 'block' ? 'Block' : 'Restore';
        if (el.dataset.act === 'block' && !confirm(`Block internet for "${deviceLabel(d)}"?`)) return;
        el.disabled = true;
        return act(() => api('POST', `/api/devices/${id}/override`, { type: el.dataset.act, duration }), resultMsg(verb));
      }
      case 'clear-override':
        return act(() => api('DELETE', `/api/devices/${id}/override`), 'Override cleared. Schedules apply again.');
      case 'rename': return startRename(id, el);
      case 'protect':
        if (!confirm(`Mark "${deviceLabel(d)}" as protected? It will be removed from all schedules and can never be blocked.`)) return;
        return act(() => api('PATCH', `/api/devices/${id}`, { is_protected: true }), 'Device protected.');
      case 'unprotect':
        return act(() => api('PATCH', `/api/devices/${id}`, { is_protected: false }), 'Protection removed.');
      case 'sched-edit': return editSchedule(id);
      case 'sched-delete': {
        const s = state.schedules.find((x) => x.id === id);
        if (!confirm(`Delete schedule "${s?.name}"?`)) return;
        return act(() => api('DELETE', `/api/schedules/${id}`), 'Schedule deleted.');
      }
      case 'refresh': break;
      case 'check':
        return act(() => api('POST', '/api/control/check'), (r) => r.ok
          ? `Router OK (${r.info?.model ?? 'model unknown'} ${r.info?.firmware ?? ''}). Access Control: ${r.accessControlEnabled === null ? 'unknown' : r.accessControlEnabled ? 'on' : 'OFF'}.`
          : `Router check failed: ${r.error}`);
      case 'arm': {
        const typed = prompt(
          'ARM ROUTER CONTROL\n\nThe app will send real block/restore commands to the router for MANAGED devices only.\n' +
          'Test on one device first. Manual recovery: router admin > ADVANCED > Security > Access Control.\n\nType ARM to continue:');
        if (typed !== 'ARM') return;
        return act(() => api('POST', '/api/control/arm', { confirm: 'ARM' }), 'Router control armed.');
      }
      case 'disarm':
        if (!confirm('Restore every device the app blocked, then stop sending router commands?')) return;
        return act(() => api('POST', '/api/control/disarm'), (r) => `Disarmed. ${r.restored.length} device(s) restored.`);
      default:
    }
  });

  document.addEventListener('change', (e) => {
    const el = e.target;
    if (el.matches('[data-dur]')) { durationChoice.set(Number(el.dataset.dur), el.value); return; }
    if (el.matches('[data-act="managed"]')) {
      const id = Number(el.dataset.id);
      return act(() => api('PATCH', `/api/devices/${id}`, { restrictions_enabled: el.checked }),
        el.checked ? 'Device is now managed by schedules.' : 'Device is no longer managed. If the app blocked it, access will be restored.');
    }
    if (el.matches('[data-act="sched-toggle"]')) {
      const id = Number(el.dataset.id);
      return act(() => api('POST', `/api/schedules/${id}/enabled`, { enabled: el.checked }), el.checked ? 'Schedule enabled.' : 'Schedule disabled.');
    }
    if (el.id === 'show-offline') { showOffline = el.checked; localSet('showOffline', showOffline ? '1' : '0'); renderDevices(); }
    if (el.id === 'sched-start' || el.id === 'sched-end') updateHint();
  });

  function startRename(id, link) {
    const d = state.devices.find((x) => x.id === id);
    editingNameId = id;
    const cell = link.closest('.device-name');
    cell.innerHTML = `<form class="d-flex gap-1" data-rename="${id}">
      <input class="form-control form-control-sm" maxlength="60" value="${esc(d.display_name || '')}" placeholder="${esc(d.hostname || 'Name')}">
      <button class="btn btn-sm btn-primary" type="submit">Save</button>
      <button class="btn btn-sm btn-outline-secondary" type="button" data-cancel>✕</button></form>`;
    const form = cell.querySelector('form');
    form.querySelector('input').focus();
    form.querySelector('[data-cancel]').onclick = () => { editingNameId = null; renderDevices(); };
    form.onsubmit = (ev) => {
      ev.preventDefault();
      const name = form.querySelector('input').value;
      editingNameId = null;
      act(() => api('PATCH', `/api/devices/${id}`, { display_name: name }), 'Device renamed.');
    };
  }

  function editSchedule(id) {
    const s = state.schedules.find((x) => x.id === id);
    if (!s) return;
    $('#sched-id').value = s.id;
    $('#sched-name').value = s.name;
    $('#sched-start').value = s.start_time;
    $('#sched-end').value = s.end_time;
    $('#sched-enabled').checked = s.enabled;
    DAYS.forEach((_, i) => { $(`#day-${i}`).checked = s.days_of_week.includes(i); });
    document.querySelectorAll('#sched-devices input').forEach((i) => { i.checked = s.device_ids.includes(Number(i.value)); });
    $('#sched-save').textContent = 'Update schedule';
    $('#sched-cancel').classList.remove('d-none');
    updateHint();
    $('#schedules-section').scrollIntoView({ behavior: 'smooth' });
  }

  $('#restart-router').onclick = async () => {
    const typed = prompt(
      'RESTART ROUTER\n\nThis frees the router\'s memory and usually fixes a slow, overloaded router.\n' +
      'EVERY device in the house loses internet for about 3–5 minutes, including this dashboard\'s connection to the router.\n' +
      'Device rules (Access Control) are kept.\n\nType RESTART to continue:');
    if (typed !== 'RESTART') return;
    const btn = $('#restart-router');
    btn.disabled = true;
    try {
      const r = await api('POST', '/api/router/restart', { confirm: 'RESTART' });
      notify(`Router is restarting. Internet should be back around ${fmtTime(r.restartingUntil)}.`, 'success', 15000);
    } catch (err) {
      notify(err.message, 'danger', 15000);
    } finally {
      btn.disabled = false;
    }
    await Promise.all([load(), loadHealth()]);
  };

  $('#sched-cancel').onclick = resetScheduleForm;
  $('#refresh-devices').onclick = () => act(() => api('POST', '/api/devices/refresh'), (r) => r.ok ? 'Device list refreshed from router.' : `Router error: ${r.error}`);
  $('#show-offline').checked = showOffline;

  $('#schedule-form').onsubmit = (e) => {
    e.preventDefault();
    const id = $('#sched-id').value;
    const body = {
      name: $('#sched-name').value,
      start_time: $('#sched-start').value,
      end_time: $('#sched-end').value,
      enabled: $('#sched-enabled').checked,
      days_of_week: DAYS.map((_, i) => i).filter((i) => $(`#day-${i}`).checked),
      device_ids: [...document.querySelectorAll('#sched-devices input:checked')].map((i) => Number(i.value)),
    };
    act(async () => {
      const r = id ? await api('PUT', `/api/schedules/${id}`, body) : await api('POST', '/api/schedules', body);
      resetScheduleForm();
      return r;
    }, id ? 'Schedule updated.' : 'Schedule saved. Selected devices are now managed.');
  };

  load();
  loadHealth();
  setInterval(() => { if (!document.hidden) { load(); loadHealth(); } }, POLL_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { load(); loadHealth(); } });
})();
