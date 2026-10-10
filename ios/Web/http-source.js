// Same recorded-stream transport as MK8's JSMpegHttpSource, with pause backpressure.
const reportDiagnostic = (event, fields = {}) => {
  try { globalThis.videoPilotDiagnostics?.(event, fields); } catch {}
};

// Recorded JSMpeg playback needs its PTS table: it establishes the timebase
// after a remote seek and lets Pause rewind the small WebAudio scheduling
// lead. EVICT may discard unread frames; EXPAND alone retains the whole file.
// Keep EXPAND, but move only consumed data out of the window before writes.
export function installRecordedBufferWindow(decoder, maximumBytes = 16 * 1024 * 1024) {
  if (!decoder?.bits || typeof decoder.write !== 'function' || decoder.bufferWindowInstalled) return;
  decoder.bufferWindowInstalled = true;
  const write = decoder.write;
  decoder.write = function(pts, buffers) {
    const bits = this.bits;
    const incoming = Array.isArray(buffers)
      ? buffers.reduce((total, buffer) => total + buffer.byteLength, 0) : buffers.byteLength;
    const timestamps = this.timestamps;
    // Retain a second behind the audible clock. Pause can rewind about 250ms
    // of scheduled audio, so discarding everything behind bits.index loses
    // the samples that need to be played again after Resume.
    const retainFrom = Number(this.currentTime) - 1;
    let anchor = 0;
    if (Array.isArray(timestamps)) {
      for (let i = 1; i < timestamps.length; i++) {
        if (timestamps[i].time > retainFrom || timestamps[i].index > bits.index) break;
        anchor = i;
      }
    }
    const bytesToRemove = Math.max(0, (timestamps?.[anchor]?.index || 0) >> 3);
    if (bytesToRemove >= 64 * 1024 || (bytesToRemove && bits.byteLength + incoming > bits.bytes.length)) {
      bits.bytes.copyWithin(0, bytesToRemove, bits.byteLength);
      bits.byteLength -= bytesToRemove;
      bits.index -= bytesToRemove * 8;
      this.bytesWritten -= bytesToRemove;
      timestamps.splice(0, anchor);
      for (const timestamp of timestamps) timestamp.index -= bytesToRemove * 8;
      this.timestampIndex = Math.max(0, this.timestampIndex - anchor);
    }
    if (bits.byteLength + incoming > maximumBytes) {
      throw new Error('Playback buffer reached its safe limit. Tap Retry.');
    }
    // The shipped BitBuffer's growth calculation can underallocate for a
    // single large PES. Reserve the full required size ourselves, capped.
    if (bits.byteLength + incoming > bits.bytes.length) {
      bits.resize(Math.min(maximumBytes, Math.max(bits.bytes.length * 2, bits.byteLength + incoming)));
    }
    return write.call(this, pts, buffers);
  };
}

// JSMpeg.stop() only mutes queued sources. Those sources keep running, and a
// quick Resume/Unmute can expose an old tail underneath newly queued audio.
// Track and cancel the short scheduling lead, then reset its clock on Stop.
export function installRecordedAudioOutput(output, now) {
  if (!output?.context?.createBufferSource || output.recordedSources) return;
  const sources = output.recordedSources = new Set();
  const destroy = output.destroy;
  // A chunk scheduled after the previous one already finished leaves a gap,
  // which is audible as a click. Count them so the log shows real crackle.
  output.underruns = 0; output.underrunMs = 0; output.lastUnderrunReport = 0; output.scheduled = false;
  output.play = function(sampleRate, left, right) {
    if (!this.enabled) return;
    if (!this.unlocked) {
      this.wallclockStartTime = Math.max(this.wallclockStartTime, now()) + left.length / sampleRate;
      return;
    }
    this.gain.gain.value = this.volume;
    const buffer = this.context.createBuffer(2, left.length, sampleRate);
    buffer.getChannelData(0).set(left); buffer.getChannelData(1).set(right);
    const source = this.context.createBufferSource();
    source.buffer = buffer; source.connect(this.destination);
    if (this.startTime < this.context.currentTime) {
      if (this.scheduled) {
        this.underruns += 1; this.underrunMs += (this.context.currentTime - this.startTime) * 1000;
        const at = now();
        if (at - this.lastUnderrunReport >= 2) {
          this.lastUnderrunReport = at;
          reportDiagnostic('audioUnderrun', {underruns:this.underruns, gapMs:Math.round(this.underrunMs)});
        }
      }
      this.startTime = this.context.currentTime; this.wallclockStartTime = now();
    }
    this.scheduled = true;
    sources.add(source);
    source.onended = () => { sources.delete(source); try { source.disconnect(); } catch {} };
    source.start(this.startTime);
    this.startTime += buffer.duration; this.wallclockStartTime += buffer.duration;
  };
  output.stop = function() {
    for (const source of sources) {
      source.onended = null;
      try { source.stop(); } catch {}
      try { source.disconnect(); } catch {}
    }
    sources.clear();
    this.scheduled = false;
    this.startTime = this.context.currentTime; this.wallclockStartTime = now();
    this.gain.gain.value = 0;
  };
  output.destroy = function() { this.stop(); return destroy?.call(this); };
}

// JSMpeg decodes recorded audio only 0.25 s ahead of the speaker. A Tesla
// browser busy decoding video for longer than that starves WebAudio and every
// gap clicks. Same loop as Player.updateForStaticFile, with a deeper lead.
// Pause, seek and volume changes are unaffected: pause rewinds by seeking to
// the audible position and volume is applied on the shared gain node.
export function installRecordedAudioLead(player, lead = 0.75) {
  if (!player || typeof player.updateForStaticFile !== 'function' || player.recordedAudioLead) return;
  player.recordedAudioLead = lead;
  const update = player.updateForStaticFile;
  player.updateForStaticFile = function() {
    if (!this.audio?.canPlay) return update.call(this);
    let notEnoughData = false;
    while (!notEnoughData && this.audio.decodedTime - this.audio.currentTime < lead) notEnoughData = !this.audio.decode();
    if (this.video && this.video.currentTime < this.audio.currentTime) notEnoughData = !this.video.decode();
    this.source.resume(this.demuxer.currentTime - this.audio.currentTime);
    if (notEnoughData && this.source.completed) {
      if (this.loop) this.seek(0);
      else { this.pause(); this.options.onEnded?.(this); }
    } else if (notEnoughData) this.options.onStalled?.(this);
  };
}

// The shipped Player pauses by stopping output and then reading currentTime.
// Canceling the output queue resets its clock, so capture the audible position
// first and restore that position after its normal pause bookkeeping.
export function installRecordedPlayerPause(player) {
  if (!player || typeof player.pause !== 'function' || player.recordedPauseInstalled) return;
  player.recordedPauseInstalled = true;
  const pause = player.pause;
  player.pause = function(...args) {
    const rewind = !this.paused && this.audio?.canPlay;
    const position = this.currentTime;
    const result = pause.apply(this, args);
    if (rewind && Number.isFinite(position)) this.seek(position);
    return result;
  };
}

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
  // Keep enough media queued to absorb cellular/Cloudflare jitter. The
  // previous 8/3-second gate made 5G playback underrun and crackle; this
  // 12/6-second hysteresis is still bounded and is released on Pause/seek.
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
    if (!this.hasPlaybackClock()) return;
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
    if (!this.hasPlaybackClock()) return;
    const time = this.destination?.currentTime;
    if (!Number.isFinite(time)) return;
    if (this.reportedSourceTime === null) this.reportedSourceTime = time;
    this.updateBuffering(this.headroom + Math.max(0, time - this.reportedSourceTime));
  }
  hasPlaybackClock() {
    const packets = this.destination?.pesPacketInfo;
    // A fragmented PAT/PES header can expose a large absolute seek PTS before
    // any decoder has its timestamp baseline. Do not call that buffered media.
    return !packets || Object.values(packets).some(packet => packet.destination?.canPlay);
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
      const seekHeader = response.headers.get('x-video-seek-time');
      const seekTime = Number(seekHeader);
      if (seekHeader !== null && Number.isFinite(seekTime) && seekTime >= 0) this.options.onSourceStartTime?.(seekTime);
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
