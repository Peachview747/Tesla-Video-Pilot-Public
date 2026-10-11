import test from 'node:test';
import assert from 'node:assert/strict';
import {DiagnosticsJournal} from '../diagnostics.js';

function storage() {
  const values = new Map();
  return {getItem:key => values.get(key), setItem:(key, value) => values.set(key, value)};
}
test('ACK only marks the sent IDs even when the bounded ring rolls during a POST', () => {
  const journal = new DiagnosticsJournal(storage(), 'test', 3);
  journal.append('pageLoaded'); journal.append('playerStart'); journal.append('playerDecode');
  const batch = journal.batch(2);
  journal.append('playerSeek'); journal.append('playerError');
  journal.acknowledge(batch.map(entry => entry.eventId));
  assert.deepEqual(journal.pending.map(entry => entry.event), ['playerDecode', 'playerSeek', 'playerError']);
});
test('delivered evidence stays exportable offline and retains source timestamps after reload', () => {
  const saved = storage(), journal = new DiagnosticsJournal(saved, 'test');
  journal.append('playerSeek', {positionSeconds:300});
  const event = journal.events[0];
  journal.acknowledge([event.eventId]);
  const restored = new DiagnosticsJournal(saved, 'test');
  assert.equal(restored.pending.length, 0);
  const exported = JSON.parse(restored.text());
  assert.equal(exported.eventId, event.eventId);
  assert.equal(exported.timestamp, event.occurredAt);
  assert.equal(exported.fields.positionSeconds, '300');
});
test('browser evidence redacts credentials before storage/export and bounds UTF-8 batches', () => {
  const journal = new DiagnosticsJournal(storage(), 'test');
  journal.append('apiError', {authorization:'Bearer private', error:'https://example.test/?secret=private', email:'person@example.test'});
  assert.ok(!journal.text().includes('private'));
  assert.ok(!journal.text().includes('person@example'));
  for (let i = 0; i < 20; i++) journal.append('playerError', Object.fromEntries(
    Array.from({length:24}, (_, n) => [`field${n}`, '界'.repeat(240)])));
  const batch = journal.batch();
  assert.ok(batch.length > 0);
  assert.ok(new TextEncoder().encode(JSON.stringify({events:batch})).byteLength <= 12000);
});
test('live stats: throughput from stream progress, new streams rebaseline, counters', async () => {
  const {LiveStats} = await import('../diagnostics.js');
  let now = 1000;
  const stats = new LiveStats(() => now);
  stats.record('playerStart', {});
  now = 1800; stats.record('playerDecode', {});
  stats.record('sourceProgress', {receivedBytes:1_000_000, elapsedMs:1000, headroomSeconds:4});
  assert.equal(stats.snapshot().throughputMbps, 8);
  stats.record('sourceProgress', {receivedBytes:1_500_000, elapsedMs:2000, headroomSeconds:9});
  let snap = stats.snapshot();
  assert.ok(Math.abs(snap.throughputMbps - 6.4) < 1e-9, 'smoothed 8 → 4 Mb/s');
  assert.equal(snap.receivedBytes, 1_500_000);
  assert.equal(snap.bufferSeconds, 9);
  assert.equal(snap.firstFrameMs, 800);
  // A seek opens a new stream whose counters restart from zero.
  stats.record('sourceProgress', {receivedBytes:200_000, elapsedMs:500});
  assert.equal(stats.snapshot().receivedBytes, 1_700_000);
  stats.record('playerStalled'); stats.record('playerStalled'); stats.record('playerError'); stats.record('apiError');
  stats.record('browserRTT', {elapsedMs:100}); stats.record('browserRTT', {elapsedMs:200});
  snap = stats.snapshot(2.5);
  assert.deepEqual([snap.stalls, snap.reconnects, snap.apiErrors, snap.rttMs, snap.bufferSeconds], [2, 1, 1, 130, 2.5]);
  stats.resetVideo();
  assert.deepEqual([stats.snapshot().stalls, stats.snapshot().throughputMbps, stats.snapshot().apiErrors], [0, null, 1]);
});
