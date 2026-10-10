import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {installRecordedBufferWindow, installRecordedAudioOutput, installRecordedAudioLead, installRecordedPlayerPause} from '../http-source.js';

function library(AudioContext) {
  let clock = 0;
  const context = vm.createContext({window:{AudioContext, performance:{now:() => clock * 1000}},
    document:{addEventListener() {}}, navigator:{userAgent:'Node'}, cancelAnimationFrame() {}, console});
  vm.runInContext(readFileSync(new URL('../../../app/client/public/jsmpeg.min.js', import.meta.url), 'utf8'), context);
  return {JSMpeg:context.JSMpeg, now:() => clock, setClock:value => { clock = value; }};
}

test('recorded decoder bounds a long file while preserving PTS and pause rewind', () => {
  const {JSMpeg} = library();
  const decoder = new JSMpeg.Decoder.Base({streaming:false});
  decoder.bits = new JSMpeg.BitBuffer(64 * 1024);
  installRecordedBufferWindow(decoder, 1024 * 1024);
  const chunkBytes = 64 * 1024;
  for (let second = 100; second < 2100; second++) {
    decoder.write(second, new Uint8Array(chunkBytes).fill(second % 251));
    decoder.bits.index = decoder.bits.byteLength * 8;
    decoder.decodedTime = second + 0.75;
    assert.ok(decoder.bits.byteLength <= 4 * chunkBytes, 'Only the recent window should remain');
    assert.ok(decoder.timestamps.length <= 4, 'Consumed PTS must be removed');
    assert.ok(decoder.bits.bytes.length <= 1024 * 1024);
    assert.equal(decoder.bytesWritten, decoder.bits.byteLength);
  }
  decoder.seek(2099.5);
  assert.equal(decoder.currentTime, 2099);
  assert.equal(decoder.bits.bytes[decoder.bits.index >> 3], 2099 % 251);
  assert.equal(decoder.collectTimestamps, true);
  assert.equal(decoder.startTime, 100, 'Compaction must preserve the original stream origin');
});

test('recorded buffer rejects unread overload without discarding pending data', () => {
  const {JSMpeg} = library();
  const decoder = new JSMpeg.Decoder.Base({streaming:false});
  decoder.bits = new JSMpeg.BitBuffer(64 * 1024);
  installRecordedBufferWindow(decoder, 256 * 1024);
  for (let second = 0; second < 4; second++) decoder.write(second, new Uint8Array(64 * 1024).fill(second));
  assert.throws(() => decoder.write(4, new Uint8Array(64 * 1024)), /safe limit/);
  assert.equal(decoder.bits.byteLength, 256 * 1024);
  assert.equal(decoder.bits.index, 0);
  assert.equal(decoder.timestamps.length, 4);
  assert.equal(decoder.bits.bytes[3 * 64 * 1024], 3);
});

test('recorded buffer safely grows for a PES larger than twice its initial capacity', () => {
  const {JSMpeg} = library();
  const decoder = new JSMpeg.Decoder.Base({streaming:false});
  decoder.bits = new JSMpeg.BitBuffer(64 * 1024);
  installRecordedBufferWindow(decoder, 1024 * 1024);
  decoder.write(100, new Uint8Array(200 * 1024).fill(17));
  assert.equal(decoder.bits.byteLength, 200 * 1024);
  assert.equal(decoder.bits.bytes[200 * 1024 - 1], 17);
});

function mockAudioContext() {
  const nodes = [];
  class AudioContext {
    currentTime = 0;
    destination = {};
    closed = false;
    createGain() { return {gain:{value:1}, connect() {}, disconnect() {}}; }
    createBuffer(channels, length, sampleRate) {
      const data = Array.from({length:channels}, () => new Float32Array(length));
      return {duration:length / sampleRate, getChannelData:index => data[index]};
    }
    createBufferSource() {
      const source = {connect() {}, disconnect() { this.disconnected = true; },
        start(time) { this.startedAt = time; }, stop() { this.stopped = true; }};
      nodes.push(source); return source;
    }
    close() { this.closed = true; }
  }
  return {AudioContext,nodes};
}

test('recorded audio cancels queued tails and resumes on a fresh scheduling clock', () => {
  const {AudioContext,nodes} = mockAudioContext();
  const {JSMpeg,now,setClock} = library(AudioContext);
  const output = new JSMpeg.AudioOutput.WebAudio({});
  output.unlocked = true;
  installRecordedAudioOutput(output, now);
  const samples = new Float32Array(1152);
  for (let i = 0; i < 10; i++) output.play(48000, samples, samples);
  assert.equal(output.recordedSources.size, 10);
  output.context.currentTime = 0.05; setClock(0.05);
  output.stop();
  assert.equal(output.recordedSources.size, 0);
  assert.ok(nodes.every(source => source.stopped && source.disconnected));
  assert.equal(output.enqueuedTime, 0);
  output.play(48000, samples, samples);
  assert.equal(nodes.at(-1).startedAt, 0.05);
  nodes.at(-1).onended();
  assert.equal(output.recordedSources.size, 0);
  output.play(48000, samples, samples);
  output.destroy();
  assert.equal(output.recordedSources.size, 0);
  assert.equal(output.context.closed, true);
});

test('actual recorded Player.pause rewinds to the audible position before canceling audio', () => {
  const {AudioContext} = mockAudioContext();
  const {JSMpeg,now} = library(AudioContext);
  const output = new JSMpeg.AudioOutput.WebAudio({});
  output.unlocked = true;
  installRecordedAudioOutput(output, now);
  const audio = new JSMpeg.Decoder.MP2Audio({streaming:false});
  audio.connect(output);
  audio.write(100, new Uint8Array(1024));
  audio.write(100.2, new Uint8Array(1024));
  audio.decodedTime = 100.3;
  for (let i = 0; i < 10; i++) output.play(48000, new Float32Array(1152), new Float32Array(1152));
  const player = Object.assign(Object.create(JSMpeg.Player.prototype), {
    audio, audioOut:output, video:null, source:{streaming:false}, paused:false, options:{},
  });
  // Player construction normally installs this public time accessor.
  Object.defineProperty(player, 'currentTime', {get:() => audio.currentTime - audio.startTime});
  const audiblePosition = player.currentTime;
  assert.ok(audiblePosition < 0.2);
  installRecordedPlayerPause(player);
  player.pause();
  assert.equal(output.recordedSources.size, 0);
  assert.equal(audio.decodedTime, 100, 'Pause must rewind the queued tail to the earlier PTS');
  assert.equal(player.paused, true);
  output.destroy();
});

test('late audio chunks are counted as underruns and reported', () => {
  const {AudioContext} = mockAudioContext();
  const {JSMpeg,now,setClock} = library(AudioContext);
  const output = new JSMpeg.AudioOutput.WebAudio({});
  output.unlocked = true;
  const reports = [];
  globalThis.videoPilotDiagnostics = (event, fields) => reports.push({event, ...fields});
  try {
    installRecordedAudioOutput(output, now);
    const samples = new Float32Array(1152);
    output.play(48000, samples, samples);
    output.play(48000, samples, samples);
    assert.equal(output.underruns, 0, 'back-to-back chunks are not gaps');
    output.context.currentTime = 0.2; setClock(10);
    output.play(48000, samples, samples);
    assert.equal(output.underruns, 1);
    assert.ok(output.underrunMs > 100);
    assert.deepEqual(reports.map(r => r.event), ['audioUnderrun']);
    output.stop();
    output.context.currentTime = 0.5;
    output.play(48000, samples, samples);
    assert.equal(output.underruns, 1, 'the first chunk after Stop is a fresh start, not a gap');
  } finally { delete globalThis.videoPilotDiagnostics; }
});

test('recorded playback keeps 0.75 s of audio decoded ahead instead of 0.25 s', () => {
  const {AudioContext} = mockAudioContext();
  const {JSMpeg} = library(AudioContext);
  const audio = {canPlay:true, currentTime:10, decodedTime:10, decode() { this.decodedTime += 0.026; return true; }};
  let resumed = null;
  const player = Object.assign(Object.create(JSMpeg.Player.prototype), {
    audio, video:null, demuxer:{currentTime:20}, source:{completed:false, resume:headroom => { resumed = headroom; }},
    options:{}, loop:false,
  });
  player.updateForStaticFile();
  assert.ok(audio.decodedTime - audio.currentTime < 0.3, 'stock JSMpeg lead');
  installRecordedAudioLead(player);
  player.updateForStaticFile();
  assert.ok(audio.decodedTime - audio.currentTime >= 0.75);
  assert.equal(resumed, 10);
});
