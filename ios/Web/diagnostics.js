// Bounded local evidence survives both a lost ACK and a disconnected iPhone.
export class DiagnosticsJournal {
  constructor(storage, key, limit = 256) {
    this.storage = storage; this.key = key; this.limit = limit;
    this.events = [];
    try {
      const saved = JSON.parse(storage?.getItem(key) || '[]');
      if (Array.isArray(saved)) for (const entry of saved.slice(-limit)) {
        if (entry && typeof entry.event === 'string') this.append(entry.event, entry.fields, entry);
      }
    } catch {}
  }
  get pending() { return this.events.filter(entry => !entry.delivered); }
  batch(count = 16, maximumBytes = 12000) {
    const entries = [];
    for (const entry of this.pending.slice(0, count)) {
      const candidate = [...entries, entry];
      if (new TextEncoder().encode(JSON.stringify({events:candidate})).byteLength > maximumBytes) break;
      entries.push(entry);
    }
    return entries;
  }
  append(event, fields = {}, metadata = {}) {
    const clean = {};
    for (const [key, raw] of Object.entries(fields || {}).slice(0, 24)) {
      let value = String(raw).slice(0, 240);
      if (/secret|token|cookie|authorization|password|body/i.test(key) ||
          /:\/\/|bearer\s|x-secret|[\w.+-]+@[\w.-]+\.[a-z]+/i.test(value)) value = '[redacted]';
      clean[key.slice(0, 48)] = value;
      if (new TextEncoder().encode(JSON.stringify(clean)).byteLength > 6000) { delete clean[key.slice(0, 48)]; break; }
    }
    this.events.push({event:String(event).slice(0, 64), fields:clean,
      eventId: typeof metadata.eventId === 'string' ? metadata.eventId.slice(0, 96)
        : globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
      occurredAt: metadata.occurredAt || new Date().toISOString(), delivered:metadata.delivered === true});
    while (this.events.length > this.limit) this.events.shift();
    this.persist();
  }
  acknowledge(ids) {
    const delivered = new Set(ids);
    for (const entry of this.events) if (delivered.has(entry.eventId)) entry.delivered = true;
    this.persist();
  }
  persist() { try { this.storage?.setItem(this.key, JSON.stringify(this.events)); } catch {} }
  text() {
    return this.events.map(({delivered, occurredAt, ...entry}) =>
      JSON.stringify({...entry, timestamp:occurredAt, component:'browser'})).join('\n') + (this.events.length ? '\n' : '');
  }
}
