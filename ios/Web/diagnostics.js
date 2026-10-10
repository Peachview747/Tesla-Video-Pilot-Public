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

// Live playback/connection numbers for the Settings → Diagnostics card. Fed
// from the same events the journal records (see reportDiagnostic in app.js),
// so it needs no extra hooks in the stream reader. Values are numbers or null.
export class LiveStats {
  constructor(now = () => Date.now()) { this.now = now; this.apiErrors = 0; this.rttMs = null; this.resetVideo(); }
  resetVideo() {
    this.stalls = 0; this.reconnects = 0; this.bufferSeconds = null; this.throughputMbps = null;
    this.receivedBytes = 0; this.firstFrameMs = null; this.startedAt = null; this.sample = null;
  }
  record(event, fields = {}) {
    const number = value => { const n = Number(value); return Number.isFinite(n) ? n : null; };
    const now = this.now();
    switch (event) {
      case 'playerStart':
        if (this.firstFrameMs === null) this.startedAt = now;
        this.sample = null;
        break;
      case 'playerDecode':
        if (this.startedAt !== null && this.firstFrameMs === null) { this.firstFrameMs = Math.max(0, now - this.startedAt); this.startedAt = null; }
        break;
      case 'sourceProgress': {
        const bytes = number(fields.receivedBytes), elapsed = number(fields.elapsedMs);
        if (bytes === null || elapsed === null) break;
        const last = this.sample;
        // A smaller byte count means a new stream (seek/reconnect): new baseline.
        if (!last || bytes < last.bytes || elapsed < last.elapsed) {
          this.receivedBytes += Math.max(0, bytes);
          if (elapsed > 0 && bytes > 0) this.throughputMbps = bytes * 8 / elapsed / 1000;
        } else {
          const delta = bytes - last.bytes, dt = elapsed - last.elapsed;
          this.receivedBytes += delta;
          if (dt > 0) {
            const rate = delta * 8 / dt / 1000;
            this.throughputMbps = this.throughputMbps === null ? rate : this.throughputMbps * 0.6 + rate * 0.4;
          }
        }
        this.sample = {bytes, elapsed};
        const headroom = number(fields.headroomSeconds);
        if (headroom !== null) this.bufferSeconds = headroom;
        break;
      }
      case 'sourceBuffer': { const value = number(fields.bufferSeconds); if (value !== null) this.bufferSeconds = value; break; }
      case 'playerStalled': this.stalls += 1; break;
      case 'playerError': case 'playerBusyRetry': this.reconnects += 1; break;
      case 'apiError': this.apiErrors += 1; break;
      case 'browserRTT': {
        const value = number(fields.elapsedMs);
        if (value !== null) this.rttMs = this.rttMs === null ? value : Math.round(this.rttMs * 0.7 + value * 0.3);
        break;
      }
      default: break;
    }
  }
  snapshot(liveBufferSeconds = null) {
    const live = Number(liveBufferSeconds);
    return {bufferSeconds:Number.isFinite(live) && liveBufferSeconds !== null ? live : this.bufferSeconds,
      throughputMbps:this.throughputMbps, receivedBytes:this.receivedBytes, stalls:this.stalls, reconnects:this.reconnects,
      firstFrameMs:this.firstFrameMs, apiErrors:this.apiErrors, rttMs:this.rttMs};
  }
}
