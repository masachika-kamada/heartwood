/**
 * Inflate helpers built on the platform's `DecompressionStream`.
 *
 * Git stores every object as a zlib stream, so `"deflate"` (which includes the
 * zlib header/adler32 wrapper) is the right format — not `"deflate-raw"`.
 */

async function inflateCollect(data: Uint8Array): Promise<{ out: Uint8Array; failed: boolean }> {
  const stream = new DecompressionStream("deflate");
  const writer = stream.writable.getWriter();
  // Copy into a standalone buffer: the source may be a view onto a much larger
  // pack ArrayBuffer, and we must not hand the whole thing to the stream.
  const chunk = new Uint8Array(data.length);
  chunk.set(data);
  const pump = writer.write(chunk).then(() => writer.close());
  // A rejected write must not become an unhandled rejection when the read side
  // reports the same failure first.
  pump.catch(() => {});

  const chunks: Uint8Array[] = [];
  let total = 0;
  let failed = false;
  const reader = stream.readable.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const part = value as Uint8Array;
      chunks.push(part);
      total += part.length;
    }
    await pump;
  } catch {
    // Truncated or trailing-junk input. Whatever decoded before the failure is
    // still valid output; the caller decides whether it is enough.
    failed = true;
  }

  const out = new Uint8Array(total);
  let at = 0;
  for (const part of chunks) {
    out.set(part, at);
    at += part.length;
  }
  return { out, failed };
}

async function inflateExact(data: Uint8Array): Promise<Uint8Array> {
  const { out, failed } = await inflateCollect(data);
  if (failed) throw new Error("Failed to inflate a git object (corrupt zlib stream).");
  return out;
}

/** Inflate a complete zlib stream. */
export async function inflate(data: Uint8Array): Promise<Uint8Array> {
  return inflateExact(data);
}

/**
 * Inflate a zlib stream that begins at `offset` inside `data` and whose
 * compressed length is unknown (the packfile case).
 *
 * We cannot hand the stream the whole rest of the pack cheaply, and
 * `DecompressionStream` reports trailing garbage as an error — but it emits all
 * of the real output before doing so. So: feed a window, keep whatever decoded,
 * and accept it as soon as we have the `expectedSize` bytes the pack header
 * promised. If the window cut the compressed stream short we grow and retry.
 * Objects compress, so the first window nearly always suffices.
 */
export async function inflateAtMost(
  data: Uint8Array,
  offset: number,
  expectedSize: number,
): Promise<Uint8Array> {
  const remaining = data.length - offset;
  if (remaining <= 0) throw new Error("Pack object starts past the end of the file.");

  let window = Math.min(remaining, Math.max(1024, expectedSize + 64));

  for (;;) {
    const { out } = await inflateCollect(data.subarray(offset, offset + window));
    if (out.length >= expectedSize) {
      return out.length === expectedSize ? out : out.subarray(0, expectedSize);
    }
    if (window >= remaining) {
      throw new Error(
        `Failed to inflate a packed object: got ${out.length} of ${expectedSize} bytes.`,
      );
    }
    window = Math.min(remaining, window * 2);
  }
}
