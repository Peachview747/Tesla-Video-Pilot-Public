import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {JSMpegHttpSource} from '../http-source.js';

function setup(response, destination = {}) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => response;
  const chunks = [], events = [];
  const source = new JSMpegHttpSource('/api/stream/test.ts', {
    onSourceEstablished:() => events.push('established'),
    onSourceCompleted:() => events.push('completed'),
    onSourceError:error => events.push(error)
  });
  source.connect({...destination, write(buffer) {
    chunks.push([...new Uint8Array(buffer)]);
    destination.write?.call(this, buffer);
  }});
  return {source,chunks,events,restore:() => { globalThis.fetch = original; }};
}
test('forwards only visible bytes and completes after the final chunk', async () => {
  const values = [new Uint8Array([8,1,2,9]).subarray(1,3), new Uint8Array([3])];
  const fixture = setup(new Response(new ReadableStream({pull(controller) {
    if (values.length) controller.enqueue(values.shift()); else controller.close();
  }})));
  try {
    await fixture.source.read();
    assert.deepEqual(fixture.chunks, [[1,2],[3]]);
    assert.deepEqual(fixture.events, ['established','completed']);
  } finally { fixture.restore(); }
});

test('passes indexed seek time and measured duration to the player session', async () => {
  const events = [];
  const response = new Response(new Uint8Array([1]), {headers:{
    'x-video-seek-time':'41.25', 'x-video-duration':'123.5'
  }});
  const original = globalThis.fetch;
  globalThis.fetch = async () => response;
  const source = new JSMpegHttpSource('/api/stream/test.ts', {
    onSourceStartTime:value => events.push(['seek', value]),
    onSourceDuration:value => events.push(['duration', value])
  });
  source.connect({write() {}});
  try {
    await source.read();
    assert.deepEqual(events, [['seek', 41.25], ['duration', 123.5]]);
  } finally { source.destroy(); globalThis.fetch = original; }
});

const tick = () => new Promise(resolve => setTimeout(resolve, 10));
async function until(condition) {
  for (let i = 0; i < 100 && !condition(); i++) await tick();
  assert.ok(condition(), 'Expected source state was not reached');
}
test('bounds PTS read-ahead between playback reports and resumes at low headroom', async () => {
  const values = [0, 13, 14, 15].map(value => new Uint8Array([value]));
  const fixture = setup(new Response(new ReadableStream({pull(controller) {
    if (values.length) controller.enqueue(values.shift()); else controller.close();
  }}, {highWaterMark:0})), {currentTime:0, write(buffer) { this.currentTime = new Uint8Array(buffer)[0]; }});
  try {
    const reading = fixture.source.read();
    await until(() => fixture.chunks.length === 2);
    await tick();
    assert.equal(fixture.source.streaming, false);
    assert.equal(fixture.source.buffered, true);
    assert.equal(fixture.chunks.length, 2);
    assert.equal(fixture.source.completed, false);
    fixture.source.resume(8);
    await tick();
    assert.equal(fixture.chunks.length, 2, 'Intermediate headroom must preserve the buffer wait');
    fixture.source.resume(6);
    await reading;
    assert.deepEqual(fixture.chunks, [[0], [13], [14], [15]]);
    assert.deepEqual(fixture.events, ['established', 'completed']);
  } finally { fixture.source.destroy(); fixture.restore(); }
});
test('playback reports and manual resume cannot release the other pause reason', async () => {
  const fixture = setup(new Response(new Uint8Array([1, 2])), {currentTime:0});
  try {
    fixture.source.resume(12);
    fixture.source.pauseReading();
    const reading = fixture.source.read();
    fixture.source.resume(6);
    await tick();
    assert.equal(fixture.chunks.length, 0, 'Playback headroom must not undo manual Pause');
    fixture.source.resume(12);
    fixture.source.resumeReading();
    await tick();
    assert.equal(fixture.chunks.length, 0, 'Manual Resume must not undo the high-water wait');
    fixture.source.resume(6);
    await reading;
    assert.equal(fixture.chunks.length, 1);
    assert.equal(fixture.source.completed, true);
  } finally { fixture.source.destroy(); fixture.restore(); }
});
test('destroy releases both buffer and manual waits without reporting completion', async () => {
  const fixture = setup(new Response(new Uint8Array([1])), {currentTime:0});
  try {
    fixture.source.resume(12); fixture.source.pauseReading();
    const reading = fixture.source.read();
    await tick();
    fixture.source.destroy();
    await reading;
    assert.deepEqual(fixture.chunks, []);
    assert.deepEqual(fixture.events, []);
    assert.equal(fixture.source.completed, false);
  } finally { fixture.restore(); }
});
test('a manual pause during an outstanding read holds that chunk until Resume', async () => {
  let controller;
  const fixture = setup(new Response(new ReadableStream({start(value) { controller = value; }})));
  try {
    const reading = fixture.source.read();
    await tick();
    fixture.source.pauseReading();
    controller.enqueue(new Uint8Array([1, 2])); controller.close();
    await tick();
    assert.equal(fixture.chunks.length, 0);
    fixture.source.resumeReading();
    await reading;
    assert.deepEqual(fixture.chunks, [[1, 2]]);
    assert.equal(fixture.source.completed, true);
  } finally { fixture.source.destroy(); fixture.restore(); }
});
test('read-ahead uses the shipped MPEG-TS demuxer PTS and recorded playback contract', async () => {
  let clock = 0;
  const context = vm.createContext({window:{performance:{now:() => clock}}, document:{addEventListener() {}}, console});
  vm.runInContext(readFileSync(new URL('../../../app/client/public/jsmpeg.min.js', import.meta.url), 'utf8'), context);
  const demuxer = new context.JSMpeg.Demuxer.TS({});
  const decoder = new context.JSMpeg.Decoder.Base({streaming:false});
  decoder.bits = new context.JSMpeg.BitBuffer(1024);
  demuxer.connect(context.JSMpeg.Demuxer.TS.STREAM.VIDEO_1, decoder);
  function packet(seconds, counter) {
    const ticks = seconds * 90000;
    const pts = [0x21 | ((Math.floor(ticks / 1073741824) & 7) << 1), (ticks >>> 22) & 255,
      (((ticks >>> 15) & 127) << 1) | 1, (ticks >>> 7) & 255, ((ticks & 127) << 1) | 1];
    const bytes = new Uint8Array(188).fill(255);
    // Adaptation stuffing leaves one complete PES with a four-byte payload.
    bytes.set([0x47, 0x41, 0, 0x30 | counter, 165, 0]);
    bytes.set([0, 0, 1, 0xe0, 0, 12, 0x80, 0x80, 5, ...pts, 0, 0, 1, 0xb7], 170);
    return bytes;
  }
  const values = [100, 113, 114, 115].map(packet);
  const fixture = setup(new Response(new ReadableStream({pull(controller) {
    if (values.length) controller.enqueue(values.shift()); else controller.close();
  }}, {highWaterMark:0})));
  fixture.source.connect(demuxer);
  try {
    const reading = fixture.source.read();
    await until(() => demuxer.currentTime === 113);
    await tick();
    assert.equal(fixture.source.buffered, true);
    assert.equal(fixture.source.completed, false);
    assert.equal(decoder.collectTimestamps, true);
    // The actual recorded-player path must drain/wake this source even when
    // WebAudio is unavailable. Only video rendering is replaced in this check.
    const player = Object.assign(Object.create(context.JSMpeg.Player.prototype), {
      source:fixture.source, demuxer, audio:null, startTime:0, options:{},
      video:{startTime:100, currentTime:100, frameRate:30, decode:() => false},
    });
    player.updateForStaticFile();
    assert.equal(fixture.source.buffered, true, 'High headroom must stay held');
    clock = 7000; player.video.currentTime = 107;
    player.updateForStaticFile();
    await reading;
    assert.equal(demuxer.currentTime, 115);
    assert.equal(fixture.source.completed, true);
    assert.equal(decoder.timestamps.length, 4);
  } finally { fixture.source.destroy(); fixture.restore(); }
});
test('rejects an empty response and an expired session', async () => {
  for (const [response,message] of [[new Response(new Uint8Array()),'empty'],[new Response('',{status:401}),'Pair']]) {
    const fixture = setup(response);
    try {
      await fixture.source.read();
      assert.equal(fixture.source.completed, false);
      assert.ok(fixture.events[0].includes(message));
    } finally { fixture.restore(); }
  }
});
test('pause waits before feeding chunks and destroy releases the wait', async () => {
  const fixture = setup(new Response(new Uint8Array([1,2,3])));
  try {
    fixture.source.pauseReading();
    const reading = fixture.source.read();
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(fixture.chunks.length, 0);
    fixture.source.resumeReading();
    await reading;
    assert.deepEqual(fixture.chunks, [[1,2,3]]);
    assert.equal(fixture.source.completed, true);
  } finally { fixture.restore(); }
  const aborted = setup(new Response(new Uint8Array([4])));
  try {
    aborted.source.pauseReading();
    const reading = aborted.source.read();
    await new Promise(resolve => setTimeout(resolve, 10));
    aborted.source.destroy();
    await reading;
    assert.equal(aborted.chunks.length, 0);
    assert.equal(aborted.events.length, 0);
  } finally { aborted.restore(); }
});
test('reports a truncated tunnel stream instead of marking playback complete', async () => {
  const fixture = setup(new Response(new Uint8Array([0x47, 1]), {headers:{'content-length':'188'}}));
  try {
    await fixture.source.read();
    assert.equal(fixture.source.completed, false);
    assert.equal(fixture.events[0], 'established');
    assert.match(fixture.events[1], /interrupted/);
  } finally { fixture.restore(); }
});
