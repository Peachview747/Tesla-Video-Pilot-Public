import { afterEach, describe, expect, it, vi } from "vitest";
import { JSMpegHttpSource } from "../client/src/lib/jsmpeg-http-source";

afterEach(() => vi.unstubAllGlobals());

describe("recorded video HTTP source", () => {
  it("delivers chunks before EOF without asking for HEAD or byte ranges", async () => {
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response(body));
    vi.stubGlobal("fetch", fetchMock);
    const write = vi.fn();
    const completed = vi.fn();
    const source = new JSMpegHttpSource("/api/stream/12.ts", {
      onSourceCompleted: completed,
    });
    source.connect({ write });
    source.start();
    streamController.enqueue(new Uint8Array([1, 2, 3]));
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    expect(Array.from(new Uint8Array(write.mock.calls[0][0]))).toEqual([
      1, 2, 3,
    ]);
    expect(source.completed).toBe(false);
    expect(fetchMock.mock.calls[0][1].headers).toBeUndefined();
    expect(fetchMock.mock.calls[0][1].method).toBeUndefined();
    streamController.enqueue(new Uint8Array([4, 5]));
    streamController.close();
    await vi.waitFor(() => expect(completed).toHaveBeenCalledOnce());
    expect(write).toHaveBeenCalledTimes(2);
    expect(source.streaming).toBe(false);
  });

  it("shows an authentication error instead of leaving the loading spinner running", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(new Response("login required", { status: 401 })),
    );
    const error = vi.fn();
    const source = new JSMpegHttpSource("/api/stream/12.ts", {
      onSourceError: error,
    });
    source.start();
    await vi.waitFor(() =>
      expect(error).toHaveBeenCalledWith(
        "Your session expired. Sign in again.",
      ),
    );
    expect(source.established).toBe(false);
  });

  it("aborts an active request when the player closes without showing a failure", async () => {
    let signal!: AbortSignal;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_url, options) => {
        signal = options.signal;
        return new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          ),
        );
      }),
    );
    const error = vi.fn();
    const source = new JSMpegHttpSource("/api/stream/12.ts", {
      onSourceError: error,
    });
    source.start();
    source.destroy();
    await Promise.resolve();
    expect(signal.aborted).toBe(true);
    expect(error).not.toHaveBeenCalled();
    expect(source.completed).toBe(false);
  });

  it("reports an empty successful response as an unusable video", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(new Uint8Array())),
    );
    const error = vi.fn();
    new JSMpegHttpSource("/api/stream/12.ts", { onSourceError: error }).start();
    await vi.waitFor(() =>
      expect(error).toHaveBeenCalledWith(
        "The server returned an empty video stream.",
      ),
    );
  });
});
