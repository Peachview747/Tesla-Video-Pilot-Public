// Same recorded-stream transport as MK8's JSMpegHttpSource, with pause backpressure.
const reportDiagnostic = (event, fields = {}) => {
  try { globalThis.videoPilotDiagnostics?.(event, fields); } catch {}
};
export class JSMpegHttpSource {
  streaming = false;
  established = false;
  completed = false;
  progress = 0;
  destination = null;
  controller = new AbortController();
  paused = false;
  buffered = false;
  headroom = 0;
  reportedSourceTime = null;
  wake = null;
  reader = null;
  started = false;
  destroyed = false;
  stopped = false;
  stoppedResolve;
  stoppedPromise;
  lastProgressReport = 0;
  lastBufferState = null;
  // Cellular links benefit from more media queued before the next relay pull.
  // The low-water mark remains finite so Pause and cancellation still release
  // the reader promptly instead of buffering the whole file.
  static highWaterHeadroom = 12;
  static lowWaterHeadroom = 6;
  constructor(url, options) {
    this.url = url; this.options = options || {};
    this.stoppedPromise = new Promise(resolve => { this.stoppedResolve = resolve; });
  }
  connect(destination) { this.destination = destination; }
  start() { if (!this.started) void this.read(); }
  // JSMpeg reports buffered playback seconds on every recorded-video frame.
  // Keep this separate from the user's Pause so a frame cannot undo a pause.
  resume(headroom) {
    if (!Number.isFinite(headroom)) return;
    this.headroom = Math.max(0, headroom);
    const time = this.destination?.currentTime;
    this.reportedSourceTime = Number.isFinite(time) ? time : null;
    this.updateBuffering(this.headroom);
  }
  updateBuffering(headroom) {
    if (headroom >= JSMpegHttpSource.highWaterHeadroom) this.buffered = true;
    else if (headroom <= JSMpegHttpSource.lowWaterHeadroom) this.buffered = false;
    if (this.lastBufferState !== this.buffered) {
      this.lastBufferState = this.buffered;
      reportDiagnostic('sourceBuffer', {bufferSeconds:headroom, buffered:this.buffered,
        headroomSeconds:headroom});
    }
    this.wakeReading();
  }
  // Several network chunks can arrive before the next animation frame. Account
  // for their PTS advance too, rather than waiting for the next resume report.
  updateReadAhead() {
    const time = this.destination?.currentTime;
    if (!Number.isFinite(time)) return;
    if (this.reportedSourceTime === null) this.reportedSourceTime = time;
    this.updateBuffering(this.headroom + Math.max(0, time - this.reportedSourceTime));
  }
  wakeReading() {
    if (this.controller.signal.aborted || (!this.paused && !this.buffered)) {
      const wake = this.wake; this.wake = null; wake?.();
    }
  }
  async waitForReading() {
    while (!this.controller.signal.aborted && (this.paused || this.buffered)) {
      await new Promise(resolve => { this.wake = resolve; });
    }
  }
  pauseReading() { if (!this.destroyed) this.paused = true; }
  resumeReading() { this.paused = false; this.wakeReading(); }
  destroy() {
    if (this.destroyed) return this.stoppedPromise;
    this.destroyed = true;
    this.paused = false; this.buffered = false; this.headroom = 0;
    this.controller.abort(); this.wakeReading(); this.destination = null;
    const reader = this.reader;
    if (reader) void reader.cancel().catch(() => {});
    if (!this.started) this.finishStop();
    return this.stoppedPromise;
  }
  finishStop() {
    if (this.stopped) return;
    this.stopped = true; this.stoppedResolve?.(); this.stoppedResolve = null;
  }
  async read() {
    if (this.started) return this.stoppedPromise;
    this.started = true;
    let reader;
    let received = 0;
    const startedAt = globalThis.performance?.now?.() ?? Date.now();
    try {
      const response = await fetch(this.url, {credentials:'same-origin',cache:'no-store',signal:this.controller.signal,
        headers:this.options.headers || undefined});
      if (this.destroyed) return;
      reportDiagnostic('sourceResponse', {responseStatus:response.status,
        expectedBytes:Number(response.headers.get('content-length')) || 0,
        elapsedMs:Math.round((globalThis.performance?.now?.() ?? Date.now()) - startedAt)});
      if (!response.ok) throw new Error(response.status === 401 ? 'Pair this browser again.' : `Video stream failed (HTTP ${response.status}).`);
      if (!response.body) throw new Error('This browser cannot read the video stream.');
      const seekTime = Number(response.headers.get('x-video-seek-time'));
      if (Number.isFinite(seekTime) && seekTime >= 0) this.options.onSourceStartTime?.(seekTime);
      const duration = Number(response.headers.get('x-video-duration'));
      if (Number.isFinite(duration) && duration > 0) this.options.onSourceDuration?.(duration);
      const expected = Number(response.headers.get('content-length'));
      reader = response.body.getReader();
      this.reader = reader;
      while (!this.controller.signal.aborted) {
        await this.waitForReading();
        if (this.controller.signal.aborted) break;
        const {value, done} = await reader.read();
        if (done) break;
        // A manual pause may arrive while a network read is in flight.
        await this.waitForReading();
        if (this.controller.signal.aborted) break;
        if (value?.byteLength) {
          if (!this.established) { this.established = true; this.options.onSourceEstablished?.(this); }
          received += value.byteLength; this.destination?.write(value.slice().buffer);
          const now = globalThis.performance?.now?.() ?? Date.now();
          if (now - this.lastProgressReport >= 1000) {
            this.lastProgressReport = now;
            reportDiagnostic('sourceProgress', {receivedBytes:received, expectedBytes:expected,
              elapsedMs:Math.round(now - startedAt), headroomSeconds:this.headroom});
          }
          this.updateReadAhead();
        }
      }
      if (!this.controller.signal.aborted) {
        if (!this.established) throw new Error('The server returned an empty video stream.');
        if (Number.isSafeInteger(expected) && expected > 0 && received !== expected)
          throw new Error('Video stream interrupted. Reconnect the iPhone and restart playback.');
        this.completed = true; this.progress = 1;
        reportDiagnostic('sourceCompleted', {receivedBytes:received, expectedBytes:expected,
          elapsedMs:Math.round((globalThis.performance?.now?.() ?? Date.now()) - startedAt)});
        this.options.onSourceCompleted?.(this);
      }
    } catch (error) {
      if (!this.controller.signal.aborted) {
        reportDiagnostic('playerError', {error:error.message || 'Unable to read video stream.',
          receivedBytes:received,
          elapsedMs:Math.round((globalThis.performance?.now?.() ?? Date.now()) - startedAt)});
        this.options.onSourceError?.(error.message || 'Unable to read video stream.');
      }
    } finally {
      if (this.reader === reader) this.reader = null;
      await reader?.cancel().catch(() => {});
      this.finishStop();
    }
  }
}
