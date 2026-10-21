'use strict';
// Pi Health: vitals, services, network and activity from /api/health every
// 5 s, plus the Pi's fixed quick commands. Behind the portal PIN like
// everything else; the device key comes from the portal page.
const $ = id => document.getElementById(id);
function headers(extra = {}) {
  let key = ''; try { key = sessionStorage.getItem('vp-device-key') || ''; } catch {}
  return key ? {...extra, 'x-vp-device': key} : extra;
}
async function call(path, body) {
  const response = await fetch(path, {method: body ? 'POST' : 'GET', cache: 'no-store',
    headers: headers(body ? {'content-type': 'application/json'} : {}), body: body ? JSON.stringify(body) : undefined});
  if (response.status === 401) { location.href = '/'; throw new Error('Enter the PIN.'); }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `The Pi answered ${response.status}.`);
  return result;
}
function el(tag, className = '', text = '') { const node = document.createElement(tag); if (className) node.className = className; if (text) node.textContent = text; return node; }
const gb = bytes => `${(bytes / 1e9).toFixed(bytes >= 1e10 ? 0 : 1)} GB`;
function ago(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 90) return `${s} s`; if (s < 5400) return `${Math.round(s / 60)} min`; if (s < 172800) return `${Math.round(s / 3600)} h`; return `${Math.round(s / 86400)} days`;
}
function duration(seconds) { const d = Math.floor(seconds / 86400), h = Math.floor(seconds % 86400 / 3600), m = Math.floor(seconds % 3600 / 60); return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m} min`; }
function tile(label, value, note = '', level = '') {
  const node = el('div', 'tile'); node.append(el('small', '', label));
  const big = el('b', level, value); node.append(big); if (note) node.append(el('small', '', note)); return node;
}
function row(level, title, detail, button) {
  const node = el('div', 'row'); node.append(el('span', 'dot ' + level));
  const text = el('div', 'grow'); text.append(el('strong', '', title)); if (detail) text.append(el('small', '', detail));
  node.append(text); if (button) node.append(button); return node;
}
function render(data) {
  $('error').hidden = !data.error; $('error').textContent = data.error || '';
  $('updated').textContent = `Updated ${new Date().toLocaleTimeString([], {hour: '2-digit', minute: '2-digit', second: '2-digit'})}`;
  const v = data.vitals;
  if (v) {
    const temp = v.temperature, loadPct = Math.round(v.load[0] / v.cpus * 100);
    const used = 1 - (v.memory.available ?? v.memory.free) / v.memory.total;
    const power = v.power.undervoltageNow ? ['Low voltage!', 'bad'] : v.power.throttledNow ? ['Throttling', 'warn']
      : v.power.undervoltageSinceBoot ? ['OK now', 'warn'] : ['Good', 'good'];
    $('vitals').replaceChildren(
      tile('Temperature', temp == null ? '—' : `${temp.toFixed(0)} °C`, temp >= 80 ? 'Hot: slows down at 85' : 'Slows down at 85 °C', temp >= 80 ? 'bad' : temp >= 70 ? 'warn' : 'good'),
      tile('CPU load', `${loadPct}%`, `${v.load.map(n => n.toFixed(1)).join(' / ')} (1/5/15 min)`, loadPct >= 90 ? 'warn' : ''),
      tile('Memory', `${Math.round(used * 100)}%`, `${gb(v.memory.total * used)} of ${gb(v.memory.total)}`, used >= .9 ? 'warn' : ''),
      ...v.disks.map(d => { const usedDisk = 1 - d.free / d.total; return tile(d.path === '/' ? 'System space' : 'Data space', `${gb(d.free)} free`, `${Math.round(usedDisk * 100)}% used of ${gb(d.total)}`, usedDisk >= .9 ? 'bad' : usedDisk >= .8 ? 'warn' : ''); }),
      tile('Up for', duration(data.uptime), data.hostname),
      tile('Power', power[0], v.power.undervoltageSinceBoot && !v.power.undervoltageNow ? 'Dipped since boot' : 'Supply voltage', power[1]),
      tile('OS storage', v.storageMode.startsWith('protected') ? 'Protected' : v.storageMode, 'Read-only system, safe from power cuts'));
  }
  if (data.services) $('services').replaceChildren(...data.services.map(s => {
    const level = s.active === 'active' ? 'good' : s.active === 'activating' || s.active === 'reloading' ? 'warn' : 'bad';
    const restart = el('button', '', 'Restart'); restart.type = 'button';
    restart.onclick = () => runAction(`restart:${s.id}`, `Restart ${s.label}?`, restart);
    return row(level, s.label, s.active === 'active' ? `Running for ${s.since ? ago(s.since) : '—'}` : `${s.active}${s.sub ? ` (${s.sub})` : ''}`, restart);
  }));
  const n = data.network, vp = data.videoPilot || {};
  $('network').replaceChildren(
    ...(n?.links || []).map(l => row(l.state === 'connected' ? 'good' : 'bad', l.type === 'ethernet' ? 'Ethernet' : 'Wi-Fi', `${l.state}${l.connection ? ` · ${l.connection}` : ''}`)),
    ...(n ? [row(n.internet ? 'good' : 'bad', 'Internet', n.internet ? `Reachable · ${n.pingMs ?? '—'} ms` : 'Not reachable')] : []),
    row(vp.tunnel ? 'good' : vp.tunnel === false ? 'bad' : '', 'Video Pilot car link', vp.tunnel ? 'Connected to Cloudflare' : 'Disconnected'),
    ...(n && n.aiRoomRelay !== null ? [row(n.aiRoomRelay ? 'good' : 'bad', 'AI Room site link', n.aiRoomRelay ? 'Connected to Cloudflare' : 'Disconnected')] : []));
  const stage = {downloading: 'Downloading', processing: 'Converting'}[vp.preparationStage];
  const prep = row(vp.busy ? 'warn' : 'good', 'Video Pilot', vp.busy
    ? `${stage || 'Working'}${Number.isFinite(vp.preparationProgress) ? ` · ${Math.round(vp.preparationProgress * 100)}%` : ''}${vp.queuedCount ? ` · ${vp.queuedCount} waiting` : ''}`
    : `Idle · ${vp.videos ?? '—'} videos${vp.failed ? ` · ${vp.failed} need a retry` : ''}`);
  if (vp.busy && Number.isFinite(vp.preparationProgress)) { const bar = el('progress'); bar.max = 1; bar.value = vp.preparationProgress; prep.querySelector('.grow').append(bar); }
  $('activity').replaceChildren(prep, ...(data.activity ? [row(data.activity.aiRoomBusy ? 'warn' : 'good', 'Claude (AI Room)', data.activity.aiRoomBusy ? 'Working on a reply' : 'Idle')] : []));
}
async function runAction(id, question, button) {
  if (question && !confirm(question)) return;
  button.disabled = true;
  $('output').hidden = false; $('output').textContent = `${button.textContent}…`;
  try {
    const result = await call('/api/health/action', {id});
    $('output').textContent = result.output || (result.ok ? 'Done.' : 'It did not work.');
    if (id === 'reboot') waitForReboot();
  } catch (error) { $('output').textContent = error.message; }
  finally { button.disabled = false; setTimeout(refresh, 1500); }
}
let rebooting = false;
function waitForReboot() { rebooting = true; $('error').hidden = false; $('error').textContent = 'Rebooting… this page reconnects by itself.'; }
async function loadActions() {
  try {
    const {actions} = await call('/api/health/actions');
    $('actions').replaceChildren(...actions.filter(a => !a.id.startsWith('restart:')).map(a => {
      const button = el('button', a.confirm ? 'danger' : '', a.label); button.type = 'button';
      button.onclick = () => runAction(a.id, a.confirm ? `${a.label}?` : '', button);
      return button;
    }));
  } catch {}
}
async function refresh() {
  try { render(await call('/api/health')); if (rebooting) { rebooting = false; loadActions(); } }
  catch (error) { if (!rebooting) { $('error').hidden = false; $('error').textContent = error.message; } }
}
// Trusted browsers: only browsers added here can open the portal at its own
// web address; everyone else gets no answer at all. A new browser can be
// added for a few minutes after a trusted one opens the door.
async function gateCall(path, body, question) {
  if (question && !confirm(question)) return;
  try { renderGate(await call(path, body)); }
  catch (error) { $('gate-note').textContent = error.message; }
  if (path.endsWith('/enroll')) loadGate();
}
function renderGate(g) {
  const button = (label, onclick, cls = '') => { const b = el('button', cls, label); b.type = 'button'; b.onclick = onclick; return b; };
  const open = g.windowUntil > Date.now();
  const here = g.here || gateHere;
  if (g.here) gateHere = g.here;
  $('gate-note').textContent = !g.enforced
    ? 'Off. Anyone with the address reaches the PIN screen. Trust this browser to turn it on.'
    : open ? `On. A new browser can be added for the next ${Math.max(1, Math.round((g.windowUntil - Date.now()) / 60000))} min.`
    : 'On. Browsers not on this list get no answer at all.';
  $('gate').replaceChildren(...g.devices.map(d => row(d.current ? 'good' : '', `${d.name}${d.current ? ' (this browser)' : ''}`,
    `Added ${new Date(d.added).toLocaleDateString()} · last used ${ago(d.lastSeen)} ago`,
    button('Remove', () => gateCall('/api/gate/remove', {id: d.id}, `Remove ${d.name}? It will get no answer until it is added again.`), 'danger'))));
  const actions = [];
  if (here === 'new' && (!g.enforced || open)) {
    const name = el('input'); name.id = 'gate-name'; name.maxLength = 40; name.setAttribute('aria-label', 'Name for this browser');
    name.value = /Tesla/.test(navigator.userAgent) ? 'Tesla' : /iPhone/.test(navigator.userAgent) ? 'iPhone' : /Android/.test(navigator.userAgent) ? 'Android phone' : 'Browser';
    actions.push(name, button('Trust this browser', () => gateCall('/api/gate/enroll', {name: name.value.trim() || 'Browser'})));
  }
  if (g.enforced) actions.push(open ? button('Stop adding', () => gateCall('/api/gate/close', {}))
    : button('Let a new browser in (10 min)', () => gateCall('/api/gate/open', {minutes: 10})));
  $('gate-actions').replaceChildren(...actions);
  if (here === 'relay') $('gate-note').textContent += ' To add a browser, open the portal at its own web address on that browser.';
}
let gateHere = '';
async function loadGate() { try { renderGate(await call('/api/gate')); } catch { $('gate-note').textContent = 'Trusted browsers are not set up on this Pi.'; } }
loadActions(); refresh(); loadGate();
setInterval(() => { if (!document.hidden) refresh(); }, 5000);
setInterval(() => { if (!document.hidden) loadGate(); }, 30000);
