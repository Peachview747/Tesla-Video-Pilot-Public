import {JSMpegHttpSource, installRecordedBufferWindow, installRecordedAudioOutput, installRecordedAudioLead, installRecordedPlayerPause} from './http-source.js';
import {DiagnosticsJournal} from './diagnostics.js';
const $ = id => document.getElementById(id);
let player = null, current = null, currentOffset = 0, seekTimer = null;
let fullscreenFallback = false;
let playback = null;
let refreshing = false;
let exploring = false, exploreAttemptAt = 0, exploreAccount = null;
let seekGeneration = 0;
let seekChain = Promise.resolve();
// Tesla browsers can have a large system volume while the WebAudio output is
// still quiet. Keep a modest, reversible gain boost in the browser rather
// than changing the source file (which would require re-preparing videos and
// could permanently clip loud sources).
const audioBoostKey = 'video-pilot-audio-boost-v2';
// Start at unity gain. A previous build enabled a 170%/135% boost by default;
// that could clip already-hot sources on Tesla's WebAudio path. Audio + is
// still available as a conservative, reversible 115% option.
const audioBoostVolume = 1.15;
let audioBoost = false;
let audioMuted = false;
let audioLimiter = null;
try {
  const savedAudioBoost = globalThis.localStorage?.getItem(audioBoostKey);
  if (savedAudioBoost != null) audioBoost = savedAudioBoost === 'on';
} catch {}
// A stable page-local identity lets the relay evict a stream whose browser
// player was replaced before the browser's fetch abort reached the Worker.
const playbackClient = (() => {
  try { if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID(); } catch {}
  return `vp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
})();
const notice = message => { $('notice').textContent = message; };
const themeKey = 'video-pilot-theme';
function applyTheme(theme, persist = true) {
  const value = theme === 'dark' ? 'dark' : 'light';
  const root = document.documentElement;
  if (!root) return;
  root.dataset.theme = value;
  const toggle = $('theme-toggle');
  if (toggle) {
    toggle.textContent = value === 'dark' ? 'Light mode' : 'Dark mode';
    toggle.setAttribute('aria-pressed', value === 'dark' ? 'true' : 'false');
  }
  if (persist) { try { globalThis.localStorage?.setItem(themeKey, value); } catch {} }
}
// No saved choice: follow the browser's light/dark preference.
try {
  const saved = globalThis.localStorage?.getItem(themeKey);
  applyTheme(saved || (globalThis.matchMedia?.('(prefers-color-scheme: dark)')?.matches ? 'dark' : 'light'), false);
} catch { applyTheme('light'); }
const resumeKey = video => 'video-pilot-resume:' + (video?.id || '');
function savedResume(video) {
  try {
    const value = Number(globalThis.localStorage?.getItem(resumeKey(video)));
    return Number.isFinite(value) && value >= 3 ? value : 0;
  } catch { return 0; }
}
function saveResume(video = current, position = currentOffset) {
  const offset = Number(position) || 0;
  if (!video || offset < 3 || playback?.ended) return;
  try {
    globalThis.localStorage?.setItem(resumeKey(video), String(Math.floor(offset)));
    globalThis.localStorage?.setItem('video-pilot-resume-at:' + video.id, String(Date.now()));
  } catch {}
}
function clearResume(video = current) {
  try { globalThis.localStorage?.removeItem(resumeKey(video)); } catch {}
}
async function api(path, body) {
  const started = globalThis.performance?.now?.() ?? Date.now();
  let response;
  try {
    const result = await timedFetch(path, {method:body ? 'POST' : 'GET', credentials:'same-origin', cache:'no-store',
      headers:body ? {'Content-Type':'application/json'} : {}, body:body ? JSON.stringify(body) : undefined}, 12000, r => r.text());
    response = result.response;
    const raw = result.body;
    let parsed;
    try { parsed = raw ? JSON.parse(raw) : {}; }
    catch {
      reportDiagnostic('apiError', {responseStatus:response.status,
        elapsedMs:Math.round((globalThis.performance?.now?.() ?? Date.now()) - started),
        error:response.ok ? 'unexpected-page' : 'invalid-json'});
      throw new Error(response.ok
        ? 'The host returned an unexpected page. Refresh the Tesla browser and keep Video Pilot open.'
        : `Connection to Video Pilot failed (${response.status}). Refresh to retry.`);
    }
    if (!response.ok) {
      reportDiagnostic('apiError', {responseStatus:response.status,
        elapsedMs:Math.round((globalThis.performance?.now?.() ?? Date.now()) - started),
        error:String(parsed.error || 'request-failed')});
      throw new Error(parsed.error || `Request failed (${response.status}).`);
    }
    return parsed;
  } catch (error) {
    if (!response) reportDiagnostic('apiError', {responseStatus:0,
      elapsedMs:Math.round((globalThis.performance?.now?.() ?? Date.now()) - started),
      error:String(error?.message || 'network-failure')});
    throw error;
  }
}
// Browser-side telemetry is batched before it crosses the relay. It contains
// timing, counters, and player state only; URLs, IDs, headers, and media bytes
// are intentionally excluded. Keep a small local ring as well: a tunnel hiccup
// must not erase the very events needed to diagnose that hiccup.
const diagnosticsStorageKey = 'video-pilot-browser-diagnostics-v2';
const diagnosticsMaxEvents = 256;
const diagnosticsBatchSize = 16;
const diagnosticsJournal = new DiagnosticsJournal(globalThis.localStorage, diagnosticsStorageKey, diagnosticsMaxEvents);
const diagnosticsQueue = diagnosticsJournal.events;
let diagnosticsFlushTimer = null;
let diagnosticsFlushInFlight = null;
let diagnosticsRetryDelay = 1000;
const diagnosticLastTimes = new Map();
function persistDiagnostics() {
  diagnosticsJournal.persist();
  const pending = $('diagnostics-pending');
  if (pending) pending.textContent = String(diagnosticsJournal.pending.length);
}
function scheduleDiagnosticsFlush(delay = 250) {
  if (diagnosticsFlushTimer || !diagnosticsJournal.pending.length) return;
  diagnosticsFlushTimer = setTimeout(() => {
    diagnosticsFlushTimer = null;
    void flushDiagnostics();
  }, delay);
  diagnosticsFlushTimer?.unref?.();
}
function reportDiagnostic(event, fields = {}) {
  const now = Date.now();
  if (event === 'playerStart') diagnosticLastTimes.delete('playerDecode');
  if (event === 'playerDecode' || event === 'browserRTT') {
    if (now - (diagnosticLastTimes.get(event) ?? -Infinity) < 1000) return;
    diagnosticLastTimes.set(event, now);
  }
  diagnosticsJournal.append(event, fields);
  persistDiagnostics();
  scheduleDiagnosticsFlush();
}
function timedFetch(url, options = {}, timeout = 4000, readBody = null) {
  const controller = typeof globalThis.AbortController === 'function' ? new AbortController() : null;
  const request = controller ? {...options, signal:controller.signal} : options;
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => { controller?.abort?.(); reject(new Error('request-timeout')); }, timeout);
    timer?.unref?.();
  });
  const operation = fetch(url, request).then(async response =>
    readBody ? {response, body:await readBody(response)} : response);
  return Promise.race([operation, deadline]).finally(() => clearTimeout(timer));
}
async function flushDiagnostics(keepalive = false) {
  if (diagnosticsFlushInFlight || !diagnosticsJournal.pending.length) return diagnosticsFlushInFlight;
  const events = diagnosticsJournal.batch(diagnosticsBatchSize);
  diagnosticsFlushInFlight = (async () => {
    try {
      const {response, body:result} = await timedFetch('/api/diagnostics', {method:'POST', credentials:'same-origin', cache:'no-store', keepalive,
        headers:{'Content-Type':'application/json'}, body:JSON.stringify({events})}, 4000, r => r.json());
      if (!response.ok || result.accepted !== true || result.count !== events.length) throw new Error(`diagnostics ${response.status}`);
      diagnosticsJournal.acknowledge(events.map(entry => entry.eventId));
      persistDiagnostics();
      diagnosticsRetryDelay = 1000;
      if (diagnosticsJournal.pending.length) scheduleDiagnosticsFlush(0);
    } catch {
      // Keep the batch locally and retry slowly. Diagnostics must never block
      // playback, but it also must not disappear when the tunnel reconnects.
      diagnosticsRetryDelay = Math.min(30_000, diagnosticsRetryDelay * 2);
      scheduleDiagnosticsFlush(diagnosticsRetryDelay);
    } finally { diagnosticsFlushInFlight = null; }
  })();
  return diagnosticsFlushInFlight;
}
globalThis.videoPilotDiagnostics = reportDiagnostic;
scheduleDiagnosticsFlush(0);
persistDiagnostics();
function showTab(id) {
  document.querySelectorAll?.('.tab-panel').forEach(panel => { panel.hidden = panel.id !== id; });
  document.querySelectorAll?.('.tab').forEach(tab => {
    const active = tab.dataset.tab === id;
    tab.classList.toggle('active', active);
    tab.setAttribute?.('aria-selected', active ? 'true' : 'false');
  });
  $('tab-menu').hidden = true; $('menu-toggle').setAttribute?.('aria-expanded', 'false');
}
function goTo(id) { showTab(id); window.scrollTo?.({top: 0, behavior: 'smooth'}); }
function card(title, subtitle, action, thumbnail) {
  const div = document.createElement('article'); div.className = 'card';
  if (thumbnail) {
    try {
      const url = new URL(thumbnail);
      if (url.protocol === 'https:' && url.hostname === 'i.ytimg.com') {
        const media = document.createElement('div'); media.className = 'card-media';
        const img = document.createElement('img'); img.src = url.href; img.alt = ''; img.loading = 'lazy'; media.append(img); div.append(media);
      }
    } catch {}
  }
  const body = document.createElement('div'); body.className = 'card-body';
  const heading = document.createElement('h3'); heading.textContent = title; body.append(heading);
  const text = document.createElement('p'); text.textContent = subtitle; body.append(text);
  if (action) { const button = document.createElement('button'); button.textContent = action.label; button.onclick = action.run; body.append(button); }
  div.append(body);
  return div;
}
const prefs = {
  get(key, fallback = null) { try { return globalThis.localStorage?.getItem(key) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { globalThis.localStorage?.setItem(key, value); } catch {} },
};
const LIBRARY_SORTS = ['added', 'newest', 'oldest', 'channel'];
const LIBRARY_VIEWS = ['channels', 'all'];
let librarySort = LIBRARY_SORTS.includes(prefs.get('vp-library-sort')) ? prefs.get('vp-library-sort') : 'added';
let libraryView = LIBRARY_VIEWS.includes(prefs.get('vp-library-view')) ? prefs.get('vp-library-view') : 'channels';
let channelOrder = prefs.get('vp-channel-order') === 'newest' ? 'newest' : 'oldest';
let libraryFilter = '';
let librarySignature = '';
const openChannels = new Set((() => {
  try { const value = JSON.parse(prefs.get('vp-open-channels', '[]')); return Array.isArray(value) ? value.filter(item => typeof item === 'string') : []; }
  catch { return []; }
})());
let lastLibrary = null;
const releaseTime = video => { const time = Date.parse(video.publishedAt || ''); return Number.isFinite(time) ? time : null; };
function formatRelease(video) {
  const time = releaseTime(video);
  if (time === null) return '';
  try { return new Date(time).toLocaleDateString('en-US', {year:'numeric', month:'short', day:'numeric'}); }
  catch { return String(video.publishedAt).slice(0, 10); }
}
// Library order for the Tesla's Sort menu. The iPhone already lists videos
// newest-added first; videos without a release date always sort last.
function sortLibrary(videos, mode) {
  const byRelease = direction => (a, b) => {
    const left = releaseTime(a), right = releaseTime(b);
    if (left === null || right === null) return left === null ? (right === null ? 0 : 1) : -1;
    return direction * (left - right);
  };
  const list = [...videos];
  if (mode === 'newest') return list.sort(byRelease(-1));
  if (mode === 'oldest') return list.sort(byRelease(1));
  if (mode === 'channel') {
    const name = video => (video.channel || '').trim();
    return list.sort((a, b) => {
      if (!name(a) !== !name(b)) return name(a) ? -1 : 1;
      return name(a).localeCompare(name(b), undefined, {sensitivity:'base'}) || byRelease(-1)(a, b);
    });
  }
  return list;
}
const watchedKey = video => 'video-pilot-watched:' + (video?.id || '');
const isWatched = video => prefs.get(watchedKey(video)) === '1';
const markWatched = video => prefs.set(watchedKey(video), '1');
const channelName = video => (video.channel || '').trim() || 'Other videos';
function formatDuration(value) {
  const seconds = Math.round(finiteDuration(value));
  if (!seconds) return '';
  const h = Math.floor(seconds / 3600), m = Math.floor(seconds % 3600 / 60), sec = seconds % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}
function watchFraction(video) {
  const duration = finiteDuration(video.duration), resume = savedResume(video);
  return duration && resume ? Math.min(1, resume / duration) : 0;
}
function channelHue(name) {
  let hash = 0;
  for (const character of name) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return hash % 360;
}
function element(tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}
function thumbnailFor(video) {
  return video.youtubeID ? `https://i.ytimg.com/vi/${encodeURIComponent(video.youtubeID)}/mqdefault.jpg` : '';
}
// Thumbnail with duration badge and a watched-progress bar; tapping it plays.
function videoThumb(video, onPlay) {
  const thumb = element(onPlay ? 'button' : 'div', 'thumb');
  if (onPlay) { thumb.type = 'button'; thumb.setAttribute('aria-label', `Play ${video.title}`); thumb.onclick = onPlay; }
  const url = thumbnailFor(video);
  if (url) { const img = element('img'); img.src = url; img.alt = ''; img.loading = 'lazy'; thumb.append(img); }
  else thumb.append(element('span', 'thumb-placeholder', '▶'));
  const duration = formatDuration(video.duration);
  if (duration) thumb.append(element('span', 'duration-badge', duration));
  const fraction = isWatched(video) ? 1 : watchFraction(video);
  if (fraction > 0) {
    const bar = element('span', 'watch-progress'); const fill = element('i');
    fill.style.width = `${Math.max(4, Math.round(fraction * 100))}%`; bar.append(fill); thumb.append(bar);
  }
  return thumb;
}
function videoAction(video, preparingID) {
  if (video.state === 'ready') {
    const resume = savedResume(video);
    return {label:resume ? `Resume · ${formatTime(resume)}` : (isWatched(video) ? 'Watch again' : 'Play'), run:() => play(video), primary:true};
  }
  const active = video.id?.toLowerCase() === preparingID?.toLowerCase();
  return {label:active ? 'Cancel' : 'Remove', run:() => removeVideo(video.id)};
}
function videoStatus(video) {
  if (video.state === 'ready') return '';
  if (video.state === 'preparing') return video.message || 'Preparing…';
  return video.message || video.state;
}
function videoCard(video, preparingID, showChannel = true) {
  const node = element('article', 'card video-card');
  node.append(videoThumb(video, video.state === 'ready' ? () => play(video) : null));
  const body = element('div', 'card-body');
  body.append(element('h3', '', video.title));
  const details = [showChannel ? video.channel : '', formatRelease(video)].filter(Boolean).join(' · ');
  body.append(element('p', '', videoStatus(video) || details || 'Ready'));
  const action = videoAction(video, preparingID);
  const button = element('button', action.primary ? '' : 'quiet', action.label); button.type = 'button'; button.onclick = action.run;
  body.append(button); node.append(body);
  return node;
}
function episodeRow(video, number, preparingID) {
  const row = element('div', 'episode' + (isWatched(video) ? ' is-watched' : ''));
  row.append(videoThumb(video, video.state === 'ready' ? () => play(video) : null));
  const text = element('div', 'episode-text');
  text.append(element('span', 'episode-number', `#${number}`));
  text.append(element('h4', '', video.title));
  const resume = savedResume(video);
  const meta = videoStatus(video) || [formatRelease(video), formatDuration(video.duration),
    isWatched(video) ? 'Watched' : (resume ? `${Math.round(watchFraction(video) * 100)}% watched` : '')].filter(Boolean).join(' · ');
  text.append(element('p', '', meta));
  row.append(text);
  const action = videoAction(video, preparingID);
  const button = element('button', 'episode-action' + (action.primary ? '' : ' quiet'), action.label);
  button.type = 'button'; button.onclick = action.run; row.append(button);
  return row;
}
function saveOpenChannels() { prefs.set('vp-open-channels', JSON.stringify([...openChannels].slice(-40))); }
function channelBlock(name, videos, preparingID, forceOpen) {
  // "Sequential" order: oldest release first, numbered like episodes.
  const sequence = sortLibrary(videos, 'oldest');
  const numbered = new Map(sequence.map((video, index) => [video.id, index + 1]));
  const shown = channelOrder === 'newest' ? [...sequence].reverse() : sequence;
  const open = forceOpen || openChannels.has(name);
  const block = element('article', 'channel' + (open ? ' open' : ''));
  const header = element('button', 'channel-header'); header.type = 'button';
  header.setAttribute('aria-expanded', open ? 'true' : 'false');
  const avatar = element('span', 'avatar', name === 'Other videos' ? '•' : name.slice(0, 1).toUpperCase());
  avatar.style.setProperty('--hue', String(channelHue(name)));
  const label = element('span', 'channel-text');
  label.append(element('strong', '', name));
  const latest = sortLibrary(videos, 'newest')[0];
  const ready = videos.filter(video => video.state === 'ready');
  const unwatched = ready.filter(video => !isWatched(video)).length;
  label.append(element('small', '', [`${videos.length} video${videos.length === 1 ? '' : 's'}`,
    unwatched && unwatched < ready.length ? `${unwatched} unwatched` : '',
    formatRelease(latest) ? `latest ${formatRelease(latest)}` : ''].filter(Boolean).join(' · ')));
  const strip = element('span', 'channel-strip');
  for (const video of sortLibrary(videos, 'newest').slice(0, 3)) {
    const url = thumbnailFor(video);
    if (url) { const img = element('img'); img.src = url; img.alt = ''; img.loading = 'lazy'; strip.append(img); }
  }
  header.append(avatar, label, strip, element('span', 'chevron'));
  const panel = element('div', 'channel-panel');
  const inner = element('div', 'channel-inner');
  const tools = element('div', 'channel-tools');
  const next = sequence.find(video => video.state === 'ready' && !isWatched(video));
  if (next) {
    const resume = savedResume(next);
    const playNext = element('button', 'play-next', `${resume ? 'Resume' : 'Play'} #${numbered.get(next.id)} · ${next.title}`);
    playNext.type = 'button'; playNext.onclick = () => play(next); tools.append(playNext);
  }
  const order = element('button', 'order-toggle quiet', channelOrder === 'oldest' ? 'Oldest first ↓' : 'Newest first ↑');
  order.type = 'button';
  order.onclick = () => {
    channelOrder = channelOrder === 'oldest' ? 'newest' : 'oldest'; prefs.set('vp-channel-order', channelOrder);
    librarySignature = ''; if (lastLibrary) renderLibrary(lastLibrary.videos, lastLibrary.preparingID);
  };
  tools.append(order); inner.append(tools);
  for (const video of shown) inner.append(episodeRow(video, numbered.get(video.id), preparingID));
  panel.append(inner);
  header.onclick = () => {
    const nowOpen = !block.classList.contains('open');
    block.classList.toggle('open', nowOpen);
    header.setAttribute('aria-expanded', nowOpen ? 'true' : 'false');
    if (nowOpen) openChannels.add(name); else openChannels.delete(name);
    saveOpenChannels();
  };
  block.append(header, panel);
  return block;
}
function renderContinue(videos) {
  const items = videos.filter(video => video.state === 'ready' && !isWatched(video) && savedResume(video) >= 10)
    .sort((a, b) => Number(prefs.get('video-pilot-resume-at:' + b.id, 0)) - Number(prefs.get('video-pilot-resume-at:' + a.id, 0)))
    .slice(0, 8);
  $('continue-panel').hidden = !items.length || Boolean(libraryFilter);
  $('continue-list').replaceChildren(...items.map(video => {
    const tile = element('article', 'continue-tile');
    tile.append(videoThumb(video, () => play(video)));
    const text = element('div', 'continue-text');
    text.append(element('strong', '', video.title));
    text.append(element('small', '', [video.channel, `${formatTime(savedResume(video))} of ${formatDuration(video.duration) || '—'}`].filter(Boolean).join(' · ')));
    tile.append(text);
    return tile;
  }));
}
function renderLibrary(videos, preparingID) {
  lastLibrary = {videos, preparingID};
  const signature = JSON.stringify([videos.map(video => [video.id, video.state, video.title, video.message, video.channel,
    video.publishedAt, video.duration, savedResume(video), isWatched(video)]), preparingID, librarySort, libraryView,
    channelOrder, libraryFilter]);
  if (signature === librarySignature) return;
  librarySignature = signature;
  if ($('library-sort').value !== librarySort) $('library-sort').value = librarySort;
  $('library-sort-wrap').hidden = libraryView !== 'all';
  for (const view of LIBRARY_VIEWS) $(`view-${view}`).setAttribute?.('aria-selected', view === libraryView ? 'true' : 'false');
  const channels = new Set(videos.map(channelName));
  $('library-count').textContent = videos.length
    ? `${videos.length} video${videos.length === 1 ? '' : 's'} · ${channels.size} channel${channels.size === 1 ? '' : 's'}` : '';
  renderContinue(videos);
  const query = libraryFilter.toLowerCase();
  const filtered = query ? videos.filter(video => `${video.title} ${video.channel || ''}`.toLowerCase().includes(query)) : videos;
  const library = $('library'); library.replaceChildren();
  library.className = libraryView === 'all' ? 'grid library-list' : 'library-list channels-list';
  if (!videos.length) { library.append(card('Your library is empty', 'Search for a video on the Home tab and add it here.')); return; }
  if (!filtered.length) { library.append(card('No matches', `Nothing in your library matches “${libraryFilter}”.`)); return; }
  if (libraryView === 'all') {
    let group = null;
    for (const video of sortLibrary(filtered, librarySort)) {
      if (librarySort === 'channel' && channelName(video) !== group) {
        group = channelName(video); library.append(element('h3', 'library-group', group));
      }
      library.append(videoCard(video, preparingID, librarySort !== 'channel'));
    }
    return;
  }
  const groups = new Map();
  for (const video of filtered) {
    const name = channelName(video);
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(video);
  }
  const names = [...groups.keys()].sort((a, b) => (a === 'Other videos') - (b === 'Other videos')
    || a.localeCompare(b, undefined, {sensitivity:'base'}));
  for (const name of names) library.append(channelBlock(name, groups.get(name), preparingID, Boolean(query)));
}
function rerenderLibrary() { librarySignature = ''; if (lastLibrary) renderLibrary(lastLibrary.videos, lastLibrary.preparingID); }
$('library-sort').onchange = event => {
  librarySort = LIBRARY_SORTS.includes(event.target.value) ? event.target.value : 'added';
  prefs.set('vp-library-sort', librarySort); rerenderLibrary();
};
for (const view of LIBRARY_VIEWS) $(`view-${view}`).onclick = () => {
  libraryView = view; prefs.set('vp-library-view', view); rerenderLibrary();
};
$('library-filter').oninput = event => { libraryFilter = String(event.target.value || '').trim(); rerenderLibrary(); };
function renderQueue(videos, activeID = '') {
  const queued = videos.filter(video => video.state === 'preparing');
  const panel = $('queue-panel');
  panel.hidden = !queued.length;
  $('queue-badge').textContent = `${queued.length} queued`;
  $('queue-summary').textContent = queued.length ? `${queued.length} video${queued.length === 1 ? '' : 's'} in progress` : '';
  const list = $('queue-list'); list.replaceChildren();
  queued.forEach((video, index) => {
    const active = video.id?.toLowerCase() === activeID?.toLowerCase();
    const subtitle = active ? (video.message || 'Preparing now') : (video.message || 'Waiting for preparation');
    const action = {label:active ? 'Cancel and remove' : 'Remove', run:() => removeVideo(video.id)};
    list.append(card(`${index + 1}. ${video.title}`, subtitle, action,
      video.youtubeID ? `https://i.ytimg.com/vi/${encodeURIComponent(video.youtubeID)}/mqdefault.jpg` : null));
  });
}
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const videos = await api('/api/library');
    $('host-ui').hidden = false;
    $('connection').textContent = 'Connected to iPhone';
    $('connection').dataset.state = 'online';
    const statusStarted = globalThis.performance?.now?.() ?? Date.now();
    const status = await api('/api/status');
    reportDiagnostic('browserRTT', {elapsedMs:Math.round((globalThis.performance?.now?.() ?? Date.now()) - statusStarted)});
    $('dashboard-state').textContent = statusLabel(status);
    $('dashboard-state').dataset.state = status.tunnel === 'connected' ? 'online' : 'waiting';
    $('dashboard-connection').textContent = status.tunnel === 'connected' ? 'Connected' : (status.tunnel || 'Waiting');
    $('dashboard-download').textContent = `${(Number(status.downloadMbps) || 0).toFixed(2)} Mb/s`;
    $('dashboard-upload').textContent = `${(Number(status.uploadMbps) || 0).toFixed(2)} Mb/s`;
    $('dashboard-queue').textContent = String(Number(status.queuedCount) || 0);
    $('settings-auth').textContent = status.authentication === 'faceID-on-start' ? 'Face ID per app session' : 'App authorization';
    $('settings-youtube').textContent = status.youtubeSignedIn ? 'Google connected' : 'Sign in on iPhone';
    $('settings-search').textContent = status.youtubeSearch ? 'Enabled' : 'Add API key on iPhone';
    $('settings-version').textContent = status.version
      ? `v${status.version}${status.build ? ` · build ${status.build}` : ''}` : '—';
    if (!searchChromeReady) { searchChromeReady = true; setSearchChrome(); }
    renderLibrary(videos, status.preparingID);
    updateResultButtons();
    renderQueue(videos, status.preparingID);
    updatePreparation(status, videos);
    const down = Number(status.downloadMbps) || 0, up = Number(status.uploadMbps) || 0;
    $('traffic-status').textContent = `Receiving ${down.toFixed(2)} Mb/s · Sending ${up.toFixed(2)} Mb/s`;
    $('explore-panel').hidden = !status.youtubeExplore;
    $('explore-title').textContent = status.youtubeSignedIn ? 'From your subscriptions' : 'Trending now';
    $('search-hint').textContent = searchState.results.length ? '' : 'Search all of YouTube, or paste a link to add a video directly.';
    $('preparation-detail').dataset.queue = status.queuedCount ? `${status.queuedCount} more queued` : '';
    if (exploreAccount !== Boolean(status.youtubeSignedIn)) {
      exploreAccount = Boolean(status.youtubeSignedIn);
      $('explore-results').replaceChildren(); exploreAttemptAt = 0;
    }
    if (status.youtubeExplore && !$('explore-results').children.length && Date.now() - exploreAttemptAt > 60000) void loadExplore();
  } catch (error) {
    $('connection').textContent = 'Connection lost'; $('connection').dataset.state = 'offline';
    notice(error.message || 'Open Video Pilot on the iPhone and start hosting.');
  } finally { refreshing = false; }
}
function statusLabel(status) {
  if (status.tunnel === 'connected') return status.busy ? 'Preparing' : 'Ready';
  return status.tunnel || 'Waiting';
}
async function loadExplore() {
  if (exploring) return;
  exploring = true; exploreAttemptAt = Date.now();
  try {
    const results = await api('/api/explore');
    $('explore-results').replaceChildren(...results.map(video => card(video.title, video.channel, {label:'Add to queue',run:() => queueVideo(video.id)}, video.thumbnail)));
  } catch (error) { notice(error.message); }
  finally { exploring = false; }
}
function updatePreparation(status, videos) {
  $('preparation-panel').hidden = !status.busy;
  if (!status.busy) return;
  const titles = {resolving:'Finding your video', importing:'Importing video', downloading:'Downloading video',
    waitingForApp:'Download complete', processing:'Preparing for playback', finalizing:'Adding to your library'};
  $('preparation-title').textContent = titles[status.preparationStage] || 'Preparing video';
  const video = videos.find(item => item.id?.toLowerCase() === status.preparingID?.toLowerCase());
  $('preparation-video').textContent = video?.title || 'Your video';
  const fraction = status.preparationProgress;
  if (typeof fraction === 'number' && Number.isFinite(fraction)) {
    const value = Math.max(0, Math.min(1, fraction));
    $('preparation-progress').value = value;
    $('preparation-percent').textContent = `${Math.floor(value * 100)}%`;
  } else {
    $('preparation-progress').removeAttribute('value'); $('preparation-percent').textContent = '';
  }
  let detail = 'Your video will appear below when it is ready.';
  if (status.preparationStage === 'waitingForApp') detail = 'Open Video Pilot on the iPhone to finish processing.';
  if (status.preparationStage === 'processing') {
    const speed = status.processingSpeed, remaining = status.preparationSecondsRemaining;
    detail = typeof speed === 'number' && Number.isFinite(speed) && speed > 0
      ? `${speed.toFixed(1)}× real time` : 'Measuring preparation speed…';
    if (typeof remaining === 'number' && Number.isFinite(remaining) && remaining >= 0) {
      const seconds = Math.ceil(remaining);
      detail += ` · About ${seconds < 60 ? `${seconds}s` : `${Math.ceil(seconds / 60)} min`} remaining`;
    }
  }
  if (status.queuedCount) detail += ` · ${status.queuedCount} queued next`;
  $('preparation-detail').textContent = detail;
}
let toastTimer = null;
function toast(message) {
  $('toast').textContent = message; $('toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 3200);
}
async function queueVideo(url) {
  try {
    await api('/api/youtube', {url}); notice('');
    toast('Added. Your iPhone is preparing it; it appears in the library when ready.');
    await refresh(); return true;
  } catch (error) { notice(error.message); return false; }
}
async function removeVideo(id) {
  try { const result = await api('/api/library/remove', {id}); notice(result.pending ? 'Cancelling preparation and removing video…' : 'Video removed.'); await refresh(); }
  catch (error) { notice(error.message); }
}
// ---- Search ----
const SEARCH_FILTERS = ['any', 'short', 'medium', 'long', 'week', 'newest'];
const searchState = {query:'', filter:'any', continuation:null, results:[], seq:0, loading:false};
const resultButtons = new Map();
const queuedFromSearch = new Set();
let suggestTimer = null, suggestSeq = 0, suggestHide = null;
let searchChromeReady = false;
const RECENT_KEY = 'vp-recent-searches';
function recentSearches() {
  try { const value = JSON.parse(prefs.get(RECENT_KEY, '[]')); return Array.isArray(value) ? value.filter(item => typeof item === 'string').slice(0, 8) : []; }
  catch { return []; }
}
function rememberSearch(query) {
  prefs.set(RECENT_KEY, JSON.stringify([query, ...recentSearches().filter(item => item.toLowerCase() !== query.toLowerCase())].slice(0, 8)));
}
// A pasted link (or a bare 11-character video ID) prepares that video directly.
function linkedVideoID(text) {
  const value = String(text || '').trim();
  const link = value.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:[^#]*&)?v=|shorts\/|live\/|embed\/))([\w-]{11})/);
  if (link) return link[1];
  return /^[\w-]{11}$/.test(value) && /[A-Z]/.test(value) && /[a-z]/.test(value) && /[\d_-]/.test(value) ? value : null;
}
function libraryEntry(youtubeID) { return lastLibrary?.videos.find(video => video.youtubeID === youtubeID) || null; }
function updateResultButton(id) {
  const button = resultButtons.get(id);
  if (!button) return;
  const entry = libraryEntry(id);
  button.disabled = false; button.className = '';
  if (entry?.state === 'ready') { button.textContent = savedResume(entry) ? 'Resume in library' : 'Play from library'; button.onclick = () => play(entry); return; }
  if (entry && entry.state === 'preparing') { button.textContent = 'Preparing on iPhone…'; button.className = 'quiet'; button.disabled = true; return; }
  if (queuedFromSearch.has(id) && !entry) { button.textContent = 'Added ✓'; button.className = 'quiet'; button.disabled = true; return; }
  button.textContent = entry ? 'Try again' : 'Add to library';
  button.onclick = async () => {
    button.disabled = true; button.textContent = 'Adding…';
    if (await queueVideo(id)) { queuedFromSearch.add(id); updateResultButton(id); }
    else { button.disabled = false; button.textContent = 'Add to library'; }
  };
}
function updateResultButtons() { for (const id of resultButtons.keys()) updateResultButton(id); }
function resultCard(video) {
  const node = element('article', 'card result-card');
  node.append(videoThumb({title:video.title, youtubeID:video.id, duration:0}, null));
  if (video.duration) node.firstChild.append(element('span', 'duration-badge', video.duration));
  const body = element('div', 'card-body');
  body.append(element('h3', '', video.title));
  const meta = element('p', 'result-meta');
  if (video.channel) {
    const channel = element('button', 'channel-link', video.channel); channel.type = 'button';
    channel.title = `More from ${video.channel}`;
    channel.onclick = () => { $('query').value = video.channel; void runSearch(video.channel); };
    meta.append(channel);
  }
  const extra = [video.views, video.published].filter(Boolean).join(' · ');
  if (extra) meta.append(element('span', '', (video.channel ? ' · ' : '') + extra));
  body.append(meta);
  const button = element('button'); button.type = 'button'; body.append(button);
  node.append(body);
  resultButtons.set(video.id, button); updateResultButton(video.id);
  return node;
}
function setSearchChrome() {
  const hasQuery = Boolean($('query').value);
  $('query-clear').hidden = !hasQuery;
  $('search-start').hidden = Boolean(searchState.query) && searchState.results.length > 0;
  $('load-more').hidden = !searchState.continuation || !searchState.results.length;
  $('load-more').disabled = searchState.loading;
  $('load-more').textContent = searchState.loading ? 'Loading…' : 'Load more results';
  $('search-submit').disabled = searchState.loading && !searchState.results.length;
  const recent = recentSearches();
  $('recent-searches').hidden = !recent.length;
  $('recent-searches').replaceChildren(...(recent.length ? [element('span', 'chip-label', 'Recent'), ...recent.map(query => {
    const chip = element('button', 'chip', query); chip.type = 'button';
    chip.onclick = () => { $('query').value = query; void runSearch(query); };
    return chip;
  }), Object.assign(element('button', 'chip chip-clear', 'Clear'), {type:'button', onclick:() => { prefs.set(RECENT_KEY, '[]'); setSearchChrome(); }})] : []));
}
function hideSuggestions() { clearTimeout(suggestTimer); suggestSeq++; $('suggestions').hidden = true; $('suggestions').replaceChildren(); }
function showSuggestions(items) {
  $('suggestions').replaceChildren(...items.map(item => {
    const option = element('button', 'suggestion' + (item.link ? ' suggestion-link' : ''), item.label);
    option.type = 'button'; option.setAttribute('role', 'option');
    option.onmousedown = event => event.preventDefault();
    option.onclick = () => { hideSuggestions(); if (item.link) void queueVideo(item.value); else { $('query').value = item.value; void runSearch(item.value); } };
    return option;
  }));
  $('suggestions').hidden = !items.length;
}
async function runSearch(rawQuery, append = false) {
  const query = String(rawQuery || '').trim();
  if (!query) return;
  hideSuggestions();
  if (!append && linkedVideoID(query)) {
    if (await queueVideo(query)) { $('query').value = ''; setSearchChrome(); }
    return;
  }
  const seq = ++searchState.seq;
  searchState.loading = true;
  if (!append) {
    Object.assign(searchState, {query, continuation:null, results:[]});
    resultButtons.clear(); rememberSearch(query);
    $('query').blur?.();
    $('results').replaceChildren(...Array.from({length:6}, () => element('div', 'card skeleton')));
    $('search-summary').hidden = false; $('search-summary').textContent = `Searching for “${query}”…`;
    $('search-hint').textContent = '';
  }
  setSearchChrome();
  try {
    const params = new URLSearchParams({q:searchState.query, filter:searchState.filter});
    if (append && searchState.continuation) params.set('continuation', searchState.continuation);
    const page = await api('/api/search?' + params.toString());
    if (seq !== searchState.seq) return;
    const results = Array.isArray(page) ? page : (page.results || []);
    searchState.continuation = Array.isArray(page) ? null : (page.continuation || null);
    const known = new Set(searchState.results.map(video => video.id));
    const fresh = results.filter(video => video?.id && !known.has(video.id));
    searchState.results.push(...fresh);
    if (!append) $('results').replaceChildren();
    $('results').append(...fresh.map(resultCard));
    const filterLabel = document.querySelector?.(`[data-filter="${searchState.filter}"]`)?.textContent;
    $('search-summary').textContent = searchState.results.length
      ? `${searchState.results.length} videos for “${searchState.query}”${searchState.filter !== 'any' && filterLabel ? ` · ${filterLabel}` : ''}`
      : `No videos found for “${searchState.query}”. Try different words or another filter.`;
  } catch (error) {
    if (seq !== searchState.seq) return;
    if (!append) { $('results').replaceChildren(); $('search-summary').textContent = 'Search did not complete.'; }
    notice(error.message);
  } finally {
    if (seq === searchState.seq) { searchState.loading = false; setSearchChrome(); }
  }
}
$('search-form').onsubmit = event => { event.preventDefault(); void runSearch($('query').value); };
$('query').oninput = () => {
  setSearchChrome();
  const value = $('query').value.trim();
  clearTimeout(suggestTimer);
  if (linkedVideoID(value)) { showSuggestions([{label:'Add this video to your library', value, link:true}]); return; }
  if (value.length < 2) { hideSuggestions(); return; }
  const seq = ++suggestSeq;
  suggestTimer = setTimeout(async () => {
    try {
      const items = await api('/api/suggest?q=' + encodeURIComponent(value));
      if (seq === suggestSeq && $('query').value.trim() === value && Array.isArray(items)) {
        showSuggestions(items.filter(item => typeof item === 'string').slice(0, 7).map(item => ({label:item, value:item})));
      }
    } catch {}
  }, 220);
};
$('query').onkeydown = event => { if (event.key === 'Escape') hideSuggestions(); };
$('query').onblur = () => { clearTimeout(suggestHide); suggestHide = setTimeout(hideSuggestions, 150); };
$('query-clear').onclick = () => { $('query').value = ''; hideSuggestions(); setSearchChrome(); $('query').focus?.(); };
$('load-more').onclick = () => { if (!searchState.loading) void runSearch(searchState.query, true); };
document.querySelectorAll?.('[data-filter]').forEach(button => button.onclick = () => {
  searchState.filter = SEARCH_FILTERS.includes(button.dataset.filter) ? button.dataset.filter : 'any';
  document.querySelectorAll?.('[data-filter]').forEach(other => other.setAttribute('aria-pressed', other === button ? 'true' : 'false'));
  if (searchState.query) void runSearch(searchState.query);
});
document.querySelectorAll?.('[data-query]').forEach(button => button.onclick = () => {
  $('query').value = button.dataset.query || ''; void runSearch($('query').value);
});
document.querySelectorAll?.('[data-go]').forEach(button => button.onclick = () => goTo(button.dataset.go));
$('explore-refresh').onclick = () => { void loadExplore(); };
function formatTime(value) {
  const seconds = Math.max(0, Math.floor(Number(value) || 0));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
function finiteDuration(value) {
  const duration = Number(value);
  return Number.isFinite(duration) && duration > 0 ? duration : 0;
}
function updateTimeline(position, duration) {
  const total = finiteDuration(duration);
  const currentTime = Math.max(0, Number(position) || 0);
  const clamped = total ? Math.min(currentTime, total) : currentTime;
  $('timeline').max = String(total || Math.max(1, clamped));
  $('timeline').value = String(clamped);
  $('elapsed').textContent = formatTime(clamped);
  if (total) $('duration').textContent = formatTime(total);
}
function invalidateSeeks() {
  seekGeneration += 1;
  globalThis.clearTimeout?.(seekTimer); seekTimer = null;
}
function clearRecoveryTimer(session) {
  if (!session) return;
  if (session.startupTimer) globalThis.clearTimeout?.(session.startupTimer);
  if (session.stallTimer) globalThis.clearInterval?.(session.stallTimer);
  session.startupTimer = null;
  session.stallTimer = null;
}
function syncFullscreenControls(active) {
  const shell = $('player-shell');
  if (active) shell.classList?.add?.('vp-fullscreen');
  else shell.classList?.remove?.('vp-fullscreen');
  $('fullscreen').hidden = active;
  $('exit-fullscreen').hidden = !active;
}
function leaveFullscreen() {
  fullscreenFallback = false;
  syncFullscreenControls(false);
  try {
    const shell = $('player-shell');
    const native = document.fullscreenElement === shell || document.webkitFullscreenElement === shell;
    const exit = document.exitFullscreen || document.webkitExitFullscreen;
    if (native) exit?.call(document);
  } catch {}
}
function syncCanvasAspect() {
  const canvas = $('screen');
  const width = Number(player?.video?.width || canvas?.width);
  const height = Number(player?.video?.height || canvas?.height);
  if (width > 0 && height > 0) canvas.style?.setProperty?.('aspect-ratio', `${width} / ${height}`);
}
function closePlayer(resumePosition = null) {
  if (resumePosition !== null && current) saveResume(current, resumePosition);
  else saveResume();
  leaveFullscreen();
  const oldPlayback = playback;
  clearRecoveryTimer(oldPlayback);
  playback = null;
  globalThis.clearTimeout?.(seekTimer); seekTimer = null;
  const oldPlayer = player;
  try { audioLimiter?.disconnect?.(); } catch {}
  audioLimiter = null;
  player = null; currentOffset = 0; $('player-section').hidden = true;
  const source = oldPlayer?.source;
  let stopped = source?.stoppedPromise;
  let playerDestroyed = false;
  try {
    if (typeof oldPlayer?.destroy === 'function') {
      oldPlayer.destroy();
      playerDestroyed = true;
    }
  } catch {}
  // JSMpeg.Player.destroy owns source teardown. The direct fallback is only
  // for lightweight doubles/older decoders that do not expose destroy().
  if (!playerDestroyed) {
    try { stopped = source?.destroy?.() || stopped; } catch {}
  }
  if (!stopped || typeof stopped.then !== 'function') return Promise.resolve();
  // URLSession/ReadableStream cancellation should settle immediately. The
  // timeout is only a guard for browsers that do not resolve an aborted read.
  return Promise.race([
    stopped.catch(() => {}),
    new Promise(resolve => {
      const timer = globalThis.setTimeout;
      if (typeof timer === 'function') timer(resolve, 1000);
      else resolve();
    }),
  ]);
}
function unlockAudio() {
  try {
    player?.audioOut?.unlock(() => {});
    const context = player?.audioOut?.context;
    if (context?.state === 'suspended' || context?.state === 'interrupted') context.resume()?.catch(() => {});
  } catch { /* A later Play or Unmute gesture can retry audio activation. */ }
}
function configureAudioLimiter() {
  const output = player?.audioOut;
  const context = output?.context;
  const gain = output?.gain;
  if (!context || !gain) return;
  try {
    if (!audioBoost) {
      // Unity gain is the clean baseline. Remove the compressor entirely when
      // Audio + is off; some Tesla WebAudio builds introduce their own clicks
      // when an unnecessary dynamics node sits in the output path.
      audioLimiter?.disconnect?.();
      audioLimiter = null;
      gain.disconnect();
      gain.connect(context.destination);
      return;
    }
    if (typeof context.createDynamicsCompressor !== 'function') return;
    if (audioLimiter?.context === context) return;
    audioLimiter?.disconnect?.();
    // JSMpeg normally connects its gain node directly to the destination.
    // Replace that direct edge with a conservative compressor so the optional
    // browser boost cannot clip loud source peaks into crackling distortion.
    gain.disconnect();
    const limiter = context.createDynamicsCompressor();
    limiter.threshold.value = -3;
    limiter.knee.value = 6;
    limiter.ratio.value = 8;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.12;
    gain.connect(limiter);
    limiter.connect(context.destination);
    audioLimiter = limiter;
  } catch {
    // Older Tesla WebAudio implementations may not support a compressor;
    // leave JSMpeg's direct, unmodified output intact in that case.
    try { gain.disconnect(); gain.connect(context.destination); } catch {}
    audioLimiter = null;
  }
}
function applyAudioState() {
  if (!player) return;
  configureAudioLimiter();
  const volume = audioMuted ? 0 : (audioBoost ? audioBoostVolume : 1);
  try {
    // JSMpeg exposes both the public volume property and its GainNode. Set
    // both so a gain change is audible immediately, including already queued
    // WebAudio buffers.
    player.volume = volume;
    const gain = player.audioOut?.gain?.gain;
    if (gain && typeof gain.value === 'number') gain.value = volume;
  } catch {}
  const mute = $('mute');
  if (mute) mute.textContent = audioMuted ? 'Unmute' : 'Mute';
  const boost = $('audio-boost');
  if (boost) {
    boost.textContent = audioBoost ? 'Audio +' : 'Audio';
    boost.setAttribute?.('aria-pressed', audioBoost ? 'true' : 'false');
    boost.title = audioBoost ? 'Audio boost on (115%)' : 'Audio boost off (100%)';
  }
  reportDiagnostic('audioState', {muted:audioMuted, boost:audioBoost, gain:volume});
}
function boundDecoderBuffers() {
  // Retain timestamp initialization and unread bytes. Compact only consumed
  // data, preserving the small rewind window used by JSMpeg's pause logic.
  for (const decoder of [player?.video, player?.audio].filter(Boolean)) {
    installRecordedBufferWindow(decoder);
  }
  installRecordedAudioOutput(player?.audioOut,
    () => globalThis.JSMpeg?.Now?.() ?? (globalThis.performance?.now?.() ?? Date.now()) / 1000);
  installRecordedAudioLead(player);
  installRecordedPlayerPause(player);
  reportDiagnostic('decoderBuffersBound', {
    videoBufferBytes:Number(player?.video?.bits?.bytes?.length) || 0,
    audioBufferBytes:Number(player?.audio?.bits?.bytes?.length) || 0
  });
}
function startPlayer(video, seek = null, recoveryAttempt = 0, busyRetries = 0) {
  current = video;
  const duration = finiteDuration(video.duration);
  const storedResume = seek === null ? savedResume(video) : 0;
  currentOffset = Math.max(0, Number(seek ?? storedResume) || 0);
  if (duration) currentOffset = Math.min(currentOffset, duration);
  if (storedResume > 0) reportDiagnostic('resumeLoaded', {positionSeconds:currentOffset});
  reportDiagnostic('playerStart', {seekTargetSeconds:currentOffset, recoveryAttempt});
  const session = {paused:false, failed:false, ended:false, baseOffset:currentOffset,
    position:currentOffset, duration, decoded:false, startupTimer:null, stallTimer:null,
    lastDecodedAt:0, recoveryAttempt, busyRetries}; playback = session;
  const active = () => playback === session && !session.paused && !session.failed && !session.ended;
  const recoveryDelay = () => {
    const override = Number(globalThis.__VP_SEEK_RECOVERY_MS);
    if (Number.isFinite(override) && override >= 0) return override;
    return session.baseOffset > 0 ? 10000 : 15000;
  };
  const restartSession = (message, event = null) => {
    if (session.recoveryAttempt >= 1 || !current) return false;
    const videoAtError = current;
    const target = Math.max(0, Math.floor((session.position || session.baseOffset || 0) - 1));
    const generation = ++seekGeneration;
    session.failed = true; session.paused = true;
    if (event) reportDiagnostic(event, {positionSeconds:session.position || 0,
      seekTargetSeconds:target, recoveryAttempt:session.recoveryAttempt});
    $('playback-status').textContent = message;
    seekChain = seekChain.then(async () => {
      if (generation !== seekGeneration || current !== videoAtError) return;
      await closePlayer(target);
      if (generation !== seekGeneration || current !== videoAtError) return;
      startPlayer(videoAtError, target, session.recoveryAttempt + 1);
    }).catch(error => {
      if (generation === seekGeneration) {
        session.failed = true; session.paused = true;
        $('playback-status').textContent = error?.message || message;
        $('pause').textContent = 'Retry';
      }
    });
    return true;
  };
  // The relay answers HTTP 429 ("iPhone is busy") while it is still releasing
  // the previous stream. That is transient after a seek, so retry the same
  // target with exponential backoff instead of treating it as fatal.
  const retryBusy = text => {
    if (!/HTTP 429/.test(text) || !current) return false;
    if (session.busyRetries >= 5) return false;
    const videoAtError = current;
    const target = Math.max(0, Math.floor(session.position || session.baseOffset || 0));
    const attempt = session.busyRetries + 1;
    const delay = Math.min(3000, 300 * 2 ** session.busyRetries);
    const generation = ++seekGeneration;
    session.failed = true; session.paused = true;
    reportDiagnostic('playerBusyRetry', {seekTargetSeconds:target, attempt, delayMs:delay});
    $('playback-status').textContent = 'iPhone is busy. Retrying…';
    seekChain = seekChain.then(async () => {
      if (generation !== seekGeneration || current !== videoAtError) return;
      await closePlayer(target);
      await new Promise(resolve => globalThis.setTimeout(resolve, delay));
      if (generation !== seekGeneration || current !== videoAtError) return;
      startPlayer(videoAtError, target, session.recoveryAttempt, attempt);
    }).catch(error => {
      if (generation === seekGeneration) {
        $('playback-status').textContent = error?.message || 'iPhone is busy.';
        $('pause').textContent = 'Retry';
      }
    });
    return true;
  };
  const armRecovery = (reset = false) => {
    if (reset && session.startupTimer) {
      globalThis.clearTimeout?.(session.startupTimer);
      session.startupTimer = null;
    }
    if (session.decoded || session.failed || session.ended || session.startupTimer) return;
    const timer = globalThis.setTimeout;
    if (typeof timer !== 'function') return;
    session.startupTimer = timer(() => {
      session.startupTimer = null;
      if (playback !== session || session.decoded || session.failed || session.ended) return;
      if (session.paused) return;
      if (session.recoveryAttempt >= 1) {
        session.failed = true; session.paused = true;
        try { player?.pause(); player?.source?.pauseReading?.(); } catch {}
        $('playback-status').textContent = 'Playback could not resume after seeking. Tap Retry.';
        $('pause').textContent = 'Retry';
        return;
      }
      restartSession('Restarting seek…', 'playerStalled');
    }, recoveryDelay());
    // Node-based UI tests expose timer handles with `unref`; browsers expose
    // numeric IDs, so this is intentionally optional.
    session.startupTimer?.unref?.();
  };
  session.resumeWatchdog = () => {
    session.lastDecodedAt = globalThis.performance?.now?.() ?? Date.now();
    armRecovery(true);
  };
  $('player-section').hidden = false; $('playing-title').textContent = video.title;
  $('playback-status').textContent = 'Buffering…'; $('pause').textContent = 'Pause'; $('mute').textContent = 'Mute';
  $('screen').style?.setProperty?.('aspect-ratio', 'auto');
  updateTimeline(currentOffset, duration);
  try {
    const query = currentOffset > 0 ? `?seek=${encodeURIComponent(currentOffset)}` : '';
    player = new window.JSMpeg.Player(`/api/stream/${encodeURIComponent(video.id)}.ts${query}`, {
      headers:{'x-mk8-player': playbackClient},
      source:JSMpegHttpSource,canvas:$('screen'),autoplay:true,loop:false,disableWebAssembly:true,
      onSourceStartTime:value => {
        if (playback !== session) return;
        const actual = Number(value);
        if (!Number.isFinite(actual) || actual < 0) return;
        session.baseOffset = actual;
        session.position = actual;
        currentOffset = actual;
        updateTimeline(actual, session.duration);
        reportDiagnostic('sourceResponse', {seekTargetSeconds:actual, durationSeconds:session.duration || 0});
      },
      onSourceEstablished:() => {
        if (playback === session) armRecovery(true);
        reportDiagnostic('sourceEstablished', {seekTargetSeconds:session.baseOffset || 0});
      },
      onSourceDuration:value => {
        if (playback !== session) return;
        const actual = finiteDuration(value);
        if (!actual) return;
        session.duration = actual;
        updateTimeline(session.position, actual);
      },
      onStalled:() => {
        if (active()) {
          $('playback-status').textContent = 'Buffering…';
          // A starved decoder fires this every frame; one entry a second is enough.
          const now = Date.now();
          if (now - (session.lastStallReport || 0) >= 1000) {
            session.lastStallReport = now;
            reportDiagnostic('playerStalled', {positionSeconds:session.position || 0});
          }
          if (!session.decoded) armRecovery();
        }
      },
      onVideoDecode:() => {
        if (playback !== session || session.failed || session.ended) return;
        syncCanvasAspect();
        session.decoded = true;
        if (session.startupTimer) {
          globalThis.clearTimeout?.(session.startupTimer);
          session.startupTimer = null;
        }
        session.lastDecodedAt = globalThis.performance?.now?.() ?? Date.now();
        // A source can stop producing bytes after the first frame without
        // firing an error. Keep a low-frequency post-decode watchdog so a
        // black “Buffering…” screen gets one bounded reconnect instead of
        // hanging until the Tesla browser is refreshed.
        if (!session.stallTimer) {
          session.stallTimer = setInterval(() => {
            if (playback !== session || session.failed || session.ended) {
              clearRecoveryTimer(session); return;
            }
            if (session.paused) return;
            const now = globalThis.performance?.now?.() ?? Date.now();
            if (now - session.lastDecodedAt < 10000) return;
            const timer = session.stallTimer;
            session.stallTimer = null;
            globalThis.clearInterval?.(timer);
            if (!restartSession('Playback interrupted. Reconnecting…', 'playerStalled')) {
              session.failed = true; session.paused = true;
              $('playback-status').textContent = 'Playback stalled. Tap Retry.';
              $('pause').textContent = 'Retry';
            }
          }, 2000);
          session.stallTimer?.unref?.();
        }
        reportDiagnostic('playerDecode', {positionSeconds:session.position || 0});
        if (active()) $('playback-status').textContent = 'Playing from your iPhone';
      },
      onSourceError:message => {
        if (playback !== session) return;
        clearRecoveryTimer(session);
        saveResume();
        const text = String(message || 'Unable to read video stream.');
        const retryable = !/Pair this browser|HTTP 4\d\d|not ready|no longer exists/i.test(text);
        reportDiagnostic('playerError', {error:text, positionSeconds:session.position || 0,
          recoveryAttempt:session.recoveryAttempt});
        if (retryBusy(text)) return;
        if (retryable && restartSession('Connection interrupted. Reconnecting…')) return;
        session.failed = true; session.paused = true;
        try { player?.pause(); player?.source?.pauseReading?.(); } catch {}
        $('pause').textContent = 'Retry'; $('playback-status').textContent = text;
      },
      onEnded:() => {
        if (playback !== session || session.failed) return;
        clearRecoveryTimer(session);
        session.ended = true;
        if (session.duration) session.position = session.duration;
        currentOffset = session.position;
        updateTimeline(session.position, session.duration);
        $('playback-status').textContent = 'Finished'; $('pause').textContent = 'Play';
        clearResume(video);
        markWatched(video);
        reportDiagnostic('playerEnded', {positionSeconds:session.position || 0, durationSeconds:session.duration || 0});
      }
    });
    boundDecoderBuffers();
    applyAudioState();
    // Arm a bounded watchdog even if the source never emits an established
    // callback. A failed seek must become a retryable state, not a permanent
    // black canvas with an endless spinner.
    armRecovery();
    unlockAudio();
    showTab('player-section');
    $('player-section').scrollIntoView({behavior:'smooth',block:'start'});
  } catch (error) { session.failed = true; $('playback-status').textContent = error.message; }
}
function play(video, seek = null) {
  invalidateSeeks();
  // Opening the first video can stay synchronous for a responsive button. A
  // replacement is serialized behind decoder teardown so an old read loop can
  // never write into the new decoder while a seek is in flight.
  if (!player && !playback) { startPlayer(video, seek); return; }
  const generation = seekGeneration;
  seekChain = seekChain.then(async () => {
    await closePlayer();
    if (generation === seekGeneration) startPlayer(video, seek);
  }).catch(error => {
    if (generation === seekGeneration) $('playback-status').textContent = error?.message || 'Unable to start playback.';
  });
}
$('pause').onclick = () => {
  if (!player) return;
  if (playback?.ended && current) { requestSeek(0); return; }
  if (playback?.failed && current) {
    // The watchdog pauses a decoder that could not produce a frame after a
    // seek. Reusing the normal seek path guarantees the stale source is
    // cancelled before the retry starts.
    requestSeek(currentOffset);
    return;
  }
  if (!player.paused) {
    if (playback) { playback.paused = true; playback.pausedAt = Date.now(); }
    player.pause(); player.source?.pauseReading(); $('pause').textContent = 'Play';
    if (!playback?.failed && !playback?.ended) $('playback-status').textContent = 'Paused';
  } else {
    // The iPhone releases a relay stream nobody has read for 45 s, so after a
    // long pause reopen at the same position instead of resuming a dead stream.
    if (current && playback?.pausedAt && Date.now() - playback.pausedAt > 30000) {
      $('pause').textContent = 'Pause'; requestSeek(currentOffset); return;
    }
    if (playback) playback.paused = false;
    playback?.resumeWatchdog?.();
    unlockAudio(); player.source?.resumeReading(); player.play(); $('pause').textContent = 'Pause';
    if (!playback?.failed && !playback?.ended) $('playback-status').textContent = 'Buffering…';
  }
};
$('back10').onclick = () => { if (current) requestSeek(Math.max(0, currentOffset - 10)); };
$('forward10').onclick = () => { if (current) requestSeek(Math.min(current.duration || Infinity, currentOffset + 10)); };
$('close').onclick = () => {
  invalidateSeeks();
  void closePlayer().then(() => showTab('youtube-tab'));
};
$('mute').onclick = () => {
  if (player) {
    audioMuted = !audioMuted;
    applyAudioState();
    if (!audioMuted) unlockAudio();
  }
};
$('audio-boost').onclick = () => {
  audioBoost = !audioBoost;
  try { globalThis.localStorage?.setItem(audioBoostKey, audioBoost ? 'on' : 'off'); } catch {}
  applyAudioState();
  if (!audioMuted) unlockAudio();
};
async function enterFullscreen() {
  const shell = $('player-shell');
  fullscreenFallback = true;
  syncFullscreenControls(true);
  try {
    await shell.requestFullscreen?.();
    const native = document.fullscreenElement === shell || document.webkitFullscreenElement === shell;
    if (native) fullscreenFallback = false;
  } catch { /* The CSS fallback still fills the Tesla browser viewport. */ }
}
$('fullscreen').onclick = enterFullscreen;
$('exit-fullscreen').onclick = leaveFullscreen;
document.addEventListener?.('fullscreenchange', () => {
  const shell = $('player-shell');
  const full = document.fullscreenElement === shell || document.webkitFullscreenElement === shell;
  if (full) { fullscreenFallback = false; syncFullscreenControls(true); }
  else if (!fullscreenFallback) syncFullscreenControls(false);
});
function requestSeek(offset) {
  if (!current) return;
  globalThis.clearTimeout?.(seekTimer);
  const target = Math.max(0, Number(offset) || 0);
  const video = current;
  const generation = ++seekGeneration;
  $('playback-status').textContent = 'Seeking…';
  reportDiagnostic('playerSeek', {seekTargetSeconds:target, positionSeconds:currentOffset});
  // Commit the user's target before tearing down the old decoder. If the
  // replacement stream fails or the page disappears during the handoff,
  // Resume should reopen at the requested point, not the stale old position.
  saveResume(video, target);
  seekTimer = setTimeout(() => {
    seekTimer = null;
    seekChain = seekChain.then(async () => {
      // A newer seek supersedes this one while the previous stream is being
      // cancelled. Do not create a player for an obsolete target.
      if (generation !== seekGeneration || current !== video) return;
      await closePlayer(target);
      // Short grace so the phone can release the old stream before the new one opens.
      await new Promise(resolve => setTimeout(resolve, 150));
      if (generation !== seekGeneration || current !== video) return;
      startPlayer(video, target);
    }).catch(error => {
      if (generation === seekGeneration) $('playback-status').textContent = error?.message || 'Unable to seek.';
    });
  }, 350);
}
$('timeline').onchange = event => requestSeek(Number(event.target.value));
document.querySelectorAll?.('.tab').forEach(tab => tab.onclick = () => showTab(tab.dataset.tab));
$('menu-toggle').onclick = () => {
  const menu = $('tab-menu'), open = menu.hidden;
  menu.hidden = !open; $('menu-toggle').setAttribute('aria-expanded', open ? 'true' : 'false');
};
if ($('theme-toggle')) $('theme-toggle').onclick = () => {
  applyTheme(document.documentElement?.dataset.theme === 'dark' ? 'light' : 'dark');
};
function downloadDiagnosticsText(text, name) {
  const blob = new Blob([text], {type:'application/x-ndjson'});
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = name; link.rel = 'noopener';
  document.body?.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}
function browserDiagnosticsText() {
  return diagnosticsJournal.text();
}
async function combinedDiagnosticsText() {
  await flushDiagnostics();
  const {response, body:text} = await timedFetch('/api/diagnostics/export', {credentials:'same-origin', cache:'no-store'}, 5000, r => r.text());
  if (!response.ok) throw new Error('The iPhone has no combined log yet.');
  // Include every locally retained browser event, including batches awaiting
  // delivery. De-duplicate ACKed entries already present in the phone journal.
  const merged = [], ids = new Set();
  for (const line of (text + '\n' + browserDiagnosticsText()).split('\n')) {
    if (!line.trim()) continue;
    try { const entry = JSON.parse(line);
      if (entry.eventId && ids.has(entry.eventId)) continue;
      if (entry.eventId) ids.add(entry.eventId);
      merged.push(entry);
    } catch {}
  }
  merged.sort((a, b) => String(a.occurredAt || a.timestamp || '').localeCompare(String(b.occurredAt || b.timestamp || '')));
  return merged.map(JSON.stringify).join('\n') + '\n';
}
function showDiagnosticsText(text) {
  const output = $('diagnostics-log');
  if (!output) return;
  output.value = text;
  output.hidden = false;
  output.focus?.(); output.select?.();
}
if ($('export-diagnostics')) $('export-diagnostics').onclick = async () => {
  const status = $('diagnostics-export-status');
  status.textContent = 'Flushing browser events…';
  try {
    const text = await combinedDiagnosticsText();
    downloadDiagnosticsText(text, `VideoPilot-diagnostics-${new Date().toISOString().replace(/:/g,'-')}.jsonl`);
    showDiagnosticsText(text);
    status.textContent = 'Combined web + iPhone diagnostics downloaded.';
  } catch {
    // If the tunnel is down, still make the locally retained browser trace
    // available instead of losing the evidence that explains the outage.
    if (diagnosticsQueue.length) {
      const text = browserDiagnosticsText();
      downloadDiagnosticsText(text,
        `VideoPilot-browser-diagnostics-${new Date().toISOString().replace(/:/g,'-')}.jsonl`);
      showDiagnosticsText(text);
      status.textContent = 'Tunnel unavailable; browser-only diagnostics downloaded. Reconnect and export again for the combined log.';
    } else status.textContent = 'Reconnect the iPhone host, then try the export again.';
  }
};
if ($('copy-diagnostics')) $('copy-diagnostics').onclick = async () => {
  const status = $('diagnostics-export-status');
  status.textContent = 'Preparing diagnostics…';
  let text = '';
  try { text = await combinedDiagnosticsText(); }
  catch { text = browserDiagnosticsText(); }
  if (!text) { status.textContent = 'Reconnect the iPhone host, then try the export again.'; return; }
  showDiagnosticsText(text);
  try {
    if (globalThis.navigator?.clipboard?.writeText) await globalThis.navigator.clipboard.writeText(text);
    else document.execCommand?.('copy');
    status.textContent = 'Diagnostics shown and copied. Paste them into your support message.';
  } catch { status.textContent = 'Diagnostics shown below; press and hold the text to copy it.'; }
};
document.addEventListener?.('click', event => {
  const menu = $('tab-menu'), toggle = $('menu-toggle');
  if (menu.hidden || event.target === toggle || toggle.contains?.(event.target) || menu.contains?.(event.target)) return;
  menu.hidden = true; toggle.setAttribute('aria-expanded', 'false');
});
document.addEventListener?.('keydown', event => {
  if (event.key !== 'Escape') return;
  $('tab-menu').hidden = true; $('menu-toggle').setAttribute('aria-expanded', 'false');
});
setInterval(() => {
  if (!player || !playback || playback.paused || playback.failed || playback.ended) return;
  const localTime = Number(player.currentTime ?? player.video?.currentTime ?? 0) || 0;
  if (!Number.isFinite(localTime) || localTime < 0) return;
  const time = (playback.baseOffset || 0) + localTime;
  const duration = playback.duration || finiteDuration(current?.duration) || finiteDuration(player.video?.duration);
  // A freshly-created JSMpeg decoder reports zero before its first frame. Keep
  // the indexed seek position until real playback advances, but never carry a
  // position forward from an older player session.
  playback.position = Math.max(playback.position || 0, duration ? Math.min(time, duration) : time);
  currentOffset = playback.position;
  updateTimeline(currentOffset, duration);
  saveResume();
}, 500);
reportDiagnostic('pageLoaded');
window.addEventListener('pagehide', () => { saveResume(); invalidateSeeks(); reportDiagnostic('pageHidden'); reportDiagnostic('playerClosed'); void flushDiagnostics(true); void closePlayer(); });
void refresh();
setInterval(() => { void refresh(); }, 2000);
