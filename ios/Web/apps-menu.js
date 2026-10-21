'use strict';
// The Apps switcher, shared by every page in the portal (YouTube, Netflix,
// Hulu, Claude, Pi Health): a button wherever a page puts [data-apps-menu],
// opening a sheet that jumps straight to another app.
(() => {
  // Each visit asks for the PIN. The unlock key lives in this tab only and
  // survives a page change only when it is a switch inside the portal (which
  // marks a handoff just before leaving); a reload or a fresh open drops it.
  try {
    const handoff = Number(sessionStorage.getItem('vp-handoff')) || 0;
    sessionStorage.removeItem('vp-handoff');
    localStorage.removeItem('vp-device-key'); // remembered keys from before
    if (Date.now() - handoff > 15000) sessionStorage.removeItem('vp-device-key');
  } catch {}
  const handoff = () => { try { sessionStorage.setItem('vp-handoff', String(Date.now())); } catch {} };
  const APPS = [['youtube', 'YouTube'], ['netflix', 'Netflix'], ['hulu', 'Hulu'], ['claude', 'Claude'], ['health', 'Pi Health'], ['textnow', 'TextNow'], ['portal', 'All apps']];
  const here = location.pathname.startsWith('/airoom') ? 'claude' : location.pathname.startsWith('/health') ? 'health' : '';
  function go(id) {
    // On the Video Pilot page itself, switch without reloading.
    if (globalThis.videoPilotOpen?.(id)) return;
    handoff();
    location.href = id === 'claude' ? '/airoom/' : id === 'health' ? '/health/' : id === 'portal' ? '/' : `/?app=${id}`;
  }
  let sheet = null;
  function close() { if (sheet) sheet.hidden = true; }
  function open() {
    if (!sheet) {
      sheet = document.createElement('div'); sheet.className = 'apps-sheet'; sheet.setAttribute('role', 'dialog'); sheet.setAttribute('aria-label', 'Apps');
      sheet.onclick = event => { if (event.target === sheet) close(); };
      const panel = document.createElement('div'); panel.className = 'apps-panel';
      for (const [id, label] of APPS) {
        const button = document.createElement('button'); button.type = 'button'; button.className = `apps-item apps-${id}`; button.textContent = label;
        if (id === here) button.setAttribute('aria-current', 'page');
        button.onclick = () => { close(); go(id); };
        panel.append(button);
      }
      sheet.append(panel); document.body.append(sheet);
      document.addEventListener('keydown', event => { if (event.key === 'Escape') close(); });
    }
    sheet.hidden = false;
  }
  function mount() {
    for (const slot of document.querySelectorAll('[data-apps-menu]')) {
      if (slot.dataset.mounted) continue;
      slot.dataset.mounted = '1';
      const button = document.createElement('button'); button.type = 'button'; button.className = 'apps-button';
      button.textContent = 'Apps'; button.title = 'Switch apps'; button.setAttribute('aria-haspopup', 'dialog');
      button.onclick = open; slot.replaceWith(button);
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();

  // Spoken alerts: every 20 s, ask the Pi for alerts since the last one this
  // tab heard; show each as a banner and say it in Claude's voice. A page that
  // is listening to you (Claude voice) sets videoPilotAlertsQuiet and only
  // gets the banner.
  const ALERT_KEY = 'vp-alert-seen';
  let banner = null, bannerTimer = null, player = null;
  function deviceKey() { try { return sessionStorage.getItem('vp-device-key') || ''; } catch { return ''; } }
  async function call(path, body) {
    const key = deviceKey();
    const response = await fetch(path, {method: body ? 'POST' : 'GET', cache: 'no-store',
      headers: {...(key ? {'x-vp-device': key} : {}), ...(body ? {'content-type': 'application/json'} : {})}, body: body ? JSON.stringify(body) : undefined});
    if (!response.ok) throw new Error(String(response.status));
    return response.json();
  }
  function show(text) {
    if (!banner) {
      banner = document.createElement('div'); banner.className = 'alert-banner'; banner.setAttribute('role', 'status');
      banner.onclick = () => { banner.hidden = true; };
      document.body.append(banner);
    }
    banner.textContent = text; banner.hidden = false;
    clearTimeout(bannerTimer); bannerTimer = setTimeout(() => { banner.hidden = true; }, 12000);
  }
  async function say(text) {
    if (globalThis.videoPilotAlertsQuiet?.()) return;
    let voice = ''; try { voice = localStorage.getItem('airoom-voice') || ''; } catch {}
    const {audio, mime} = await call('/api/say', {text, voice});
    player = player || new Audio();
    player.src = `data:${mime};base64,${audio}`;
    await player.play();
  }
  let checking = false;
  async function checkAlerts() {
    if (checking || document.hidden) return;
    checking = true;
    try {
      let seen = null; try { seen = sessionStorage.getItem(ALERT_KEY); } catch {}
      const {alerts, latest} = await call(`/api/alerts?since=${seen === null ? 0 : Number(seen)}`);
      try { sessionStorage.setItem(ALERT_KEY, String(latest)); } catch {}
      // A new visit starts from now; it does not replay older alerts.
      if (seen === null || !alerts.length) return;
      const text = alerts.map(alert => alert.text).join(' ');
      show(text);
      await say(text).catch(() => {});
    } catch {} finally { checking = false; }
  }
  setInterval(checkAlerts, 20000); setTimeout(checkAlerts, 3000);
  globalThis.videoPilotApps = {open, close, mount, handoff, checkAlerts};
})();
