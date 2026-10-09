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
