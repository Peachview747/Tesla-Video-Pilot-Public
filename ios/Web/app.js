import {JSMpegHttpSource, installRecordedBufferWindow, installRecordedAudioOutput, installRecordedAudioLead, installRecordedPlayerPause} from './http-source.js';
import {DiagnosticsJournal, LiveStats} from './diagnostics.js';
const $ = id => document.getElementById(id);
let player = null, current = null, currentOffset = 0, seekTimer = null;
let fullscreenFallback = false;
let playback = null;
let refreshing = false;
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
// Action errors fade after a while; connection errors are re-set by every poll.
let noticeTimer = null;
const notice = message => {
  $('notice').textContent = message;
  clearTimeout(noticeTimer);
  if (message) { noticeTimer = setTimeout(() => { if ($('notice').textContent === message) $('notice').textContent = ''; }, 10000); noticeTimer?.unref?.(); }
};
const themeKey = 'video-pilot-theme';
// Theme choice is 'system' (follow the browser/car), 'light' or 'dark'.
let themeChoice = 'system';
function resolveTheme(choice) {
  if (choice === 'dark' || choice === 'light') return choice;
  try { return globalThis.matchMedia?.('(prefers-color-scheme: dark)')?.matches ? 'dark' : 'light'; } catch { return 'light'; }
}
function applyTheme(choice) {
  const root = document.documentElement;
  if (root?.dataset) root.dataset.theme = resolveTheme(choice);
}
try {
  const saved = globalThis.localStorage?.getItem(themeKey);
  themeChoice = saved === 'dark' || saved === 'light' ? saved : 'system';
} catch {}
applyTheme(themeChoice);
try {
  globalThis.matchMedia?.('(prefers-color-scheme: dark)')?.addEventListener?.('change', () => { if (themeChoice === 'system') applyTheme('system'); });
} catch {}
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
  // Most videos end with an end screen people skip; treat the last 30 s
  // (or 5%) as finished so they leave Continue watching and Play next moves on.
  const duration = finiteDuration(playback?.duration || video.duration);
  if (duration > 60 && offset >= Math.max(duration - 30, duration * 0.95)) { clearResume(video); markWatched(video); return; }
  try {
    globalThis.localStorage?.setItem(resumeKey(video), String(Math.floor(offset)));
    globalThis.localStorage?.setItem('video-pilot-resume-at:' + video.id, String(Date.now()));
  } catch {}
}
function clearResume(video = current) {
  try { globalThis.localStorage?.removeItem(resumeKey(video)); } catch {}
}
async function api(path, body, timeout = 12000) {
  const started = globalThis.performance?.now?.() ?? Date.now();
  let response;
  try {
    const result = await timedFetch(path, {method:body ? 'POST' : 'GET', credentials:'same-origin', cache:'no-store',
      headers:body ? {'Content-Type':'application/json'} : {}, body:body ? JSON.stringify(body) : undefined}, timeout, r => r.text());
    response = result.response;
    const raw = result.body;
    let parsed;
    try { parsed = raw ? JSON.parse(raw) : {}; }
    catch {
      reportDiagnostic('apiError', {responseStatus:response.status,
        elapsedMs:Math.round((globalThis.performance?.now?.() ?? Date.now()) - started),
        error:response.ok ? 'unexpected-page' : 'invalid-json'});
      const failure = new Error(response.ok
        ? 'The host returned an unexpected page. Refresh the Tesla browser and keep Video Pilot open.'
        : `Connection to Video Pilot failed (${response.status}). Refresh to retry.`);
      failure.status = response.status;
      throw failure;
    }
    if (!response.ok) {
      reportDiagnostic('apiError', {responseStatus:response.status,
        elapsedMs:Math.round((globalThis.performance?.now?.() ?? Date.now()) - started),
        error:String(parsed.error || 'request-failed')});
      const failure = new Error(parsed.error || `Request failed (${response.status}).`);
      failure.status = response.status;
      throw failure;
    }
    return parsed;
  } catch (error) {
    if (!response) reportDiagnostic('apiError', {responseStatus:0,
      elapsedMs:Math.round((globalThis.performance?.now?.() ?? Date.now()) - started),
      error:String(error?.message || 'network-failure')});
    if (!response) throw new Error('The iPhone did not respond. Keep Video Pilot open on the iPhone.');
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
// Live numbers for Settings → Diagnostics, fed by the same events.
const liveStats = new LiveStats();
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
  try { liveStats.record(event, fields); } catch {}
  // Every status poll measures RTT; journaling each one cost an extra
  // /api/diagnostics POST per poll. Keep one sample per 30 s in the log
  // (the live panel still sees every sample).
  const throttle = event === 'browserRTT' ? 30000 : (event === 'playerDecode' ? 1000 : 0);
  if (throttle) {
    if (now - (diagnosticLastTimes.get(event) ?? -Infinity) < throttle) return;
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
// ---- Navigation ----
// Persistent left rail (bottom bar on narrow screens). The channel page is a
// sub-page: the rail keeps highlighting the section it was opened from.
const NAV_TABS = ['home-tab', 'library-tab', 'queue-tab', 'settings-tab'];
let currentTab = 'home-tab';
let navParent = 'home-tab';
function showTab(id) {
  if (id === 'player-section') return;
  currentTab = id;
  if (NAV_TABS.includes(id)) navParent = id;
  document.querySelectorAll?.('.tab-panel').forEach(panel => { panel.hidden = panel.id !== id; });
  document.querySelectorAll?.('.nav-item').forEach(item => {
    const active = item.dataset.tab === navParent;
    item.classList?.toggle?.('active', active);
    if (active) item.setAttribute?.('aria-current', 'page'); else item.removeAttribute?.('aria-current');
  });
  if (NAV_TABS.includes(id)) prefs.set('vp-tab', id);
  if (lastStatus && lastLibrary) updatePreparation(lastStatus, lastLibrary.videos);
  if (id === 'home-tab') maybeLoadFeed();
  if (id === 'settings-tab') { renderSettings(); renderLiveDiagnostics(); }
  if (id === 'queue-tab') void refreshQueueApi();
  if (id === 'library-tab') rerenderLibrary();
}
function goTo(id) {
  if (id === currentTab && id === 'home-tab' && searchState.query) clearSearch();
  showTab(id); window.scrollTo?.({top:0, behavior:'smooth'});
}
const prefs = {
  get(key, fallback = null) { try { return globalThis.localStorage?.getItem(key) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { globalThis.localStorage?.setItem(key, value); } catch {} },
};
// Only these image hosts are allowed by the page's CSP as well.
const IMAGE_HOSTS = ['i.ytimg.com', 'yt3.ggpht.com', 'yt3.googleusercontent.com'];
function safeImageURL(value) {
  if (!value) return '';
  try {
    const url = new URL(String(value).replace(/^\/\//, 'https://'));
    return url.protocol === 'https:' && IMAGE_HOSTS.includes(url.hostname) ? url.href : '';
  } catch { return ''; }
}
function dataSaver() { return prefs.get('vp-data-saver') === 'on'; }
// YouTube thumbnail for an ID: 120x90 (~4 KB) with Data saver, else 320x180.
function youtubeThumb(youtubeID) {
  if (!youtubeID) return '';
  return `https://i.ytimg.com/vi/${encodeURIComponent(youtubeID)}/${dataSaver() ? 'default' : 'mqdefault'}.jpg`;
}
function messageCard(title, subtitle, action) {
  const div = element('article', 'card message-card');
  div.append(element('h3', '', title));
  if (subtitle) div.append(element('p', '', subtitle));
  if (action) {
    const button = element('button', 'button quiet', action.label); button.type = 'button'; button.onclick = action.run;
    const row = element('div', 'button-row'); row.append(button); div.append(row);
  }
  return div;
}
const LIBRARY_SORTS = ['added', 'newest', 'oldest', 'channel'];
const LIBRARY_VIEWS = ['channels', 'all'];
let librarySort = LIBRARY_SORTS.includes(prefs.get('vp-library-sort')) ? prefs.get('vp-library-sort') : 'added';
let libraryView = LIBRARY_VIEWS.includes(prefs.get('vp-library-view')) ? prefs.get('vp-library-view') : 'channels';
let channelOrder = prefs.get('vp-channel-order') === 'newest' ? 'newest' : 'oldest';
let libraryFilter = '';
let librarySignature = '';
let lastLibrary = null;
let lastStatus = null;
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
    if (left === null && right === null) return direction * ((Number(a.createdAt) || 0) - (Number(b.createdAt) || 0));
    if (left === null || right === null) return left === null ? 1 : -1;
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
const OTHER_CHANNEL = 'Other videos';
const channelName = video => (video.channel || '').trim() || OTHER_CHANNEL;
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
function avatarNode(name, imageURL = '', large = false) {
  const avatar = element('span', 'avatar' + (large ? ' avatar-large' : ''));
  const url = safeImageURL(imageURL);
  if (url) { const img = element('img'); img.src = url; img.alt = ''; img.loading = 'lazy'; avatar.append(img); }
  else avatar.textContent = name === OTHER_CHANNEL ? '•' : (name || '?').slice(0, 1).toUpperCase();
  avatar.style?.setProperty?.('--hue', String(channelHue(name || '?')));
  return avatar;
}
function thumbnailFor(video) { return youtubeThumb(video.youtubeID); }
// Thumbnail with duration badge and a watched-progress bar; tapping it plays.
function videoThumb(video, onPlay, {image = thumbnailFor(video), duration = formatDuration(video.duration),
  fraction = isWatched(video) ? 1 : watchFraction(video), badge = ''} = {}) {
  const thumb = element(onPlay ? 'button' : 'div', 'thumb');
  if (onPlay) { thumb.type = 'button'; thumb.setAttribute('aria-label', `Play ${video.title}`); thumb.onclick = onPlay; }
  const url = safeImageURL(image);
  if (url) { const img = element('img'); img.src = url; img.alt = ''; img.loading = 'lazy'; thumb.append(img); }
  else thumb.append(element('span', 'thumb-placeholder', '▶'));
  if (duration) thumb.append(element('span', 'duration-badge', duration));
  if (badge) thumb.append(element('span', 'state-badge' + (badge === 'In library' ? ' ready' : ''), badge));
  if (fraction > 0) {
    const bar = element('span', 'watch-progress'); const fill = element('i');
    fill.style.width = `${Math.max(4, Math.round(Math.min(1, fraction) * 100))}%`; bar.append(fill); thumb.append(bar);
  }
  return thumb;
}
function videoAction(video, preparingID) {
  if (video.state === 'ready') {
    const resume = savedResume(video);
    return {label:resume ? `Resume · ${formatTime(resume)}` : (isWatched(video) ? 'Watch again' : 'Play'), run:() => play(video), primary:true};
  }
  if (video.state === 'failed' || video.state === 'paused') return {label:'Retry', run:() => retryVideo(video.id), primary:true, remove:() => removeVideo(video.id)};
  const active = video.id?.toLowerCase() === preparingID?.toLowerCase();
  return {label:active ? 'Cancel' : 'Remove', run:() => removeVideo(video.id)};
}
function videoStatus(video) {
  if (video.state === 'ready') return '';
  if (video.state === 'preparing') return video.message || 'Preparing…';
  return video.message || video.state;
}
// Action button(s) for a library item. Network actions disable themselves
// until they finish so a second tap on a bumpy road cannot fire twice.
function actionButtons(action, extraClass = 'card-action') {
  const make = (label, run, primary) => {
    const button = element('button', [extraClass, primary ? '' : 'quiet'].filter(Boolean).join(' '), label);
    button.type = 'button';
    button.onclick = async () => {
      if (/^(Play|Resume|Watch)/.test(label)) { run(); return; }
      button.disabled = true;
      const ok = await run();
      if (ok === false) button.disabled = false;
    };
    return button;
  };
  const buttons = [make(action.label, action.run, action.primary)];
  if (action.remove) buttons.push(make('Remove', action.remove, false));
  return buttons;
}
function channelButton(name, spec) {
  const button = element('button', 'channel-link', name); button.type = 'button';
  button.title = `Open ${name}`;
  button.onclick = event => { event?.stopPropagation?.(); openChannel({name, ...spec}); };
  return button;
}
// Channel lookup for a library item: the stored ID, else the channel of one
// of its videos (exact), else a name search.
function librarySpec(video) {
  if (video.channelId) return {id:video.channelId};
  if (video.youtubeID) return {video:video.youtubeID};
  return {};
}
function upgradeButton(videos) {
  const upgradable = videos.filter(isUpgradable);
  if (!upgradable.length) return null;
  const button = element('button', 'button quiet small', `Upgrade ${upgradable.length} to ${qualitySetting}`); button.type = 'button';
  button.title = 'Download again at the current quality. The current copy keeps playing until the new one is ready.';
  button.onclick = async () => {
    button.disabled = true;
    const ok = upgradable.length === (lastLibrary?.videos || []).filter(isUpgradable).length
      ? await upgradeVideos({all:true}) : await upgradeEach(upgradable);
    if (!ok) button.disabled = false;
  };
  return button;
}
function videoCard(video, preparingID, showChannel = true, number = 0) {
  const node = element('article', 'card video-card' + (isWatched(video) ? ' is-watched' : ''));
  node.append(videoThumb(video, video.state === 'ready' ? () => play(video) : null,
    {badge:video.state === 'ready' ? '' : (video.state === 'preparing' ? 'Preparing' : 'Needs retry')}));
  const body = element('div', 'card-body');
  body.append(element('h3', '', number ? `#${number} · ${video.title}` : video.title));
  const meta = element('div', 'card-meta');
  if (showChannel && video.channel) meta.append(channelButton(video.channel, librarySpec(video)));
  const resume = savedResume(video);
  const details = videoStatus(video) || [formatRelease(video),
    isWatched(video) ? 'Watched' : (resume ? `${Math.round(watchFraction(video) * 100)}% watched` : '')].filter(Boolean).join(' · ');
  if (details) meta.append(element('span', '', details));
  body.append(meta);
  const row = element('div', 'card-actions'); row.append(...actionButtons(videoAction(video, preparingID)));
  body.append(row);
  node.append(body);
  return node;
}
// Library "Channels" view: one tile per channel; tapping opens the channel
// page (library episodes + all recent uploads from YouTube).
function channelTile(name, videos) {
  const tile = element('button', 'channel-tile'); tile.type = 'button';
  const head = element('span', 'channel-tile-head');
  head.append(avatarNode(name));
  const text = element('span', 'channel-tile-text');
  text.append(element('strong', '', name));
  const latest = sortLibrary(videos, 'newest')[0];
  const ready = videos.filter(video => video.state === 'ready');
  const unwatched = ready.filter(video => !isWatched(video)).length;
  text.append(element('small', '', [`${videos.length} video${videos.length === 1 ? '' : 's'}`,
    unwatched && unwatched < ready.length ? `${unwatched} unwatched` : '',
    formatRelease(latest) ? `latest ${formatRelease(latest)}` : ''].filter(Boolean).join(' · ')));
  head.append(text); tile.append(head);
  const strip = element('span', 'channel-tile-strip');
  for (const video of sortLibrary(videos, 'newest').slice(0, 3)) {
    const cell = element('span'); const url = thumbnailFor(video);
    if (url) { const img = element('img'); img.src = url; img.alt = ''; img.loading = 'lazy'; cell.append(img); }
    strip.append(cell);
  }
  tile.append(strip);
  const withID = videos.find(video => video.channelId);
  const withVideo = sortLibrary(videos, 'newest').find(video => video.youtubeID);
  tile.onclick = () => openChannel({name, ...(name === OTHER_CHANNEL ? {libraryOnly:true}
    : withID ? {id:withID.channelId} : withVideo ? {video:withVideo.youtubeID} : {})});
  return tile;
}
function renderContinue(videos) {
  const items = videos.filter(video => video.state === 'ready' && !isWatched(video) && savedResume(video) >= 10)
    .sort((a, b) => Number(prefs.get('video-pilot-resume-at:' + b.id, 0)) - Number(prefs.get('video-pilot-resume-at:' + a.id, 0)))
    .slice(0, 10);
  $('continue-panel').hidden = !items.length || Boolean(libraryFilter);
  $('continue-list').replaceChildren(...items.map(video => {
    const tile = element('article', 'card');
    tile.append(videoThumb(video, () => play(video)));
    const body = element('div', 'card-body');
    body.append(element('h3', '', video.title));
    body.append(element('p', 'card-note', [video.channel, `${formatTime(savedResume(video))} of ${formatDuration(video.duration) || '—'}`].filter(Boolean).join(' · ')));
    tile.append(body);
    return tile;
  }));
}
function groupByChannel(videos) {
  const groups = new Map();
  for (const video of videos) {
    const name = channelName(video);
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(video);
  }
  return groups;
}
function renderLibrary(videos, preparingID) {
  lastLibrary = {videos, preparingID};
  if (currentTab !== 'library-tab' && librarySignature) return;
  const signature = JSON.stringify([videos.map(video => [video.id, video.state, video.title, video.message, video.channel,
    video.publishedAt, video.duration, video.height, savedResume(video), isWatched(video)]), preparingID, librarySort, libraryView,
    channelOrder, libraryFilter, qualitySetting, dataSaver()]);
  if (signature === librarySignature) return;
  librarySignature = signature;
  if ($('library-sort').value !== librarySort) $('library-sort').value = librarySort;
  $('library-sort-wrap').hidden = libraryView !== 'all' || Boolean(libraryFilter);
  for (const view of LIBRARY_VIEWS) $(`view-${view}`).setAttribute?.('aria-selected', view === libraryView ? 'true' : 'false');
  const groups = groupByChannel(videos);
  $('library-count').textContent = videos.length
    ? `${videos.length} video${videos.length === 1 ? '' : 's'} · ${groups.size} channel${groups.size === 1 ? '' : 's'}` : '';
  renderContinue(videos);
  const upgrade = upgradeButton(videos);
  $('library-upgrade').replaceChildren(...(upgrade ? [upgrade] : []));
  const query = libraryFilter.toLowerCase();
  const filtered = query ? videos.filter(video => `${video.title} ${video.channel || ''}`.toLowerCase().includes(query)) : videos;
  const library = $('library'); library.replaceChildren();
  library.className = libraryView === 'channels' && !query ? 'channel-grid' : 'video-grid';
  if (!videos.length) { library.append(messageCard('Your library is empty', 'Search on Home and tap Add to library. Videos you add download to the iPhone and play here.', {label:'Go to Home', run:() => goTo('home-tab')})); return; }
  if (!filtered.length) { library.append(messageCard('No matches', `Nothing in your library matches “${libraryFilter}”.`)); return; }
  if (libraryView === 'all' || query) {
    let group = null;
    const mode = query ? 'newest' : librarySort;
    for (const video of sortLibrary(filtered, mode)) {
      if (mode === 'channel' && channelName(video) !== group) {
        group = channelName(video); library.append(element('h3', 'library-group', group));
      }
      library.append(videoCard(video, preparingID, mode !== 'channel'));
    }
    return;
  }
  const names = [...groups.keys()].sort((a, b) => (a === OTHER_CHANNEL) - (b === OTHER_CHANNEL)
    || a.localeCompare(b, undefined, {sensitivity:'base'}));
  for (const name of names) library.append(channelTile(name, groups.get(name)));
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

// ---- Channel page ----
const channelState = {spec:null, channel:null, videos:[], continuation:null, loading:false, seq:0, returnTo:null, librarySignature:''};
function channelParams(spec, refresh = false) {
  const params = new URLSearchParams();
  if (spec.id) params.set('id', spec.id);
  else if (spec.video) params.set('video', spec.video);
  else if (spec.name) params.set('name', spec.name);
  else return null;
  if (refresh) params.set('refresh', '1');
  return params;
}
function channelLibraryVideos() {
  const videos = lastLibrary?.videos || [];
  const spec = channelState.spec, channel = channelState.channel;
  if (!spec) return [];
  const names = new Set([spec.name, channel?.name].filter(Boolean).map(name => name.trim().toLowerCase()));
  return videos.filter(video => {
    if (spec.libraryOnly) return !(video.channel || '').trim();
    if (channel?.id && video.channelId) return video.channelId === channel.id;
    if (spec.id && video.channelId) return video.channelId === spec.id;
    return names.has(channelName(video).toLowerCase());
  });
}
function renderChannelLibrary(force = false) {
  if (!channelState.spec) return;
  const videos = channelLibraryVideos();
  const preparingID = lastLibrary?.preparingID;
  const signature = JSON.stringify([videos.map(video => [video.id, video.state, video.message, savedResume(video), isWatched(video)]), channelOrder, preparingID]);
  if (!force && signature === channelState.librarySignature) return;
  channelState.librarySignature = signature;
  $('channel-library').hidden = !videos.length;
  $('channel-library-title').textContent = `In your library · ${videos.length}`;
  // "Sequential" order: oldest release first, numbered like episodes.
  const sequence = sortLibrary(videos, 'oldest');
  const numbered = new Map(sequence.map((video, index) => [video.id, index + 1]));
  const shown = channelOrder === 'newest' ? [...sequence].reverse() : sequence;
  const tools = [];
  const upgrade = upgradeButton(videos);
  if (upgrade) tools.push(upgrade);
  const next = sequence.find(video => video.state === 'ready' && !isWatched(video));
  if (next) {
    const playNext = element('button', 'play-next', `${savedResume(next) ? 'Resume' : 'Play'} #${numbered.get(next.id)}`);
    playNext.type = 'button'; playNext.title = next.title; playNext.onclick = () => play(next); tools.push(playNext);
  }
  const order = element('button', 'button quiet small', channelOrder === 'oldest' ? 'Oldest first' : 'Newest first');
  order.type = 'button';
  order.onclick = () => { channelOrder = channelOrder === 'oldest' ? 'newest' : 'oldest'; prefs.set('vp-channel-order', channelOrder); renderChannelLibrary(true); };
  tools.push(order);
  $('channel-library-tools').replaceChildren(...tools);
  $('channel-library-list').replaceChildren(...shown.map(video => videoCard(video, preparingID, false, numbered.get(video.id))));
}
function renderChannelHeader() {
  const spec = channelState.spec || {}, channel = channelState.channel;
  const name = channel?.name || spec.name || 'Channel';
  $('channel-name').textContent = name;
  $('channel-meta').textContent = [channel?.handle, channel?.subscribers].filter(Boolean).join(' · ');
  const avatar = avatarNode(name, channel?.avatar, true);
  avatar.id = 'channel-avatar';
  $('channel-avatar').replaceWith?.(avatar);
}
function openChannel(spec) {
  if (!spec) return;
  if (currentTab !== 'channel-tab') channelState.returnTo = {tab:currentTab, y:globalThis.scrollY || 0};
  const seq = ++channelState.seq;
  Object.assign(channelState, {spec, channel:null, videos:[], continuation:null, loading:false, librarySignature:''});
  hideSuggestions();
  const back = channelState.returnTo?.tab;
  $('channel-back-label').textContent = back === 'library-tab' ? 'Library' : (back === 'home-tab' && searchState.query ? 'Search' : 'Back');
  renderChannelHeader();
  $('channel-videos').replaceChildren();
  $('channel-more').hidden = true;
  showTab('channel-tab'); window.scrollTo?.({top:0});
  renderChannelLibrary(true);
  void loadChannel(seq);
}
async function loadChannel(seq, {append = false, refresh = false} = {}) {
  const spec = channelState.spec;
  const params = append ? new URLSearchParams({continuation:channelState.continuation || ''}) : channelParams(spec, refresh);
  if (!params || spec.libraryOnly) {
    $('channel-status').textContent = spec.libraryOnly ? 'Imported and unlabelled videos.' : 'This channel cannot be looked up.';
    return;
  }
  channelState.loading = true;
  $('channel-more').disabled = true; $('channel-more').textContent = 'Loading…';
  if (!append) {
    $('channel-status').textContent = 'Loading uploads…';
    $('channel-videos').replaceChildren(...Array.from({length:8}, () => element('div', 'card skeleton')));
  }
  try {
    const page = await api('/api/channel?' + params.toString(), null, 30000);
    if (seq !== channelState.seq) return;
    if (page.channel) { channelState.channel = page.channel; renderChannelHeader(); renderChannelLibrary(true); }
    const known = new Set(channelState.videos.map(video => video.id));
    const fresh = (Array.isArray(page.videos) ? page.videos : []).filter(video => video?.id && !known.has(video.id));
    channelState.videos.push(...fresh);
    channelState.continuation = page.continuation || null;
    if (!append) $('channel-videos').replaceChildren();
    const name = channelState.channel?.name || spec.name;
    $('channel-videos').append(...fresh.map(video => youtubeCard({channel:name, ...video}, {showChannel:false})));
    $('channel-status').textContent = channelState.videos.length ? `${channelState.videos.length} newest` : 'No uploads found.';
  } catch (error) {
    if (seq !== channelState.seq) return;
    if (!append) $('channel-videos').replaceChildren(messageCard('Could not load this channel', error.message,
      {label:'Try again', run:() => void loadChannel(channelState.seq, {refresh:true})}));
    $('channel-status').textContent = '';
  } finally {
    if (seq === channelState.seq) {
      channelState.loading = false;
      $('channel-more').hidden = !channelState.continuation;
      $('channel-more').disabled = false; $('channel-more').textContent = 'Load older videos';
    }
  }
}
$('channel-more').onclick = () => { if (!channelState.loading && channelState.continuation) void loadChannel(channelState.seq, {append:true}); };
$('channel-refresh').onclick = () => {
  if (!channelState.spec) return;
  const seq = ++channelState.seq; channelState.videos = []; channelState.continuation = null;
  void loadChannel(seq, {refresh:true});
};
$('channel-back').onclick = () => {
  const back = channelState.returnTo || {tab:'home-tab', y:0};
  channelState.returnTo = null; channelState.seq++;
  showTab(back.tab); globalThis.scrollTo?.(0, back.y);
};

// ---- Queue / downloads ----
let queueSignature = '';
let refreshQueued = false, refreshError = '';
let queueApi = null; // null = untested, false = phone has no /api/queue
let queueItems = null;
const QUEUE_STAGES = {queued:'Waiting', downloading:'Downloading', transcoding:'Preparing for playback', ready:'Ready', failed:'Failed', paused:'Paused'};
function formatBytesPerSecond(value) {
  const bps = Number(value);
  if (!Number.isFinite(bps) || bps <= 0) return '';
  return bps >= 1e6 ? `${(bps / 1e6).toFixed(1)} MB/s` : `${Math.round(bps / 1e3)} KB/s`;
}
function formatEta(value) {
  const seconds = Math.ceil(Number(value));
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  return seconds < 60 ? `${seconds}s left` : `${Math.ceil(seconds / 60)} min left`;
}
// Normalise the queue: the phone's /api/queue when available, otherwise the
// library's preparing items in the order the phone prepares them.
function queueEntries(videos, activeID = '') {
  if (Array.isArray(queueItems)) return queueItems.filter(item => item && item.stage !== 'ready' && item.stage !== 'failed').map(item => ({
    id:item.id, title:item.title || 'Video', youtubeID:item.videoId, thumbnail:item.thumbnail,
    active:item.stage === 'downloading' || item.stage === 'transcoding',
    progress:Number.isFinite(Number(item.progress)) ? Number(item.progress) : null,
    detail:[QUEUE_STAGES[item.stage] || item.stage, item.quality, item.upgrade ? 'upgrade' : '',
      formatBytesPerSecond(item.speedBps), formatEta(item.etaSec)].filter(Boolean).join(' · '), api:true}));
  const isActive = video => video.id?.toLowerCase() === activeID?.toLowerCase();
  return videos.filter(video => video.state === 'preparing')
    .sort((a, b) => isActive(b) - isActive(a) || (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0))
    .map(video => ({id:video.id, title:video.title, youtubeID:video.youtubeID, active:isActive(video), progress:null,
      detail:video.message || (isActive(video) ? 'Preparing now' : 'Waiting'), api:false}));
}
function queueRow(entry, index) {
  const row = element('div', 'queue-item' + (entry.active ? ' active' : ''));
  row.append(element('span', 'queue-number', String(index + 1)));
  row.append(videoThumb({title:entry.title}, null, {image:entry.thumbnail || youtubeThumb(entry.youtubeID), duration:'', fraction:0}));
  const text = element('div', 'queue-text');
  text.append(element('strong', '', entry.title));
  if (entry.active && lastStatus?.busy && !entry.api) {
    const fraction = Number(lastStatus.preparationProgress);
    if (Number.isFinite(fraction)) entry.progress = fraction;
  }
  if (entry.progress !== null && (entry.active || entry.progress > 0)) { const bar = element('progress'); bar.max = 1; bar.value = Math.max(0, Math.min(1, entry.progress)); text.append(bar); }
  text.append(element('small', '', entry.detail));
  row.append(text);
  const actions = element('div', 'queue-actions');
  if (entry.api && index > 0 && !entry.active) {
    const top = element('button', 'button quiet small', 'Move to top'); top.type = 'button';
    top.onclick = async () => { top.disabled = true; await queueCommand('/api/queue/move', {id:entry.id, to:0}); };
    actions.append(top);
  }
  const cancel = element('button', 'button quiet small', entry.active ? 'Cancel' : 'Remove'); cancel.type = 'button';
  cancel.onclick = async () => {
    cancel.disabled = true;
    const ok = entry.api ? await queueCommand('/api/queue/cancel', {id:entry.id}) : await removeVideo(entry.id);
    if (ok === false) cancel.disabled = false;
  };
  actions.append(cancel); row.append(actions);
  return row;
}
async function queueCommand(path, body) {
  try { await api(path, body); await refreshQueueApi(); await refresh(true); return true; }
  catch (error) { notice(error.message); return false; }
}
async function refreshQueueApi() {
  if (queueApi === false) return;
  try {
    const result = await api('/api/queue');
    queueApi = true; queueItems = Array.isArray(result?.items) ? result.items : [];
  } catch (error) {
    if (error.status === 404) { queueApi = false; queueItems = null; }
  }
  queueSignature = '';
  if (lastLibrary) renderQueue(lastLibrary.videos, lastLibrary.preparingID);
}
function renderQueue(videos, activeID = '') {
  const entries = queueEntries(videos, activeID);
  const failed = videos.filter(video => video.state === 'failed' || video.state === 'paused');
  const count = entries.length;
  $('nav-queue-badge').hidden = !count; $('nav-queue-badge').textContent = String(count);
  $('queue-badge').textContent = `${count} queued`;
  const signature = JSON.stringify([entries, failed.map(video => [video.id, video.state, video.message]),
    lastStatus?.busy ? Math.floor((Number(lastStatus.preparationProgress) || 0) * 100) : -1]);
  if (signature === queueSignature) return;
  queueSignature = signature;
  $('queue-summary').textContent = count ? `${count} video${count === 1 ? '' : 's'} downloading or waiting` : 'Nothing downloading right now.';
  $('queue-list').replaceChildren(...(count ? entries.map(queueRow)
    : [messageCard('All caught up', 'Videos you add are downloaded and converted on the iPhone, then appear in your library.')]));
  $('failed-panel').hidden = !failed.length;
  $('failed-list').replaceChildren(...failed.map((video, index) => {
    const row = queueRow({id:video.id, title:video.title, youtubeID:video.youtubeID, active:false, progress:null,
      detail:video.message || (video.state === 'paused' ? 'Paused' : 'Failed'), api:false}, index);
    const retry = element('button', 'button small', 'Retry'); retry.type = 'button';
    retry.onclick = async () => { retry.disabled = true; if (!await retryVideo(video.id)) retry.disabled = false; };
    row.lastChild.prepend(retry);
    return row;
  }));
}
$('retry-all').onclick = () => void retryAll();
async function retryAll() {
  const failed = (lastLibrary?.videos || []).filter(video => video.state === 'failed' || video.state === 'paused');
  for (const video of failed) { try { await api('/api/library/retry', {id:video.id}); } catch {} }
  if (failed.length) toast(`Retrying ${failed.length} video${failed.length === 1 ? '' : 's'}.`);
  await refresh(true);
  return failed.length;
}

// ---- Polling ----
async function refresh(force = false) {
  // A user action must see its own change, so queue one more pass instead of
  // dropping the request when the poll is already in flight.
  if (refreshing) { if (force) refreshQueued = true; return; }
  refreshing = true; lastPollAt = Date.now();
  try {
    const statusStarted = globalThis.performance?.now?.() ?? Date.now();
    const status = await api('/api/status');
    reportDiagnostic('browserRTT', {elapsedMs:Math.round((globalThis.performance?.now?.() ?? Date.now()) - statusStarted)});
    // The library list is the largest poll. When the phone exposes a
    // revision, refetch it only when that changes (or every 30 s, or after
    // a user action); older phones without one are polled every time.
    let videos = lastLibrary?.videos;
    if (libraryNeedsFetch(status, force)) {
      videos = await api('/api/library');
      lastLibraryFetch = {revision:status.libraryRevision, at:Date.now()};
    }
    lastStatus = status;
    if ($('host-ui').hidden) {
      $('host-ui').hidden = false; $('connecting-panel').hidden = true;
      showTab(NAV_TABS.includes(prefs.get('vp-tab')) ? prefs.get('vp-tab') : 'home-tab');
      void loadServerSettings();
    }
    setConnection(status.tunnel === 'connected' || !status.tunnel ? 'online' : 'waiting',
      status.tunnel === 'connected' || !status.tunnel ? 'Connected' : String(status.tunnel));
    if (refreshError && $('notice').textContent === refreshError) notice('');
    refreshError = '';
    if (!searchChromeReady) { searchChromeReady = true; setSearchChrome(); }
    // While a video plays, rebuilding hidden DOM every poll competes with the
    // decoder on the main thread; render once the player closes.
    if ($('player-section').hidden) {
      renderLibrary(videos, status.preparingID);
      updateResultButtons();
      renderQueue(videos, status.preparingID);
      if (currentTab === 'channel-tab') renderChannelLibrary();
      if (currentTab === 'settings-tab') renderSettings();
      if (currentTab === 'queue-tab' && queueApi) void refreshQueueApi();
    } else lastLibrary = {videos, preparingID:status.preparingID};
    updatePreparation(status, videos);
  } catch (error) {
    setConnection('offline', 'Offline');
    refreshError = error.message || 'Open Video Pilot on the iPhone and start hosting.';
    notice(refreshError);
  } finally {
    refreshing = false;
    if (refreshQueued) { refreshQueued = false; void refresh(true); }
  }
}
let lastLibraryFetch = {revision:undefined, at:0};
function libraryNeedsFetch(status, force = false) {
  if (force || !lastLibrary || status?.libraryRevision === undefined || status.libraryRevision === null) return true;
  return status.libraryRevision !== lastLibraryFetch.revision || Date.now() - lastLibraryFetch.at > 30000;
}
function setConnection(state, text) {
  const node = $('connection');
  if (node.dataset) node.dataset.state = state;
  $('connection-text').textContent = text;
}
function updatePreparation(status, videos) {
  $('preparation-panel').hidden = !status.busy || currentTab === 'settings-tab' || currentTab === 'queue-tab';
  if (!status.busy) return;
  const titles = {resolving:'Finding your video', importing:'Importing video', downloading:'Downloading',
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
  let detail = 'It appears in your library when it is ready.';
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
async function queueVideo(url, extra = {}) {
  try {
    const body = {url};
    if (extra.channelId) body.channelId = extra.channelId;
    if (extra.channel) body.channel = extra.channel;
    await api('/api/youtube', body); notice('');
    toast('Added. Your iPhone is downloading it; it appears in the library when ready.');
    await refresh(true); return true;
  } catch (error) { notice(error.message); return false; }
}
async function removeVideo(id) {
  try {
    const result = await api('/api/library/remove', {id});
    toast(result.pending ? 'Cancelling and removing video…' : 'Video removed.');
    await refresh(true); return true;
  } catch (error) { notice(error.message); return false; }
}
async function retryVideo(id) {
  try {
    await api('/api/library/retry', {id}); notice('');
    toast('Retrying on your iPhone.');
    await refresh(true); return true;
  } catch (error) { notice(error.message); return false; }
}

// ---- Quality (phone /api/settings; hidden when the phone lacks it) ----
let qualitySetting = null;
const qualityHeight = quality => Number(String(quality || '').replace(/\D/g, '')) || 0;
function isUpgradable(video) {
  if (!qualitySetting || video.youtubeID == null) return false;
  const target = qualityHeight(qualitySetting);
  const height = Number(video.height) || qualityHeight(video.quality);
  return target > 0 && height < target;
}
async function loadServerSettings() {
  try {
    const settings = await api('/api/settings');
    qualitySetting = typeof settings?.quality === 'string' ? settings.quality : null;
  } catch { qualitySetting = null; }
  $('quality-setting').hidden = !qualitySetting;
  syncChoice('data-quality', qualitySetting);
  rerenderLibrary();
}
async function upgradeEach(videos) {
  let queued = 0;
  for (const video of videos) { try { const result = await api('/api/library/upgrade', {id:video.id}); queued += Number(result?.queued) || 0; } catch {} }
  toast(`Upgrading ${queued} video${queued === 1 ? '' : 's'}. The current copy keeps playing until the new one is ready.`);
  await refresh(true);
  return queued > 0;
}
async function upgradeVideos(body) {
  try {
    const result = await api('/api/library/upgrade', body);
    toast(`Upgrading ${Number(result?.queued) || 0} video${Number(result?.queued) === 1 ? '' : 's'}. The current copy keeps playing until the new one is ready.`);
    await refresh(true); return true;
  } catch (error) { notice(error.message); return false; }
}

// ---- YouTube video cards (search, feed, channel pages) ----
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
function libraryItem(id) { return lastLibrary?.videos.find(video => video.id?.toLowerCase() === String(id || '').toLowerCase()) || null; }
// Play a library item, starting from the phone's remembered position when
// this browser has none of its own (e.g. watched from another browser).
function playFromLibrary(entry, phonePosition) {
  const position = Number(phonePosition);
  if (!savedResume(entry) && Number.isFinite(position) && position >= 10 && resumeEnabled()) play(entry, position);
  else play(entry);
}
// Search, feed and channel cards can show the same video; every button for
// an ID follows the library state for that ID.
const addingFromSearch = new Set();
const cardContext = new Map();
function styleResultButton(button, id) {
  const entry = libraryEntry(id);
  if (entry) queuedFromSearch.delete(id);
  const context = cardContext.get(id) || {};
  button.disabled = false; button.className = 'card-action'; button.onclick = null;
  if (addingFromSearch.has(id)) { button.textContent = 'Adding…'; button.className = 'card-action quiet'; button.disabled = true; return; }
  if (entry?.state === 'ready') {
    const resume = savedResume(entry) || (Number(context.position) >= 10 ? Number(context.position) : 0);
    button.textContent = resume ? `Resume · ${formatTime(resume)}` : (isWatched(entry) ? 'Watch again' : 'Play');
    button.onclick = () => playFromLibrary(entry, context.position); return;
  }
  if (entry?.state === 'preparing') { button.textContent = 'Downloading to iPhone…'; button.className = 'card-action quiet'; button.disabled = true; return; }
  if (queuedFromSearch.has(id)) { button.textContent = 'Added ✓'; button.className = 'card-action quiet'; button.disabled = true; return; }
  if (entry && (entry.state === 'failed' || entry.state === 'paused')) {
    button.textContent = 'Retry download';
    button.onclick = async () => { addingFromSearch.add(id); updateResultButton(id); await retryVideo(entry.id); addingFromSearch.delete(id); updateResultButton(id); };
    return;
  }
  button.textContent = '+ Add to library'; button.className = 'card-action quiet';
  button.onclick = async () => {
    addingFromSearch.add(id); updateResultButton(id);
    const added = await queueVideo(id, context);
    addingFromSearch.delete(id);
    if (added) queuedFromSearch.add(id);
    updateResultButton(id);
  };
}
function updateResultButton(id) {
  const buttons = resultButtons.get(id);
  if (!buttons) return;
  for (const button of buttons) {
    if (button.isConnected === false) buttons.delete(button);
    else styleResultButton(button, id);
  }
  if (!buttons.size) resultButtons.delete(id);
}
function updateResultButtons() { for (const id of [...resultButtons.keys()]) updateResultButton(id); }
function feedThumbnail(video) {
  if (video.youtube === false) return '';
  // Phone-provided thumbnails are mqdefault; Data saver swaps in the 120 px one.
  return dataSaver() || !video.thumbnail ? youtubeThumb(video.id) : video.thumbnail;
}
// One card for any YouTube video object ({id,title,channel?,channelId?,
// thumbnail?,duration?,published?,views?,youtube?,libraryId?,progress?,position?}).
function youtubeCard(video, {showChannel = true, badge = true} = {}) {
  const node = element('article', 'card result-card');
  const local = video.youtube === false;
  const entry = local ? libraryItem(video.libraryId || video.id) : null;
  const progress = Number(video.progress);
  const fraction = Number.isFinite(progress) && progress > 0 ? progress : (entry ? watchFraction(entry) : 0);
  const button = element('button', 'card-action'); button.type = 'button';
  node.append(videoThumb({title:video.title}, () => { if (!button.disabled) button.click(); },
    {image:local ? '' : feedThumbnail(video), duration:typeof video.duration === 'string' ? video.duration : formatDuration(video.duration),
      fraction, badge:badge && !local && libraryEntry(video.id)?.state === 'ready' ? 'In library' : ''}));
  const body = element('div', 'card-body');
  body.append(element('h3', '', video.title || 'Video'));
  const meta = element('div', 'card-meta');
  if (showChannel && video.channel) meta.append(channelButton(video.channel, video.channelId ? {id:video.channelId} : (local ? {name:video.channel} : {video:video.id})));
  const extra = [video.views, video.published].filter(Boolean).join(' · ');
  if (extra) meta.append(element('span', '', extra));
  if (meta.childNodes?.length !== 0) body.append(meta);
  const actions = element('div', 'card-actions'); actions.append(button); body.append(actions);
  node.append(body);
  if (local) {
    if (entry?.state === 'ready') {
      const resume = savedResume(entry) || (Number(video.position) >= 10 ? Number(video.position) : 0);
      button.textContent = resume ? `Resume · ${formatTime(resume)}` : 'Play';
      button.onclick = () => playFromLibrary(entry, video.position);
    } else { button.textContent = entry ? 'Not ready yet' : 'Not in library'; button.className = 'card-action quiet'; button.disabled = true; }
    return node;
  }
  const known = cardContext.get(video.id) || {};
  cardContext.set(video.id, {channelId:video.channelId || known.channelId, channel:video.channel || known.channel,
    position:Number.isFinite(Number(video.position)) ? Number(video.position) : known.position});
  if (!resultButtons.has(video.id)) resultButtons.set(video.id, new Set());
  resultButtons.get(video.id).add(button); styleResultButton(button, video.id);
  return node;
}
// Kept for older call sites: search results use the same card.
function resultCard(video) { return youtubeCard(video); }

// ---- Home feed ("For you") ----
const feedState = {rows:null, loadedAt:0, loading:false, failed:false, seq:0};
const FEED_MAX_AGE = 10 * 60 * 1000;
// Normalise /api/foryou: drop empty rows and rows of unknown shape, cap row length.
function feedRows(result) {
  const rows = Array.isArray(result?.rows) ? result.rows : [];
  return rows.map(row => ({title:String(row?.title || ''), kind:String(row?.kind || ''), subtitle:row?.subtitle ? String(row.subtitle) : '',
    videos:(Array.isArray(row?.videos) ? row.videos : []).filter(video => video && video.id && video.title).slice(0, 30)}))
    .filter(row => row.title && row.videos.length);
}
function maybeLoadFeed() {
  if (!lastStatus) return;
  if (!feedState.rows || feedState.failed || Date.now() - feedState.loadedAt > FEED_MAX_AGE) void loadFeed();
}
async function loadFeed(refresh = false) {
  if (feedState.loading && !refresh) return;
  const seq = ++feedState.seq;
  feedState.loading = true;
  $('feed-status').textContent = refresh ? 'Refreshing…' : (feedState.rows ? '' : 'Loading your feed…');
  if (!feedState.rows) $('feed').replaceChildren(feedSkeleton());
  try {
    const result = await api('/api/foryou' + (refresh ? '?refresh=1' : ''), null, 30000);
    if (seq !== feedState.seq) return;
    let rows = feedRows(result);
    // A brand-new install has no history yet: fall back to Trending.
    if (!rows.length && lastStatus?.youtubeExplore && !lastStatus?.youtubeSignedIn) {
      try {
        const trending = await api('/api/explore', null, 20000);
        rows = feedRows({rows:[{title:'Trending now', kind:'trending', videos:Array.isArray(trending) ? trending : []}]});
      } catch {}
    }
    feedState.rows = rows; feedState.loadedAt = Date.now(); feedState.failed = false;
    renderFeed(rows, Array.isArray(result?.errors) ? result.errors.filter(item => typeof item === 'string') : []);
    $('feed-status').textContent = '';
  } catch (error) {
    if (seq !== feedState.seq) return;
    feedState.failed = true; feedState.loadedAt = Date.now();
    $('feed-status').textContent = '';
    if (!feedState.rows?.length) $('feed').replaceChildren(messageCard('Your feed did not load', error.message || 'Try again in a moment.',
      {label:'Try again', run:() => void loadFeed(true)}));
  } finally { if (seq === feedState.seq) feedState.loading = false; }
}
function feedSkeleton() {
  const section = element('section', 'row-section');
  const row = element('div', 'row-scroller');
  row.append(...Array.from({length:5}, () => element('div', 'card skeleton')));
  section.append(row);
  return section;
}
function renderFeed(rows, errors = []) {
  const nodes = rows.map(row => {
    const section = element('section', 'row-section');
    const header = element('div', 'section-header');
    header.append(element('h2', '', row.title));
    if (row.subtitle) header.append(element('span', 'subtitle', row.subtitle));
    section.append(header);
    const scroller = element('div', 'row-scroller');
    scroller.append(...row.videos.map(video => youtubeCard(video, {badge:row.kind !== 'continue'})));
    section.append(scroller);
    return section;
  });
  if (!nodes.length) {
    const empty = element('div', 'feed-empty');
    empty.append(element('strong', '', 'Your feed fills in as you watch'));
    empty.append(element('span', '', 'Search for something above. Videos you watch shape what shows up here: continue watching, more like what you watched, and new uploads from those channels.'));
    nodes.push(empty);
  }
  if (errors.length) nodes.push(element('p', 'muted small-text', errors.join(' ')));
  $('feed').replaceChildren(...nodes);
}
$('feed-refresh').onclick = () => void loadFeed(true);

// ---- Search ----
function setSearchChrome() {
  const hasQuery = Boolean($('query').value);
  $('query-clear').hidden = !hasQuery;
  const searching = Boolean(searchState.query);
  $('search-view').hidden = !searching;
  $('feed-view').hidden = searching;
  $('load-more').hidden = !searchState.continuation || !searchState.results.length;
  $('load-more').disabled = searchState.loading;
  $('load-more').textContent = searchState.loading ? 'Loading…' : 'Load more results';
  $('search-submit').disabled = searchState.loading && !searchState.results.length;
  const recent = recentSearches();
  $('recent-searches').hidden = !recent.length;
  $('recent-searches').replaceChildren(...(recent.length ? [element('span', 'chip-label', 'Recent'), ...recent.slice(0, 5).map(query => {
    const chip = element('button', 'chip', query); chip.type = 'button';
    chip.onclick = () => { $('query').value = query; void runSearch(query); };
    return chip;
  }), Object.assign(element('button', 'chip chip-clear', 'Clear'), {type:'button', onclick:() => { prefs.set(RECENT_KEY, '[]'); setSearchChrome(); }})] : []));
}
function clearSearch() {
  searchState.seq++;
  Object.assign(searchState, {query:'', continuation:null, results:[], loading:false});
  $('query').value = ''; $('results').replaceChildren(); hideSuggestions(); setSearchChrome();
  maybeLoadFeed();
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
  if (currentTab !== 'home-tab') showTab('home-tab');
  // A typed or pasted YouTube link adds that video. Send the clean ID: the
  // phone only accepts full https links, and drivers type 'youtu.be/…'.
  const linked = linkedVideoID(query);
  if (!append && linked && /youtu/i.test(query)) {
    if (await queueVideo(linked)) { $('query').value = ''; setSearchChrome(); }
    return;
  }
  const seq = ++searchState.seq;
  searchState.loading = true;
  if (!append) {
    Object.assign(searchState, {query, continuation:null, results:[]});
    rememberSearch(query);
    $('query').blur?.();
    $('results').replaceChildren(...Array.from({length:8}, () => element('div', 'card skeleton')));
    $('search-summary').textContent = `Searching for “${query}”…`;
    window.scrollTo?.({top:0});
  }
  setSearchChrome();
  try {
    const params = new URLSearchParams({q:searchState.query, filter:searchState.filter});
    if (append && searchState.continuation) params.set('continuation', searchState.continuation);
    const page = await api('/api/search?' + params.toString(), null, 20000);
    if (seq !== searchState.seq) return;
    const results = Array.isArray(page) ? page : (page.results || []);
    searchState.continuation = Array.isArray(page) ? null : (page.continuation || null);
    if (!append) notice('');
    const known = new Set(searchState.results.map(video => video.id));
    const fresh = results.filter(video => video?.id && !known.has(video.id));
    searchState.results.push(...fresh);
    if (!append) $('results').replaceChildren();
    $('results').append(...fresh.map(video => youtubeCard(video)));
    const filterLabel = document.querySelector?.(`[data-filter="${searchState.filter}"]`)?.textContent;
    $('search-summary').textContent = searchState.results.length
      ? `“${searchState.query}”${searchState.filter !== 'any' && filterLabel ? ` · ${filterLabel}` : ''}`
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
$('search-back').onclick = () => clearSearch();
$('query').oninput = () => {
  setSearchChrome();
  const value = $('query').value.trim();
  clearTimeout(suggestTimer);
  // A bare 11-character word could be an ID or a search ("GTA6Trailer");
  // offer the add as a suggestion and still allow a normal search.
  const linked = linkedVideoID(value);
  if (linked && /youtu/i.test(value)) { showSuggestions([{label:'Add this video to your library', value:linked, link:true}]); return; }
  if (value.length < 2) { hideSuggestions(); return; }
  const idSuggestion = linked ? [{label:'Add video ID ' + linked, value:linked, link:true}] : [];
  if (idSuggestion.length) showSuggestions(idSuggestion);
  const seq = ++suggestSeq;
  suggestTimer = setTimeout(async () => {
    try {
      const items = await api('/api/suggest?q=' + encodeURIComponent(value));
      if (seq === suggestSeq && $('query').value.trim() === value && Array.isArray(items)) {
        showSuggestions([...idSuggestion, ...items.filter(item => typeof item === 'string').slice(0, 7).map(item => ({label:item, value:item}))]);
      }
    } catch {}
  }, 220);
};
$('query').onkeydown = event => { if (event.key === 'Escape') hideSuggestions(); };
$('query').onblur = () => { clearTimeout(suggestHide); suggestHide = setTimeout(hideSuggestions, 150); };
$('query-clear').onclick = () => {
  if (searchState.query) { clearSearch(); return; }
  $('query').value = ''; hideSuggestions(); setSearchChrome(); $('query').focus?.();
};
$('load-more').onclick = () => { if (!searchState.loading) void runSearch(searchState.query, true); };
document.querySelectorAll?.('[data-filter]').forEach(button => button.onclick = () => {
  searchState.filter = SEARCH_FILTERS.includes(button.dataset.filter) ? button.dataset.filter : 'any';
  document.querySelectorAll?.('[data-filter]').forEach(other => other.setAttribute('aria-pressed', other === button ? 'true' : 'false'));
  if (searchState.query) void runSearch(searchState.query);
});
document.querySelectorAll?.('[data-query]').forEach(button => button.onclick = () => {
  $('query').value = button.dataset.query || ''; void runSearch($('query').value);
});
document.querySelectorAll?.('[data-tab]').forEach(button => button.onclick = () => goTo(button.dataset.tab));

// ---- Settings ----
function resumeEnabled() { return prefs.get('vp-pref-resume') !== 'off'; }
function fullscreenOnPlay() { return prefs.get('vp-pref-fullscreen') === 'on'; }
const BUFFER_PROFILES = {normal:[12, 6], large:[30, 15]};
function applyBufferProfile() {
  const [high, low] = BUFFER_PROFILES[prefs.get('vp-buffer')] || BUFFER_PROFILES.normal;
  try { if (JSMpegHttpSource) { JSMpegHttpSource.highWaterHeadroom = high; JSMpegHttpSource.lowWaterHeadroom = low; } } catch {}
}
applyBufferProfile();
function pollInterval() { return dataSaver() ? 5000 : 2000; }
function syncChoice(attribute, value) {
  document.querySelectorAll?.(`[${attribute}]`).forEach(button => button.setAttribute('aria-pressed', button.getAttribute(attribute) === value ? 'true' : 'false'));
}
function applyTextSize(size) {
  const root = document.documentElement;
  if (root?.dataset) root.dataset.textSize = size === 'large' ? 'large' : 'normal';
}
applyTextSize(prefs.get('vp-text-size'));
function setupSettings() {
  document.querySelectorAll?.('[data-theme-choice]').forEach(button => button.onclick = () => {
    themeChoice = button.dataset.themeChoice; prefs.set(themeKey, themeChoice); applyTheme(themeChoice); syncChoice('data-theme-choice', themeChoice);
  });
  document.querySelectorAll?.('[data-text-size]').forEach(button => button.onclick = () => {
    prefs.set('vp-text-size', button.dataset.textSize); applyTextSize(button.dataset.textSize); syncChoice('data-text-size', button.dataset.textSize);
  });
  document.querySelectorAll?.('[data-buffer]').forEach(button => button.onclick = () => {
    prefs.set('vp-buffer', button.dataset.buffer); applyBufferProfile(); syncChoice('data-buffer', button.dataset.buffer);
    toast('Applies from the next video or seek.');
  });
  document.querySelectorAll?.('[data-quality]').forEach(button => button.onclick = async () => {
    const quality = button.dataset.quality, previous = qualitySetting;
    syncChoice('data-quality', quality);
    try { await api('/api/settings', {quality}); qualitySetting = quality; toast(`New downloads use ${quality}.`); rerenderLibrary(); }
    catch (error) { syncChoice('data-quality', previous); notice(error.message); }
  });
  syncChoice('data-theme-choice', themeChoice);
  syncChoice('data-text-size', prefs.get('vp-text-size') === 'large' ? 'large' : 'normal');
  syncChoice('data-buffer', prefs.get('vp-buffer') === 'large' ? 'large' : 'normal');
  const toggle = (id, key, onValue, apply) => {
    const input = $(id); if (!input) return;
    input.checked = key === 'vp-pref-resume' ? resumeEnabled() : prefs.get(key) === onValue;
    input.onchange = () => { prefs.set(key, input.checked ? 'on' : 'off'); apply?.(input.checked); renderSettings(); };
  };
  toggle('pref-resume', 'vp-pref-resume', 'on');
  toggle('pref-fullscreen', 'vp-pref-fullscreen', 'on');
  toggle('pref-datasaver', 'vp-data-saver', 'on', () => { rerenderLibrary(); feedState.loadedAt = 0; });
  const boost = $('pref-boost');
  if (boost) { boost.checked = audioBoost; boost.onchange = () => { audioBoost = boost.checked; try { globalThis.localStorage?.setItem(audioBoostKey, audioBoost ? 'on' : 'off'); } catch {} applyAudioState(); }; }
  $('lib-retry-failed').onclick = async () => {
    const count = await retryAll();
    $('lib-action-status').textContent = count ? `Retrying ${count} video${count === 1 ? '' : 's'}.` : 'Nothing to retry.';
  };
  $('lib-remove-watched').onclick = async () => {
    const watched = (lastLibrary?.videos || []).filter(video => video.state === 'ready' && isWatched(video));
    if (!watched.length) { $('lib-action-status').textContent = 'No watched videos to remove.'; return; }
    if (globalThis.confirm && !globalThis.confirm(`Remove ${watched.length} watched video${watched.length === 1 ? '' : 's'} from the iPhone?`)) return;
    let removed = 0;
    for (const video of watched) { try { await api('/api/library/remove', {id:video.id}); removed++; } catch {} }
    $('lib-action-status').textContent = `Removed ${removed} watched video${removed === 1 ? '' : 's'}.`;
    await refresh(true);
  };
  $('lib-clear-history').onclick = async () => {
    if (globalThis.confirm && !globalThis.confirm('Clear watch history? Your feed starts over; videos stay in the library.')) return;
    try {
      await api('/api/history/clear', {});
      $('lib-action-status').textContent = 'Watch history cleared.';
      feedState.rows = null; feedState.loadedAt = 0;
    } catch (error) { $('lib-action-status').textContent = error.status === 404 ? 'This iPhone build has no watch history yet.' : error.message; }
  };
}
const mbps = value => { const n = Number(value); return Number.isFinite(n) ? `${n.toFixed(n >= 10 ? 0 : 1)} Mb/s` : '—'; };
function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return bytes ? `${Math.round(bytes / 1e3)} KB` : '0 KB';
}
// Library numbers for the Settings card (pure; tested).
function libraryStats(videos) {
  const list = Array.isArray(videos) ? videos : [];
  const seconds = list.reduce((sum, video) => sum + (video.state === 'ready' ? finiteDuration(video.duration) : 0), 0);
  return {total:list.length, ready:list.filter(video => video.state === 'ready').length,
    preparing:list.filter(video => video.state === 'preparing').length,
    failed:list.filter(video => video.state === 'failed' || video.state === 'paused').length,
    watched:list.filter(video => video.state === 'ready' && isWatched(video)).length,
    channels:new Set(list.map(channelName)).size, hours:seconds / 3600};
}
function renderSettings() {
  const status = lastStatus || {};
  const stats = libraryStats(lastLibrary?.videos);
  $('lib-total').textContent = String(stats.total); $('lib-ready').textContent = String(stats.ready);
  $('lib-channels').textContent = String(stats.channels); $('lib-hours').textContent = stats.hours >= 10 ? String(Math.round(stats.hours)) : stats.hours.toFixed(1);
  $('lib-preparing').textContent = String(stats.preparing); $('lib-failed').textContent = String(stats.failed); $('lib-watched').textContent = String(stats.watched);
  $('conn-tunnel').textContent = status.tunnel === 'connected' ? 'Connected' : (status.tunnel || '—');
  $('conn-down').textContent = mbps(status.downloadMbps); $('conn-up').textContent = mbps(status.uploadMbps);
  $('conn-streams').textContent = String(Number(status.activeStreams) || 0);
  $('settings-auth').textContent = status.authentication === 'faceID-on-start' ? 'Face ID per app session' : 'App authorization';
  $('settings-youtube').textContent = status.youtubeSignedIn ? 'Google connected' : 'Not signed in';
  $('settings-search').textContent = status.youtubeSearch ? 'Enabled' : 'Unavailable';
  const version = status.version ? `${status.version}${status.build ? ` (build ${status.build})` : ''}` : '—';
  $('settings-version').textContent = version;
  $('settings-version-line').textContent = status.version ? `Video Pilot ${version}` : 'Video Pilot';
  $('stat-poll').textContent = `every ${pollInterval() / 1000} s`;
  $('stat-thumbs').textContent = dataSaver() ? 'Small (120 px)' : 'Standard (320 px)';
  const prep = status.lastPreparation;
  $('diag-prep-download').textContent = prep ? [mbps(prep.downloadMbps), prep.downloadSeconds != null ? `${prep.downloadSeconds} s` : ''].filter(Boolean).join(' · ') : '—';
  $('diag-prep-processing').textContent = prep ? [prep.processingSpeed ? `${Number(prep.processingSpeed).toFixed(1)}× real time` : '', prep.processingSeconds != null ? `${prep.processingSeconds} s` : ''].filter(Boolean).join(' · ') || '—' : '—';
  $('diag-prep-hw').textContent = prep && prep.hardwareDecode != null ? (prep.hardwareDecode ? 'Yes' : 'No (software)') : '—';
  $('diag-prep-bitrate').textContent = prep?.outputKbps ? `${Math.round(prep.outputKbps)} kb/s${prep.quality ? ` · ${/^\d+$/.test(String(prep.quality)) ? `${prep.quality}p` : prep.quality}` : ''}` : '—';
}
function renderLiveDiagnostics() {
  // The stream reader's own numbers (http-source stats()) when a video is open.
  let source = null;
  try { source = player?.source?.stats?.() || null; } catch {}
  const headroom = Number(source?.headroomSeconds ?? player?.source?.headroom);
  const live = liveStats.snapshot(player && Number.isFinite(headroom) ? headroom : null);
  if (live.throughputMbps === null && Number(source?.kbps) > 0) live.throughputMbps = Number(source.kbps) / 1000;
  const setTile = (id, text, state = '') => { const node = $(id); node.textContent = text; if (node.classList) { node.classList.toggle('is-bad', state === 'bad'); node.classList.toggle('is-good', state === 'good'); } };
  setTile('diag-buffer', live.bufferSeconds === null ? '—' : `${live.bufferSeconds.toFixed(1)} s`,
    live.bufferSeconds === null ? '' : (live.bufferSeconds < 3 ? 'bad' : 'good'));
  setTile('diag-throughput', live.throughputMbps === null ? '—' : mbps(live.throughputMbps));
  setTile('diag-stalls', String(live.stalls), live.stalls ? 'bad' : '');
  setTile('diag-reconnects', String(live.reconnects), live.reconnects ? 'bad' : '');
  $('diag-received').textContent = source && Number(source.expectedBytes) > 0
    ? `${formatBytes(source.receivedBytes)} of ${formatBytes(source.expectedBytes)}`
    : (live.receivedBytes ? formatBytes(live.receivedBytes) : '—');
  $('diag-first-frame').textContent = live.firstFrameMs === null ? '—' : `${(live.firstFrameMs / 1000).toFixed(1)} s`;
  $('diag-api-errors').textContent = String(live.apiErrors);
  $('conn-rtt').textContent = live.rttMs === null ? '—' : `${Math.round(live.rttMs)} ms`;
}
function formatTime(value) {
  const seconds = Math.max(0, Math.floor(Number(value) || 0));
  if (seconds >= 3600) {
    return `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds % 3600 / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  }
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
  const preference = $('pref-boost');
  if (preference) preference.checked = audioBoost;
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
  const storedResume = seek === null && resumeEnabled() ? savedResume(video) : 0;
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
        reportHistory(video, session.position, true);
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
    document.body?.classList?.add?.('is-playing');
  } catch (error) { session.failed = true; $('playback-status').textContent = error.message; }
}
// Watch history on the phone drives Continue watching and the For you feed.
// Library items only (their id is the library UUID); sent every 15 s while
// playing and on pause, seek, close and end.
const LIBRARY_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HISTORY_INTERVAL_MS = 15000;
let lastHistoryAt = 0;
function historyPayload(video, position, finished = false, duration = 0) {
  if (!video || !LIBRARY_UUID.test(String(video.id || ''))) return null;
  const seconds = Math.max(0, Math.round((Number(position) || 0) * 10) / 10);
  if (!finished && seconds < 1) return null;
  const body = {id:video.id, position:seconds};
  const total = finiteDuration(duration) || finiteDuration(video.duration);
  if (total) body.duration = Math.round(total * 10) / 10;
  if (finished) body.finished = true;
  return body;
}
function reportHistory(video = current, position = currentOffset, finished = false) {
  const body = historyPayload(video, position, finished, playback?.duration);
  if (!body) return;
  lastHistoryAt = Date.now();
  api('/api/history', body).catch(() => {});
}
let playerReturn = null;
function play(video, seek = null) {
  if ($('player-section').hidden) playerReturn = {tab:currentTab, y:globalThis.scrollY || 0};
  invalidateSeeks();
  lastHistoryAt = Date.now();
  // Opening the first video can stay synchronous for a responsive button. A
  // replacement is serialized behind decoder teardown so an old read loop can
  // never write into the new decoder while a seek is in flight.
  if (!player && !playback) {
    liveStats.resetVideo();
    startPlayer(video, seek);
    if (fullscreenOnPlay()) void enterFullscreen();
    return;
  }
  const generation = seekGeneration;
  if (playback && !playback.ended && current && current !== video) reportHistory();
  liveStats.resetVideo();
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
    reportHistory();
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
  if (playback && !playback.ended) reportHistory();
  void closePlayer().then(() => {
    document.body?.classList?.remove?.('is-playing');
    const back = playerReturn || {tab:currentTab, y:0};
    playerReturn = null;
    if (back.tab !== currentTab) showTab(back.tab);
    globalThis.scrollTo?.(0, back.y);
    rerenderLibrary(); updateResultButtons(); queueSignature = '';
    if (lastLibrary) renderQueue(lastLibrary.videos, lastLibrary.preparingID);
    if (currentTab === 'channel-tab') renderChannelLibrary(true);
    // What was just watched reshapes Continue watching; refresh quietly.
    if (lastStatus && feedState.rows) setTimeout(() => { if (!feedState.loading) void loadFeed(); }, 1500);
  });
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
  if (Date.now() - lastHistoryAt > 3000) reportHistory(video, target);
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
  if (playback.decoded && Date.now() - lastHistoryAt >= HISTORY_INTERVAL_MS) reportHistory();
}, 500);
setupSettings();
reportDiagnostic('pageLoaded');
window.addEventListener('pagehide', () => { saveResume(); if (playback && !playback.ended) reportHistory(); invalidateSeeks(); reportDiagnostic('pageHidden'); reportDiagnostic('playerClosed'); void flushDiagnostics(true); void closePlayer(); });
let lastPollAt = 0;
void refresh();
// One 1 s heartbeat: polls the phone at the Data saver-dependent interval
// and keeps the Settings diagnostics live while that page is open.
setInterval(() => {
  if (Date.now() - lastPollAt >= pollInterval() - 50) void refresh();
  if (currentTab === 'settings-tab') renderLiveDiagnostics();
}, 1000);
