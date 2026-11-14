/**
 * Stream helpers. Nothing here buffers a whole body.
 */

/**
 * Returns a stream of `length` bytes of `source`, starting at byte `start`.
 * Bytes before `start` are read and dropped; once `length` bytes are out,
 * the source is cancelled so nothing more is read.
 */
export function sliceStream(source: ReadableStream, start: number, length: number): ReadableStream<Uint8Array> {
  const reader = source.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  let skip = start;
  let remaining = length;
  return new ReadableStream<Uint8Array>({
    async pull(controller): Promise<void> {
      for (;;) {
        if (remaining <= 0) {
          controller.close();
          await reader.cancel().catch(() => undefined);
          return;
        }
        const { done, value } = await reader.read();
        if (done) {
          controller.error(new Error("source ended before the requested range"));
          return;
        }
        let chunk = value;
        if (skip > 0) {
          if (chunk.byteLength <= skip) {
            skip -= chunk.byteLength;
            continue;
          }
          chunk = chunk.subarray(skip);
          skip = 0;
        }
        if (chunk.byteLength > remaining) {
          chunk = chunk.subarray(0, remaining);
        }
        remaining -= chunk.byteLength;
        controller.enqueue(chunk);
        return;
      }
    },
    async cancel(reason): Promise<void> {
      await reader.cancel(reason);
    },
  });
}

/**
 * Pipes a stream through a `FixedLengthStream`, so the runtime sends a
 * `content-length` and fails the response if the byte count is wrong.
 */
export function withLength(source: ReadableStream, length: number): ReadableStream<Uint8Array> {
  const fixed = new FixedLengthStream(length);
  source.pipeTo(fixed.writable).catch(() => {
    // The readable side reports the failure to whoever consumes it.
  });
  return fixed.readable;
}

/** Cancels a body we decided not to send, ignoring errors. */
export async function discard(body: ReadableStream | null | undefined): Promise<void> {
  if (body !== null && body !== undefined) {
    await body.cancel().catch(() => undefined);
  }
}
