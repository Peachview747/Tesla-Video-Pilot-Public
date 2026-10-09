import {JSMpegHttpSource} from './http-source.js';
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
const audioBoostKey = 'video-pilot-audio-boost';
const audioBoostVolume = 1.35;
let audioBoost = true;
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
function saveResume() {
  if (!current || currentOffset < 3 || playback?.ended) return;
  try { globalThis.localStorage?.setItem(resumeKey(current), String(Math.floor(currentOffset))); } catch {}
}
function clearResume(video = current) {
  try { globalThis.localStorage?.removeItem(resumeKey(video)); } catch {}
}
async function api(path, body) {
  const response = await fetch(path, {method:body ? 'POST' : 'GET', credentials:'same-origin', cache:'no-store',
    headers:body ? {'Content-Type':'application/json'} : {}, body:body ? JSON.stringify(body) : undefined});
  const raw = await response.text();
  let result;
  try { result = raw ? JSON.parse(raw) : {}; }
  catch {
    throw new Error(response.ok
      ? 'The host returned an unexpected page. Refresh the Tesla browser and keep Video Pilot open.'
      : `Connection to Video Pilot failed (${response.status}). Refresh to retry.`);
  }
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status}).`);
  return result;
}
// Browser-side telemetry is batched before it crosses the relay. It contains
// timing, counters, and player state only; URLs, IDs, headers, and media bytes
// are intentionally excluded. The iPhone decides whether to retain it.
const diagnosticsQueue = [];
let diagnosticsFlushTimer = null;
function reportDiagnostic(event, fields = {}) {
  if (diagnosticsQueue.length >= 64) diagnosticsQueue.shift();
  diagnosticsQueue.push({event, fields});
  if (!diagnosticsFlushTimer) diagnosticsFlushTimer = setTimeout(() => {
    diagnosticsFlushTimer = null; void flushDiagnostics();
  }, 250);
}
async function flushDiagnostics(keepalive = false) {
  if (!diagnosticsQueue.length) return;
  const events = diagnosticsQueue.splice(0, diagnosticsQueue.length);
  try {
    await fetch('/api/diagnostics', {method:'POST', credentials:'same-origin', cache:'no-store', keepalive,
      headers:{'Content-Type':'application/json'}, body:JSON.stringify({events})});
  } catch { /* Diagnostics must never interrupt playback. */ }
}
globalThis.videoPilotDiagnostics = reportDiagnostic;
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
    const action = active ? null : {label:'Remove', run:() => removeVideo(video.id)};
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
        : (video.state === 'preparing' && !active ? {label:'Remove',run:() => removeVideo(video.id)} : null);
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
    if (status.youtubeExplore && !$('explore-results').children.length) void loadExplore();
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
  try {
    const results = await api('/api/explore');
    $('explore-results').replaceChildren(...results.map(video => card(video.title, video.channel, {label:'Add to queue',run:() => queueVideo(video.id)}, video.thumbnail)));
  } catch (error) { notice(error.message); }
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
  try { await api('/api/library/remove', {id}); notice('Removed from the preparation queue.'); await refresh(); }
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
  if (!session?.startupTimer) return;
  globalThis.clearTimeout?.(session.startupTimer);
  session.startupTimer = null;
}
function syncFullscreenControls(active) {
  const shell = $('player-shell');
  if (active) shell.classList?.add?.('vp-fullscreen');
  else shell.classList?.remove?.('vp-fullscreen');
  $('fullscreen').hidden = !active;
  $('exit-fullscreen').hidden = active;
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
function closePlayer() {
  saveResume();
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
  if (!context || !gain || typeof context.createDynamicsCompressor !== 'function') return;
  try {
    if (audioLimiter?.context === context) return;
    audioLimiter?.disconnect?.();
    // JSMpeg normally connects its gain node directly to the destination.
    // Replace that direct edge with a conservative compressor so the optional
    // browser boost cannot clip loud source peaks into crackling distortion.
    gain.disconnect();
    const limiter = context.createDynamicsCompressor();
    limiter.threshold.value = -6;
    limiter.knee.value = 8;
    limiter.ratio.value = 12;
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
    boost.title = audioBoost ? 'Audio boost on (135%)' : 'Audio boost off (100%)';
  }
  reportDiagnostic('audioState', {muted:audioMuted, boost:audioBoost, gain:volume});
}
function startPlayer(video, seek = null, recoveryAttempt = 0) {
  current = video;
  const duration = finiteDuration(video.duration);
  currentOffset = Math.max(0, Number(seek ?? savedResume(video)) || 0);
  if (duration) currentOffset = Math.min(currentOffset, duration);
  reportDiagnostic('playerStart', {seekTargetSeconds:currentOffset, recoveryAttempt});
  const session = {paused:false, failed:false, ended:false, baseOffset:currentOffset,
    position:currentOffset, duration, decoded:false, startupTimer:null, recoveryAttempt}; playback = session;
  const active = () => playback === session && !session.paused && !session.failed && !session.ended;
  const recoveryDelay = () => {
    const override = Number(globalThis.__VP_SEEK_RECOVERY_MS);
    if (Number.isFinite(override) && override >= 0) return override;
    return session.baseOffset > 0 ? 10000 : 15000;
  };
  const armRecovery = (reset = false) => {
    if (reset) clearRecoveryTimer(session);
    if (session.decoded || session.failed || session.ended || session.startupTimer) return;
    const timer = globalThis.setTimeout;
    if (typeof timer !== 'function') return;
    session.startupTimer = timer(() => {
      session.startupTimer = null;
      if (playback !== session || session.decoded || session.failed || session.ended) return;
      if (session.recoveryAttempt >= 1) {
        session.failed = true; session.paused = true;
        try { player?.pause(); player?.source?.pauseReading?.(); } catch {}
        $('playback-status').textContent = 'Playback could not resume after seeking. Tap Retry.';
        $('pause').textContent = 'Retry';
        return;
      }
      const videoAtStart = current;
      const target = Math.max(0, Math.floor((session.position || session.baseOffset || 0) - 1));
      const generation = ++seekGeneration;
      $('playback-status').textContent = 'Restarting seek…';
      seekChain = seekChain.then(async () => {
        if (generation !== seekGeneration || current !== videoAtStart) return;
        await closePlayer();
        if (generation !== seekGeneration || current !== videoAtStart) return;
        startPlayer(videoAtStart, target, session.recoveryAttempt + 1);
      }).catch(error => {
        if (generation === seekGeneration) {
          session.failed = true; session.paused = true;
          $('playback-status').textContent = error?.message || 'Playback could not resume after seeking. Tap Retry.';
          $('pause').textContent = 'Retry';
        }
      });
    }, recoveryDelay());
    // Node-based UI tests expose timer handles with `unref`; browsers expose
    // numeric IDs, so this is intentionally optional.
    session.startupTimer?.unref?.();
  };
  $('player-section').hidden = false; $('playing-title').textContent = video.title;
  audioMuted = false;
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
        syncCanvasAspect();
        session.decoded = true; clearRecoveryTimer(session);
        reportDiagnostic('playerDecode', {positionSeconds:session.position || 0});
        if (active()) $('playback-status').textContent = 'Playing from your iPhone';
      },
      onSourceError:message => {
        if (playback !== session) return;
        clearRecoveryTimer(session);
        saveResume();
        session.failed = true; $('playback-status').textContent = message;
        reportDiagnostic('playerError', {error:String(message || 'unknown'), positionSeconds:session.position || 0});
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
    configureAudioLimiter();
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
  seekTimer = setTimeout(() => {
    seekTimer = null;
    seekChain = seekChain.then(async () => {
      // A newer seek supersedes this one while the previous stream is being
      // cancelled. Do not create a player for an obsolete target.
      if (generation !== seekGeneration || current !== video) return;
      await closePlayer();
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
window.addEventListener('pagehide', () => { saveResume(); invalidateSeeks(); reportDiagnostic('playerClosed'); void flushDiagnostics(true); void closePlayer(); });
void refresh();
setInterval(() => { void refresh(); }, 2000);
