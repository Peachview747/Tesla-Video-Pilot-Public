'use strict';
// The Apps switcher, shared by every page in the portal (YouTube, Netflix,
// Hulu, Claude, Pi Health): a button wherever a page puts [data-apps-menu],
// opening a sheet that jumps straight to another app.
(() => {
  const APPS = [['youtube', 'YouTube'], ['netflix', 'Netflix'], ['hulu', 'Hulu'], ['claude', 'Claude'], ['health', 'Pi Health'], ['portal', 'All apps']];
  const here = location.pathname.startsWith('/airoom') ? 'claude' : location.pathname.startsWith('/health') ? 'health' : '';
  function go(id) {
    // On the Video Pilot page itself, switch without reloading.
    if (globalThis.videoPilotOpen?.(id)) return;
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
  globalThis.videoPilotApps = {open, close, mount};
})();
