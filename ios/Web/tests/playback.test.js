import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {JSMpegHttpSource, installRecordedBufferWindow, installRecordedAudioOutput, installRecordedPlayerPause} from '../http-source.js';
import {DiagnosticsJournal} from '../diagnostics.js';

// Run the shipped UI against small DOM/player doubles. Decoder callbacks are
// driven separately from network establishment, just as in recorded JSMpeg.
const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8')
  .replace(/^import .*?;\n/gm, '');
function setup({recoveryDelay} = {}) {
  const elements = new Map(), players = [], intervals = [];
  const element = id => {
    if (!elements.has(id)) elements.set(id, {textContent:'', hidden:false, dataset:{}, scrollIntoView() {},
      removeAttribute(name) { delete this[name]; }});
    return elements.get(id);
  };
  class Player {
    constructor(url, options) {
      this.options = options; this.paused = false; this.isPlaying = false; this.volume = 1;
      this.readingPaused = false; this.audioResumes = 0; this.audioUnlocks = 0;
      this.source = {
        pauseReading:() => { this.readingPaused = true; },
        resumeReading:() => { this.readingPaused = false; },
        destroy:() => { this.sourceDestroyed = true; return Promise.resolve(); },
      };
      this.audioOut = {
        unlock:() => { this.audioUnlocks++; },
        context:{state:'suspended', resume:() => { this.audioResumes++; return Promise.resolve(); }},
      };
      players.push(this);
    }
    pause() { this.paused = true; this.isPlaying = false; }
    play() { this.paused = false; }
    destroy() { this.destroyed = true; this.source.destroy(); }
  }
  const context = vm.createContext({
    JSMpegHttpSource,
    installRecordedBufferWindow, installRecordedAudioOutput, installRecordedPlayerPause,
    DiagnosticsJournal,
    document:{getElementById:element},
    window:{JSMpeg:{Player}, addEventListener() {}},
    // The library refresh is outside these focused playback tests.
    fetch:() => new Promise(() => {}), setInterval:callback => { intervals.push(callback); }, setTimeout, clearTimeout, URL, Number,
    __VP_SEEK_RECOVERY_MS: recoveryDelay,
  });
  vm.runInContext(app, context);
  return {
    element, players,
    play:(video = {id:'video', title:'Test video'}) => { context.testVideo = video; vm.runInContext('play(testVideo)', context); },
    tick:() => intervals[0]?.(),
    advanceClock:ms => vm.runInContext(`{ const now = Date.now(); Date.now = () => now + ${ms}; }`, context),
    close:() => element('close').onclick(),
    preparation:status => {
      context.testPreparation = status;
      vm.runInContext('updatePreparation(testPreparation, [])', context);
    },
  };
}
test('network arrival stays buffering until decode, and decoder stalls recover visibly', () => {
  const f = setup(); f.play();
  const player = f.players[0], status = f.element('playback-status');
  assert.equal(status.textContent, 'Buffering…');
  player.options.onSourceEstablished?.();
  assert.equal(status.textContent, 'Buffering…');
  player.options.onVideoDecode();
  assert.equal(status.textContent, 'Playing from your iPhone');
  player.options.onStalled();
  assert.equal(status.textContent, 'Buffering…');
  player.options.onVideoDecode();
  assert.equal(status.textContent, 'Playing from your iPhone');
  assert.equal(player.audioResumes, 1);
});
test('preparation shows measured processing rate and ETA without reusing stale stage values', () => {
  const f = setup();
  f.preparation({busy:true, preparationStage:'processing', preparationProgress:0.5,
    processingSpeed:2.5, preparationSecondsRemaining:90});
  assert.equal(f.element('preparation-detail').textContent, '2.5× real time · About 2 min remaining');
  assert.equal(f.element('preparation-progress').value, 0.5);
  f.preparation({busy:true, preparationStage:'processing', processingSpeed:Infinity,
    preparationSecondsRemaining:NaN});
  assert.equal(f.element('preparation-detail').textContent, 'Measuring preparation speed…');
  assert.equal(f.element('preparation-progress').value, undefined);
  f.preparation({busy:true, preparationStage:'waitingForApp', processingSpeed:2.5,
    preparationSecondsRemaining:90});
  assert.equal(f.element('preparation-detail').textContent, 'Open Video Pilot on the iPhone to finish processing.');
});
test('Pause works before the first frame and callbacks cannot undo it', () => {
  const f = setup(); f.play();
  const player = f.players[0], status = f.element('playback-status');
  f.element('pause').onclick();
  assert.equal(player.paused, true);
  assert.equal(player.readingPaused, true);
  assert.equal(status.textContent, 'Paused');
  player.options.onStalled(); player.options.onVideoDecode();
  assert.equal(status.textContent, 'Paused');
  f.element('pause').onclick();
  assert.equal(player.paused, false);
  assert.equal(player.readingPaused, false);
  assert.equal(status.textContent, 'Buffering…');
  player.options.onVideoDecode();
  assert.equal(status.textContent, 'Playing from your iPhone');
  assert.equal(player.audioResumes, 2);
  f.element('mute').onclick(); f.element('mute').onclick();
  assert.equal(player.audioResumes, 3, 'Unmute retries audio context activation');
});
test('quiet Tesla audio can be boosted without losing mute state', () => {
  const f = setup(); f.play();
  const player = f.players[0];
  assert.equal(player.volume, 1, 'new playback starts at unity gain to avoid clipping');
  f.element('audio-boost').onclick();
  assert.equal(player.volume, 1.15, 'Audio + enables a gentle boost');
  f.element('mute').onclick();
  assert.equal(player.volume, 0, 'mute still wins over the gain setting');
  f.element('audio-boost').onclick();
  assert.equal(player.volume, 0, 'changing gain while muted stays silent');
  f.element('mute').onclick();
  assert.equal(player.volume, 1, 'unmute restores the selected unity gain');
});
test('startup recovery holds a manual pause and rearms when playback resumes', async () => {
  const f = setup({recoveryDelay:10}); f.play();
  f.element('pause').onclick();
  await new Promise(resolve => setTimeout(resolve, 35));
  assert.equal(f.players.length, 1);
  assert.equal(f.element('playback-status').textContent, 'Paused');
  f.element('pause').onclick();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(f.players.length, 2, 'Resuming a silent source rearms recovery');
  f.close();
});
test('fullscreen exposes Exit and restores the Full screen button on exit', async () => {
  const f = setup(); f.play();
  await f.element('fullscreen').onclick();
  assert.equal(f.element('fullscreen').hidden, true);
  assert.equal(f.element('exit-fullscreen').hidden, false);
  f.element('exit-fullscreen').onclick();
  assert.equal(f.element('fullscreen').hidden, false);
  assert.equal(f.element('exit-fullscreen').hidden, true);
  f.close();
});
test('seeking keeps the user mute preference across decoder replacement', async () => {
  const f = setup(); f.play({id:'video', title:'Test', duration:100});
  f.element('mute').onclick();
  assert.equal(f.players[0].volume, 0);
  f.element('forward10').onclick();
  await new Promise(resolve => setTimeout(resolve, 650));
  assert.equal(f.players.length, 2);
  assert.equal(f.players[1].volume, 0);
  assert.equal(f.element('mute').textContent, 'Unmute');
  f.close();
});
test('stream failures survive late decoder and end callbacks', () => {
  const f = setup(); f.play();
  const player = f.players[0], status = f.element('playback-status');
  player.options.onSourceError('Video stream interrupted.');
  player.options.onVideoDecode(); player.options.onStalled(); player.options.onEnded();
  assert.equal(status.textContent, 'Connection interrupted. Reconnecting…');
});
test('finished playback and replacement players ignore late callbacks', async () => {
  const f = setup(); f.play();
  const first = f.players[0], status = f.element('playback-status');
  first.options.onEnded(); first.options.onVideoDecode(); first.options.onStalled();
  assert.equal(status.textContent, 'Finished');
  f.play();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(first.destroyed, true);
  first.options.onVideoDecode(); first.options.onSourceError('Old stream failed'); first.options.onEnded();
  assert.equal(status.textContent, 'Buffering…');
  f.players[1].options.onVideoDecode();
  assert.equal(status.textContent, 'Playing from your iPhone');
  f.close(); first.options.onStalled();
  assert.equal(f.element('player-section').hidden, true);
});

test('timeline follows the active decoder and snaps to the measured duration at end', () => {
  const f = setup(); f.play({id:'video', title:'Test video', duration:100});
  const player = f.players[0];
  assert.equal(f.element('timeline').max, '100');
  player.currentTime = 4;
  f.tick();
  assert.equal(f.element('timeline').value, '4');
  assert.equal(f.element('elapsed').textContent, '0:04');
  // A late duration header repairs a stale library duration for this session.
  player.options.onSourceDuration(12);
  player.currentTime = 11;
  f.tick();
  assert.equal(f.element('timeline').max, '12');
  assert.equal(f.element('timeline').value, '11');
  player.options.onEnded();
  assert.equal(f.element('timeline').value, '12');
  assert.equal(f.element('elapsed').textContent, '0:12');
});

test('repeated seeks serialize teardown and keep one relay player identity', async () => {
  const f = setup(); f.play();
  const first = f.players[0];
  const seek = value => f.element('timeline').onchange({target:{value:String(value)}});
  seek(12);
  await new Promise(resolve => setTimeout(resolve, 650));
  assert.equal(f.players.length, 2);
  const second = f.players[1];
  assert.equal(first.destroyed, true);
  assert.equal(first.sourceDestroyed, true);
  assert.equal(first.options.headers['x-mk8-player'], second.options.headers['x-mk8-player']);

  // A newer target supersedes a seek that is still waiting for its old source
  // to settle; only the final target may create another JSMpeg instance.
  seek(2); await new Promise(resolve => setTimeout(resolve, 30)); seek(24);
  await new Promise(resolve => setTimeout(resolve, 650));
  assert.equal(second.destroyed, true);
  assert.equal(second.sourceDestroyed, true);
  assert.equal(f.players.length, 3);
  assert.equal(f.element('playback-status').textContent, 'Buffering…');
});

test('a seek that never decodes gets one bounded retry and a recoverable state', async () => {
  const f = setup({recoveryDelay:10});
  f.play({id:'video', title:'Test video', duration:100});
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(f.players.length, 2, 'the stalled seek is retried once');
  assert.equal(f.players[0].destroyed, true);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(f.players.length, 2, 'a second stall does not create an infinite player loop');
  assert.equal(f.players[1].paused, true);
  assert.match(f.element('playback-status').textContent, /could not resume after seeking/);
  assert.equal(f.element('pause').textContent, 'Retry');
});

test('HTTP 429 from a busy relay is retried with backoff instead of failing playback', async () => {
  const f = setup(); f.play({id:'video', title:'Test video', duration:100});
  const status = f.element('playback-status');
  f.players[0].options.onSourceError('Video stream failed (HTTP 429).');
  assert.equal(status.textContent, 'iPhone is busy. Retrying…');
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal(f.players.length, 2, 'the same target is reopened after the first backoff');
  assert.equal(f.players[0].destroyed, true);
  assert.equal(status.textContent, 'Buffering…');
  f.close();
});
test('other HTTP 4xx stream errors remain fatal and offer Retry', async () => {
  const f = setup(); f.play({id:'video', title:'Test video', duration:100});
  f.players[0].options.onSourceError('Video stream failed (HTTP 404).');
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal(f.players.length, 1);
  assert.equal(f.element('pause').textContent, 'Retry');
  assert.match(f.element('playback-status').textContent, /HTTP 404/);
  f.close();
});
test('resuming after a long pause reopens the stream at the paused position', async () => {
  const f = setup(); f.play({id:'video', title:'Test video', duration:100});
  f.element('pause').onclick();
  assert.equal(f.element('pause').textContent, 'Play');
  f.advanceClock(31000);
  f.element('pause').onclick();
  await new Promise(resolve => setTimeout(resolve, 650));
  assert.equal(f.players.length, 2, 'a fresh stream replaces the idle one');
  assert.equal(f.players[0].destroyed, true);
  assert.equal(f.element('pause').textContent, 'Pause');
  f.close();
});
test('resuming after a short pause keeps the same stream', async () => {
  const f = setup(); f.play({id:'video', title:'Test video', duration:100});
  f.element('pause').onclick();
  f.element('pause').onclick();
  await new Promise(resolve => setTimeout(resolve, 650));
  assert.equal(f.players.length, 1);
  assert.equal(f.element('pause').textContent, 'Pause');
  f.close();
});
