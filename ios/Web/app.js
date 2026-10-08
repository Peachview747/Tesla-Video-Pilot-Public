import {JSMpegHttpSource} from './http-source.js';
const $ = id => document.getElementById(id);
let player = null, current = null, currentOffset = 0, seekTimer = null;
let playback = null;
let refreshing = false;
let seekGeneration = 0;
let seekChain = Promise.resolve();
// A stable page-local identity lets the relay evict a stream whose browser
// player was replaced before the browser's fetch abort reached the Worker.
const playbackClient = (() => {
  try { if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID(); } catch {}
  return `vp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
})();
const notice = message => { $('notice').textContent = message; };
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
function renderQueue(videos) {
  const queued = videos.filter(video => video.state === 'preparing');
  const panel = $('queue-panel');
  panel.hidden = !queued.length;
  $('queue-badge').textContent = `${queued.length} queued`;
  $('queue-summary').textContent = queued.length ? `${queued.length} video${queued.length === 1 ? '' : 's'} in progress` : '';
  const list = $('queue-list'); list.replaceChildren();
  queued.forEach((video, index) => list.append(card(`${index + 1}. ${video.title}`, video.message || 'Waiting for preparation', null,
    video.youtubeID ? `https://i.ytimg.com/vi/${encodeURIComponent(video.youtubeID)}/mqdefault.jpg` : null)));
}
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const videos = await api('/api/library');
    $('host-ui').hidden = false;
    $('connection').textContent = 'Connected to iPhone';
    $('connection').dataset.state = 'online';
    const status = await api('/api/status');
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
    for (const video of videos) library.append(card(video.title, video.message || video.state,
      video.state === 'ready' ? {label:savedResume(video) ? 'Resume · ' + formatTime(savedResume(video)) : 'Play',run:() => play(video)} : null,
      video.youtubeID ? `https://i.ytimg.com/vi/${encodeURIComponent(video.youtubeID)}/mqdefault.jpg` : null));
    renderQueue(videos);
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
function closePlayer() {
  saveResume();
  playback = null;
  globalThis.clearTimeout?.(seekTimer); seekTimer = null;
  const oldPlayer = player;
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
function startPlayer(video, seek = null) {
  current = video;
  const duration = finiteDuration(video.duration);
  currentOffset = Math.max(0, Number(seek ?? savedResume(video)) || 0);
  if (duration) currentOffset = Math.min(currentOffset, duration);
  const session = {paused:false, failed:false, ended:false, baseOffset:currentOffset,
    position:currentOffset, duration}; playback = session;
  const active = () => playback === session && !session.paused && !session.failed && !session.ended;
  $('player-section').hidden = false; $('playing-title').textContent = video.title;
  $('playback-status').textContent = 'Buffering…'; $('pause').textContent = 'Pause'; $('mute').textContent = 'Mute';
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
      },
      onSourceDuration:value => {
        if (playback !== session) return;
        const actual = finiteDuration(value);
        if (!actual) return;
        session.duration = actual;
        updateTimeline(session.position, actual);
      },
      onStalled:() => { if (active()) $('playback-status').textContent = 'Buffering…'; },
      onVideoDecode:() => { if (active()) $('playback-status').textContent = 'Playing from your iPhone'; },
      onSourceError:message => {
        if (playback !== session) return;
        saveResume();
        session.failed = true; $('playback-status').textContent = message;
      },
      onEnded:() => {
        if (playback !== session || session.failed) return;
        session.ended = true;
        if (session.duration) session.position = session.duration;
        currentOffset = session.position;
        updateTimeline(session.position, session.duration);
        $('playback-status').textContent = 'Finished'; $('pause').textContent = 'Play';
        clearResume(video);
      }
    });
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
    player.volume = player.volume > 0 ? 0 : 1;
    if (player.volume > 0) unlockAudio();
    $('mute').textContent = player.volume > 0 ? 'Mute' : 'Unmute';
  }
};
async function enterFullscreen() {
  try { await $('player-shell').requestFullscreen?.(); $('fullscreen').hidden = true; $('exit-fullscreen').hidden = false; }
  catch { notice('Full screen is unavailable in this browser.'); }
}
$('fullscreen').onclick = enterFullscreen;
$('exit-fullscreen').onclick = () => document.exitFullscreen?.();
document.addEventListener?.('fullscreenchange', () => {
  const full = document.fullscreenElement === $('player-shell');
  $('fullscreen').hidden = full; $('exit-fullscreen').hidden = !full;
});
function requestSeek(offset) {
  if (!current) return;
  globalThis.clearTimeout?.(seekTimer);
  const target = Math.max(0, Number(offset) || 0);
  const video = current;
  const generation = ++seekGeneration;
  $('playback-status').textContent = 'Seeking…';
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
window.addEventListener('pagehide', () => { saveResume(); invalidateSeeks(); void closePlayer(); });
void refresh();
setInterval(() => { void refresh(); }, 2000);
