import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {JSMpegHttpSource, installRecordedBufferWindow, installRecordedAudioOutput, installRecordedAudioLead, installRecordedPlayerPause} from '../http-source.js';
import {DiagnosticsJournal, LiveStats} from '../diagnostics.js';

// Pure UI logic from app.js, run in the same fake-DOM sandbox as playback.test.js.
const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8').replace(/^import .*?;\n/gm, '');
function setup() {
  const elements = new Map(), requests = [];
  const element = id => {
    if (!elements.has(id)) elements.set(id, {textContent:'', hidden:false, dataset:{}, scrollIntoView() {}, removeAttribute(name) { delete this[name]; }});
    return elements.get(id);
  };
  class Player {
    constructor(url, options) {
      this.options = options; this.paused = false;
      this.source = {pauseReading() {}, resumeReading() {}, destroy:() => Promise.resolve()};
      this.audioOut = {unlock() {}, context:{state:'running', resume:() => Promise.resolve()}};
    }
    pause() { this.paused = true; } play() { this.paused = false; } destroy() {}
  }
  const context = vm.createContext({
    JSMpegHttpSource, installRecordedBufferWindow, installRecordedAudioOutput, installRecordedAudioLead, installRecordedPlayerPause,
    DiagnosticsJournal, LiveStats,
    document:{getElementById:element}, window:{JSMpeg:{Player}, addEventListener() {}},
    fetch:(url, options) => { requests.push({url, body:options?.body ? JSON.parse(options.body) : null}); return new Promise(() => {}); },
    setInterval() {}, setTimeout, clearTimeout, URL, URLSearchParams, Number,
  });
  vm.runInContext(app, context);
  return {element, requests, evaluate:code => vm.runInContext(code, context),
    set:(name, value) => { context[name] = value; }};
}

test('For you rows: empty and malformed rows are dropped, order kept', () => {
  const f = setup();
  f.set('result', {rows:[
    {title:'Continue watching', kind:'continue', videos:[{id:'a', title:'A', libraryId:'x'}]},
    {title:'Because you watched B', kind:'related', subtitle:'Chan', videos:[]},
    {title:'', kind:'channels', videos:[{id:'c', title:'C'}]},
    {title:'New from channels you watch', kind:'channels', videos:[{id:'d', title:'D'}, {title:'no id'}, null]},
    null]});
  const rows = f.evaluate('feedRows(result)');
  assert.deepEqual(rows.map(row => row.title), ['Continue watching', 'New from channels you watch']);
  assert.equal(rows[1].videos.length, 1);
  assert.deepEqual(f.evaluate('feedRows({}).length'), 0);
});

test('watch history payloads are only sent for library items', () => {
  const f = setup();
  const uuid = '0F8FAD5B-D9CB-469F-A165-70867728950E';
  assert.equal(f.evaluate(`historyPayload({id:'dQw4w9WgXcQ'}, 50)`), null, 'YouTube IDs are not library items');
  assert.equal(f.evaluate(`historyPayload({id:'${uuid}'}, 0.4)`), null, 'nothing watched yet');
  assert.deepEqual(JSON.parse(f.evaluate(`JSON.stringify(historyPayload({id:'${uuid}', duration:600}, 123.456))`)),
    {id:uuid, position:123.5, duration:600});
  assert.deepEqual(JSON.parse(f.evaluate(`JSON.stringify(historyPayload({id:'${uuid}'}, 0, true, 90))`)),
    {id:uuid, position:0, duration:90, finished:true});
});

test('pausing and ending a library video report history to the phone', () => {
  const f = setup();
  const uuid = '0F8FAD5B-D9CB-469F-A165-70867728950E';
  f.set('video', {id:uuid, title:'T', duration:100});
  f.evaluate('play(video)');
  f.evaluate('playback.position = 42; currentOffset = 42');
  f.element('pause').onclick();
  const history = () => f.requests.filter(request => request.url === '/api/history').map(request => request.body);
  assert.deepEqual(history(), [{id:uuid, position:42, duration:100}]);
  f.element('pause').onclick();
  f.evaluate('player.options.onEnded()');
  assert.deepEqual(history().at(-1), {id:uuid, position:100, duration:100, finished:true});
});

test('image URLs are limited to the hosts the page CSP allows', () => {
  const f = setup();
  const ok = url => f.evaluate(`safeImageURL(${JSON.stringify(url)})`);
  assert.equal(ok('https://i.ytimg.com/vi/x/mqdefault.jpg'), 'https://i.ytimg.com/vi/x/mqdefault.jpg');
  assert.equal(ok('https://yt3.ggpht.com/abc=s176'), 'https://yt3.ggpht.com/abc=s176');
  assert.equal(ok('//yt3.googleusercontent.com/abc'), 'https://yt3.googleusercontent.com/abc');
  assert.equal(ok('http://i.ytimg.com/vi/x.jpg'), '');
  assert.equal(ok('https://evil.example/x.jpg'), '');
  assert.equal(ok(''), '');
});

test('library stats count states, watched videos, channels and ready hours', () => {
  const f = setup();
  f.set('videos', [{id:'1', state:'ready', duration:3600, channel:'A'}, {id:'2', state:'ready', duration:1800, channel:'A'},
    {id:'3', state:'preparing', channel:'B'}, {id:'4', state:'failed'}, {id:'5', state:'paused'}]);
  const stats = JSON.parse(f.evaluate('JSON.stringify(libraryStats(videos))'));
  assert.deepEqual(stats, {total:5, ready:2, preparing:1, failed:2, watched:0, channels:3, hours:1.5});
});

test('queue uses the phone queue when present and the library otherwise', () => {
  const f = setup();
  f.set('videos', [{id:'b', title:'B', state:'preparing', createdAt:2}, {id:'a', title:'A', state:'preparing', createdAt:1},
    {id:'c', title:'C', state:'ready'}]);
  assert.deepEqual(f.evaluate(`queueEntries(videos, 'B').map(e => e.id + (e.active ? '*' : '')).join(',')`), 'b*,a');
  f.evaluate(`queueItems = [{id:'q1', title:'One', stage:'downloading', progress:0.5, speedBps:2500000, etaSec:30, quality:'1080p'},
    {id:'q2', title:'Two', stage:'queued', progress:0}, {id:'q3', stage:'ready'}]`);
  const entries = JSON.parse(f.evaluate('JSON.stringify(queueEntries(videos))'));
  assert.deepEqual(entries.map(entry => entry.id), ['q1', 'q2']);
  assert.equal(entries[0].detail, 'Downloading · 1080p · 2.5 MB/s · 30s left');
  assert.equal(entries[0].active, true);
});

test('upgrades are offered only below the chosen quality', () => {
  const f = setup();
  assert.equal(f.evaluate(`isUpgradable({youtubeID:'x', height:720})`), false, 'no quality setting from the phone');
  f.evaluate(`qualitySetting = '1080p'`);
  assert.equal(f.evaluate(`isUpgradable({youtubeID:'x', height:720})`), true);
  assert.equal(f.evaluate(`isUpgradable({youtubeID:'x'})`), true, 'unknown height counts as lower');
  assert.equal(f.evaluate(`isUpgradable({youtubeID:'x', height:1080})`), false);
  assert.equal(f.evaluate(`isUpgradable({youtubeID:'x', quality:'1080p'})`), false);
  assert.equal(f.evaluate(`isUpgradable({height:480})`), false, 'imports cannot be re-downloaded');
});

test('theme choice resolves system to the browser preference', () => {
  const f = setup();
  assert.equal(f.evaluate(`resolveTheme('dark')`), 'dark');
  assert.equal(f.evaluate(`resolveTheme('light')`), 'light');
  assert.equal(f.evaluate(`resolveTheme('system')`), 'light', 'no matchMedia: light');
});

test('library list is refetched only when the phone revision changes', () => {
  const f = setup();
  assert.equal(f.evaluate(`libraryNeedsFetch({})`), true, 'first load');
  f.evaluate(`lastLibrary = {videos:[], preparingID:''}; lastLibraryFetch = {revision:7, at:Date.now()}`);
  assert.equal(f.evaluate(`libraryNeedsFetch({})`), true, 'phones without a revision are polled every time');
  assert.equal(f.evaluate(`libraryNeedsFetch({libraryRevision:7})`), false);
  assert.equal(f.evaluate(`libraryNeedsFetch({libraryRevision:8})`), true);
  assert.equal(f.evaluate(`libraryNeedsFetch({libraryRevision:7}, true)`), true, 'user actions force a fetch');
  f.evaluate(`lastLibraryFetch.at = Date.now() - 31000`);
  assert.equal(f.evaluate(`libraryNeedsFetch({libraryRevision:7})`), true, 'safety refetch every 30 s');
});
