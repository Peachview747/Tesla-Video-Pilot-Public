type Destination = { write(data: ArrayBuffer): void };
type SourceOptions = {
  onSourceEstablished?: (source: JSMpegHttpSource) => void;
  onSourceCompleted?: (source: JSMpegHttpSource) => void;
  onSourceError?: (message: string) => void;
};

/** Read the generated MPEG-TS response as chunks, without HEAD/Range requests. */
export class JSMpegHttpSource {
  // Recorded videos need JSMpeg's timestamp, pause, and end-of-file handling.
  // The HTTP transport still feeds chunks before the response is complete.
  readonly streaming = false;
  established = false;
  completed = false;
  progress = 0;
  private destination: Destination | null = null;
  private readonly controller = new AbortController();

  constructor(
    private readonly url: string,
    private readonly options: SourceOptions,
  ) {}

  connect(destination: Destination) {
    this.destination = destination;
  }
  start() {
    void this.read();
  }
  resume() {}
  destroy() {
    this.controller.abort();
  }

  private async read() {
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await fetch(this.url, {
        credentials: "same-origin",
        cache: "no-store",
        signal: this.controller.signal,
      });
      if (!response.ok)
        throw new Error(
          response.status === 401
            ? "Your session expired. Sign in again."
            : `Video stream failed (HTTP ${response.status}).`,
        );
      if (!response.body)
        throw new Error("This browser cannot read the video stream.");
      reader = response.body.getReader();
      while (!this.controller.signal.aborted) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!this.established) {
          this.established = true;
          this.options.onSourceEstablished?.(this);
        }
        if (value?.byteLength) this.destination?.write(value.slice().buffer);
      }
      if (!this.controller.signal.aborted) {
        if (!this.established)
          throw new Error("The server returned an empty video stream.");
        this.completed = true;
        this.progress = 1;
        this.options.onSourceCompleted?.(this);
      }
    } catch (error) {
      if (!this.controller.signal.aborted) {
        this.options.onSourceError?.(
          error instanceof Error
            ? error.message
            : "Unable to load the video stream.",
        );
      }
    } finally {
      await reader?.cancel().catch(() => {});
    }
  }
}
