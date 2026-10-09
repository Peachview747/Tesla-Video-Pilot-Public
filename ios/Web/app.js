import {JSMpegHttpSource, installRecordedBufferWindow, installRecordedAudioOutput, installRecordedPlayerPause} from './http-source.js';
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
function applyTheme(theme) {
  const value = theme === 'dark' ? 'dark' : 'light';
  const root = document.documentElement;
  if (!root) return;
  root.dataset.theme = value;
  const toggle = $('theme-toggle');
  if (toggle) {
    toggle.textContent = value === 'dark' ? 'Light mode' : 'Dark mode';
    toggle.setAttribute('aria-pressed', value === 'dark' ? 'true' : 'false');
  }
  try { globalThis.localStorage?.setItem(themeKey, value); } catch {}
}
try { applyTheme(globalThis.localStorage?.getItem(themeKey) || 'light'); } catch { applyTheme('light'); }
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
  try { globalThis.localStorage?.setItem(resumeKey(video), String(Math.floor(offset))); } catch {}
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
    const library = $('library'); library.replaceChildren();
    if (!videos.length) library.append(card('Your library is empty', 'Prepare a YouTube video or import a file on the iPhone.'));
    for (const video of videos) {
      const active = video.id?.toLowerCase() === status.preparingID?.toLowerCase();
      const action = video.state === 'ready'
        ? {label:savedResume(video) ? 'Resume · ' + formatTime(savedResume(video)) : 'Play',run:() => play(video)}
        : {label:active ? 'Cancel and remove' : 'Remove',run:() => removeVideo(video.id)};
      library.append(card(video.title, video.message || video.state, action,
      video.youtubeID ? `https://i.ytimg.com/vi/${encodeURIComponent(video.youtubeID)}/mqdefault.jpg` : null));
    }
    renderQueue(videos, status.preparingID);
    updatePreparation(status, videos);
    const down = Number(status.downloadMbps) || 0, up = Number(status.uploadMbps) || 0;
    $('traffic-status').textContent = `Receiving ${down.toFixed(2)} Mb/s · Sending ${up.toFixed(2)} Mb/s`;
    $('search-form').hidden = !status.youtubeSearch;
    $('explore-panel').hidden = !status.youtubeExplore;
    $('explore-title').textContent = status.youtubeSignedIn ? 'From your subscriptions' : 'Trending now';
    $('search-hint').textContent = status.youtubeSearch
      ? (status.youtubeSignedIn ? 'Searching all of YouTube · your account feed is shown below.' : 'Searching all of YouTube with the host API key.')
      : 'Paste a video URL above. To enable search, add a YouTube Data API key in the iPhone app.';
    $('url-form').querySelector('button').disabled = false;
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
async function queueVideo(url) {
  try { await api('/api/youtube', {url}); notice('Preparing video on your iPhone. It will appear in the library when ready.'); await refresh(); }
  catch (error) { notice(error.message); }
}
async function removeVideo(id) {
  try { const result = await api('/api/library/remove', {id}); notice(result.pending ? 'Cancelling preparation and removing video…' : 'Video removed.'); await refresh(); }
  catch (error) { notice(error.message); }
}
$('url-form').onsubmit = event => { event.preventDefault(); void queueVideo($('url').value.trim()); };
$('search-form').onsubmit = async event => {
  event.preventDefault(); const button = event.currentTarget.querySelector('button'); button.disabled = true;
  try {
    const query = $('query').value.trim();
    const results = await api('/api/search?q=' + encodeURIComponent(query));
    $('results').replaceChildren(); notice(results.length ? '' : 'No videos found.');
    $('search-summary').hidden = !results.length;
    $('search-summary').textContent = results.length ? `${results.length} results for “${query}” · Add one to the queue or refine your search.` : '';
    for (const video of results) $('results').append(card(video.title, video.channel, {label:'Prepare video',run:() => queueVideo(video.id)}, video.thumbnail));
  } catch (error) { notice(error.message); } finally { button.disabled = false; }
};
document.querySelectorAll?.('[data-query]').forEach(button => button.onclick = () => {
  $('query').value = button.dataset.query || '';
  $('search-form').requestSubmit?.();
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
  installRecordedPlayerPause(player);
  reportDiagnostic('decoderBuffersBound', {
    videoBufferBytes:Number(player?.video?.bits?.bytes?.length) || 0,
    audioBufferBytes:Number(player?.audio?.bits?.bytes?.length) || 0
  });
}
function startPlayer(video, seek = null, recoveryAttempt = 0) {
  current = video;
  const duration = finiteDuration(video.duration);
  const storedResume = seek === null ? savedResume(video) : 0;
  currentOffset = Math.max(0, Number(seek ?? storedResume) || 0);
  if (duration) currentOffset = Math.min(currentOffset, duration);
  if (storedResume > 0) reportDiagnostic('resumeLoaded', {positionSeconds:currentOffset});
  reportDiagnostic('playerStart', {seekTargetSeconds:currentOffset, recoveryAttempt});
  const session = {paused:false, failed:false, ended:false, baseOffset:currentOffset,
    position:currentOffset, duration, decoded:false, startupTimer:null, stallTimer:null,
    lastDecodedAt:0, recoveryAttempt}; playback = session;
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
          reportDiagnostic('playerStalled', {positionSeconds:session.position || 0});
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
    if (playback) playback.paused = true;
    player.pause(); player.source?.pauseReading(); $('pause').textContent = 'Play';
    if (!playback?.failed && !playback?.ended) $('playback-status').textContent = 'Paused';
  } else {
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
      if (generation !== seekGeneration || current !== video) return;
      startPlayer(video, target);
    }).catch(error => {
      if (generation === seekGeneration) $('playback-status').textContent = error?.message || 'Unable to seek.';
    });
  }, 250);
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
