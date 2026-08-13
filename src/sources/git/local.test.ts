import { describe, expect, it } from "vitest";

import {
  applyDelta,
  decodeOffsetVarint,
  decodeSizeVarint,
  parseLooseObject,
  parsePackIndex,
  readPackEntryHeader,
  toHex,
} from "./objects";
import { parseCommitObject, parseIdentity, parsePackedRefs } from "./local";
import { inflate, inflateAtMost } from "./zlib";

/* ------------------------------------------------------------------ *
 * Test helpers: the encoders git uses, so we can round-trip.
 * ------------------------------------------------------------------ */

/** Mirror of git's offset-varint encoder (see `sha1_file.c`). */
function encodeOffsetVarint(value: number): Uint8Array {
  const bytes = [value & 0x7f];
  let v = value;
  while ((v = Math.floor(v / 128)) > 0) {
    v -= 1;
    bytes.unshift(0x80 | (v & 0x7f));
  }
  return Uint8Array.from(bytes);
}

function encodeSizeVarint(value: number): number[] {
  const bytes: number[] = [];
  let v = value;
  do {
    let byte = v & 0x7f;
    v = Math.floor(v / 128);
    if (v > 0) byte |= 0x80;
    bytes.push(byte);
  } while (v > 0);
  return bytes;
}

type DeltaOp = { copy: [number, number] } | { insert: number[] };

function buildDelta(baseSize: number, resultSize: number, ops: readonly DeltaOp[]): Uint8Array {
  const out: number[] = [...encodeSizeVarint(baseSize), ...encodeSizeVarint(resultSize)];
  for (const op of ops) {
    if ("insert" in op) {
      out.push(op.insert.length, ...op.insert);
      continue;
    }
    const [offset, size] = op.copy;
    const offsetBytes: number[] = [];
    const sizeBytes: number[] = [];
    let flags = 0x80;
    for (let i = 0; i < 4; i++) {
      const b = Math.floor(offset / 256 ** i) & 0xff;
      if (b !== 0) {
        flags |= 1 << i;
        offsetBytes.push(b);
      }
    }
    const encodedSize = size === 0x10000 ? 0 : size;
    for (let i = 0; i < 3; i++) {
      const b = Math.floor(encodedSize / 256 ** i) & 0xff;
      if (b !== 0) {
        flags |= 0x10 << i;
        sizeBytes.push(b);
      }
    }
    out.push(flags, ...offsetBytes, ...sizeBytes);
  }
  return Uint8Array.from(out);
}

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new CompressionStream("deflate");
  const writer = stream.writable.getWriter();
  const copy = new Uint8Array(data.length);
  copy.set(data);
  void writer.write(copy).then(() => writer.close());
  const chunks: Uint8Array[] = [];
  const reader = stream.readable.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value as Uint8Array);
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Varints
 * ------------------------------------------------------------------ */

describe("decodeOffsetVarint", () => {
  it("matches known encodings", () => {
    expect(decodeOffsetVarint(Uint8Array.from([0x00]), 0)).toEqual({ value: 0, next: 1 });
    expect(decodeOffsetVarint(Uint8Array.from([0x7f]), 0)).toEqual({ value: 127, next: 1 });
    // The `+1` accumulation makes 0x80 0x00 mean 128, not 0.
    expect(decodeOffsetVarint(Uint8Array.from([0x80, 0x00]), 0)).toEqual({ value: 128, next: 2 });
    expect(decodeOffsetVarint(Uint8Array.from([0x80, 0x7f]), 0)).toEqual({ value: 255, next: 2 });
    expect(decodeOffsetVarint(Uint8Array.from([0x81, 0x00]), 0)).toEqual({ value: 256, next: 2 });
    expect(decodeOffsetVarint(Uint8Array.from([0x80, 0x80, 0x00]), 0)).toEqual({
      value: 16512,
      next: 3,
    });
  });

  it("round-trips git's encoder", () => {
    for (const value of [0, 1, 127, 128, 129, 255, 16511, 16512, 1_000_000, 123_456_789]) {
      const encoded = encodeOffsetVarint(value);
      expect(decodeOffsetVarint(encoded, 0)).toEqual({ value, next: encoded.length });
    }
  });

  it("respects the starting position", () => {
    const buffer = Uint8Array.from([0xaa, 0xbb, 0x80, 0x00]);
    expect(decodeOffsetVarint(buffer, 2)).toEqual({ value: 128, next: 4 });
  });

  it("throws on truncation", () => {
    expect(() => decodeOffsetVarint(Uint8Array.from([0x80]), 0)).toThrow(/Truncated/);
  });
});

describe("decodeSizeVarint", () => {
  it("decodes little-endian 7-bit groups", () => {
    expect(decodeSizeVarint(Uint8Array.from([0x05]), 0)).toEqual({ value: 5, next: 1 });
    expect(decodeSizeVarint(Uint8Array.from([0x80, 0x01]), 0)).toEqual({ value: 128, next: 2 });
    expect(decodeSizeVarint(Uint8Array.from([0xe5, 0x8e, 0x26]), 0)).toEqual({
      value: 624485,
      next: 3,
    });
  });

  it("round-trips large sizes", () => {
    for (const value of [0, 1, 127, 128, 65535, 1 << 20, 12_345_678]) {
      const encoded = Uint8Array.from(encodeSizeVarint(value));
      expect(decodeSizeVarint(encoded, 0).value).toBe(value);
    }
  });
});

describe("readPackEntryHeader", () => {
  it("reads a single-byte header", () => {
    // 0b0011_0101 => type 3 (blob), size 5.
    expect(readPackEntryHeader(Uint8Array.from([0x35]), 0)).toEqual({
      type: 3,
      size: 5,
      next: 1,
    });
  });

  it("accumulates size across continuation bytes", () => {
    // type 1 (commit), size = 12 | (2 << 4) = 44.
    expect(readPackEntryHeader(Uint8Array.from([0x9c, 0x02]), 0)).toEqual({
      type: 1,
      size: 12 + 2 * 16,
      next: 2,
    });
    // type 6 (ofs-delta), size = 15 | (0x7f << 4) | (1 << 11).
    expect(readPackEntryHeader(Uint8Array.from([0xef, 0xff, 0x01]), 0)).toEqual({
      type: 6,
      size: 15 + 0x7f * 16 + 1 * 2048,
      next: 3,
    });
  });
});

/* ------------------------------------------------------------------ *
 * Delta application
 * ------------------------------------------------------------------ */

describe("applyDelta", () => {
  const base = bytes("the quick brown fox jumps over the lazy dog");

  it("applies a pure copy", () => {
    const delta = buildDelta(base.length, base.length, [{ copy: [0, base.length] }]);
    expect(new TextDecoder().decode(applyDelta(base, delta))).toBe(
      "the quick brown fox jumps over the lazy dog",
    );
  });

  it("mixes copies and literal inserts", () => {
    const inserted = [...bytes("red ")];
    const result = "the quick red fox jumps over the lazy dog";
    const delta = buildDelta(base.length, result.length, [
      { copy: [0, 10] }, // "the quick "
      { insert: inserted },
      { copy: [16, base.length - 16] }, // "fox jumps over the lazy dog"
    ]);
    expect(new TextDecoder().decode(applyDelta(base, delta))).toBe(result);
  });

  it("treats a zero copy size as 0x10000", () => {
    const bigBase = new Uint8Array(0x10000);
    for (let i = 0; i < bigBase.length; i++) bigBase[i] = i & 0xff;
    // Encoded with no size bytes at all: flags carry only the offset.
    const delta = Uint8Array.from([...encodeSizeVarint(0x10000), ...encodeSizeVarint(0x10000), 0x80]);
    expect(applyDelta(bigBase, delta)).toEqual(bigBase);
  });

  it("handles multi-byte copy offsets", () => {
    const bigBase = new Uint8Array(70000);
    bigBase.fill(7);
    bigBase.set(bytes("marker"), 65600);
    const delta = buildDelta(bigBase.length, 6, [{ copy: [65600, 6] }]);
    expect(new TextDecoder().decode(applyDelta(bigBase, delta))).toBe("marker");
  });

  it("chains deltas the way a packfile does", () => {
    const step1 = buildDelta(base.length, 9, [{ copy: [4, 5] }, { insert: [...bytes("!!!!")] }]);
    const mid = applyDelta(base, step1);
    expect(new TextDecoder().decode(mid)).toBe("quick!!!!");
    const step2 = buildDelta(mid.length, 14, [
      { insert: [...bytes("very ")] },
      { copy: [0, 9] },
    ]);
    expect(new TextDecoder().decode(applyDelta(mid, step2))).toBe("very quick!!!!");
  });

  it("rejects a base of the wrong size", () => {
    const delta = buildDelta(base.length + 1, 1, [{ copy: [0, 1] }]);
    expect(() => applyDelta(base, delta)).toThrow(/base size mismatch/i);
  });

  it("rejects a truncated result", () => {
    const delta = buildDelta(base.length, base.length, [{ copy: [0, 5] }]);
    expect(() => applyDelta(base, delta)).toThrow(/expected/);
  });

  it("rejects opcode 0", () => {
    const delta = Uint8Array.from([...encodeSizeVarint(base.length), ...encodeSizeVarint(1), 0x00]);
    expect(() => applyDelta(base, delta)).toThrow(/opcode 0/);
  });
});

/* ------------------------------------------------------------------ *
 * Pack index
 * ------------------------------------------------------------------ */

function shaBytes(seed: number): Uint8Array {
  const out = new Uint8Array(20);
  for (let i = 0; i < 20; i++) out[i] = (seed + i) & 0xff;
  return out;
}

describe("parsePackIndex", () => {
  it("reads a version 2 index, including a large offset", () => {
    const count = 2;
    const size = 8 + 1024 + count * 20 + count * 4 + count * 4 + 8;
    const buffer = new Uint8Array(size);
    const view = new DataView(buffer.buffer);
    buffer.set([0xff, 0x74, 0x4f, 0x63], 0);
    view.setUint32(4, 2, false);
    for (let i = 0; i < 256; i++) view.setUint32(8 + i * 4, count, false);

    const shaAt = 8 + 1024;
    buffer.set(shaBytes(0), shaAt);
    buffer.set(shaBytes(100), shaAt + 20);
    const offsetAt = shaAt + count * 20 + count * 4;
    view.setUint32(offsetAt, 12, false);
    view.setUint32(offsetAt + 4, 0x80000000, false); // large-offset slot 0
    const largeAt = offsetAt + count * 4;
    view.setUint32(largeAt, 1, false); // high word
    view.setUint32(largeAt + 4, 5, false); // low word

    const index = parsePackIndex(buffer);
    expect(index.offsets.get(toHex(shaBytes(0)))).toBe(12);
    expect(index.offsets.get(toHex(shaBytes(100)))).toBe(0x100000000 + 5);
  });

  it("reads a version 1 index", () => {
    const count = 2;
    const buffer = new Uint8Array(1024 + count * 24);
    const view = new DataView(buffer.buffer);
    for (let i = 0; i < 256; i++) view.setUint32(i * 4, count, false);
    view.setUint32(1024, 42, false);
    buffer.set(shaBytes(3), 1028);
    view.setUint32(1048, 4242, false);
    buffer.set(shaBytes(9), 1052);

    const index = parsePackIndex(buffer);
    expect(index.offsets.get(toHex(shaBytes(3)))).toBe(42);
    expect(index.offsets.get(toHex(shaBytes(9)))).toBe(4242);
  });
});

describe("parseLooseObject", () => {
  it("splits the header from the payload", () => {
    const raw = new Uint8Array([...bytes("commit 5\0"), ...bytes("hello")]);
    const object = parseLooseObject(raw);
    expect(object.type).toBe("commit");
    expect(new TextDecoder().decode(object.data)).toBe("hello");
  });

  it("rejects an unknown type", () => {
    expect(() => parseLooseObject(new Uint8Array([...bytes("widget 1\0"), 65]))).toThrow(
      /Unknown loose object type/,
    );
  });
});

/* ------------------------------------------------------------------ *
 * zlib
 * ------------------------------------------------------------------ */

describe("inflate", () => {
  it("round-trips a deflated buffer", async () => {
    const payload = bytes("commit 12\0hello world");
    expect(await inflate(await deflate(payload))).toEqual(payload);
  });

  it("inflates from an offset with unknown compressed length", async () => {
    const payload = bytes("x".repeat(3000) + "tail");
    const compressed = await deflate(payload);
    const framed = new Uint8Array(16 + compressed.length + 64);
    framed.set(compressed, 16);
    framed.fill(0xab, 16 + compressed.length); // trailing garbage, as in a pack
    const out = await inflateAtMost(framed, 16, payload.length);
    expect(out.length).toBe(payload.length);
    expect(out).toEqual(payload);
  });

  it("inflates incompressible data followed by another object", async () => {
    const payload = new Uint8Array(5000);
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 2654435761) & 0xff;
    const first = await deflate(payload);
    const second = await deflate(bytes("the next pack entry"));
    const framed = new Uint8Array(first.length + second.length);
    framed.set(first, 0);
    framed.set(second, first.length);
    expect(await inflateAtMost(framed, 0, payload.length)).toEqual(payload);
  });
});

/* ------------------------------------------------------------------ *
 * Commit parsing
 * ------------------------------------------------------------------ */

describe("parseIdentity", () => {
  it("takes the last angle-bracket pair as the email", () => {
    const id = parseIdentity("Weird <Name> <weird@example.com> 1700000000 +0200");
    expect(id.name).toBe("Weird <Name>");
    expect(id.email).toBe("weird@example.com");
    expect(id.tzOffsetMinutes).toBe(120);
  });

  it("degrades gracefully on garbage", () => {
    expect(parseIdentity("nonsense")).toEqual({
      name: "",
      email: "",
      timestampMs: 0,
      tzOffsetMinutes: 0,
    });
  });
});

describe("parseCommitObject", () => {
  it("parses a merge commit with a negative timezone and a multi-line message", () => {
    const text = [
      "tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904",
      "parent 1111111111111111111111111111111111111111",
      "parent 2222222222222222222222222222222222222222",
      "author Ada Lovelace <ada@example.com> 1700000000 -0430",
      "committer Someone Else <else@example.com> 1700000500 +0000",
      "",
      "Merge branch 'feature'  ",
      "",
      "Body line one.",
      "Body line two.",
      "",
    ].join("\n");

    const commit = parseCommitObject("abc123", bytes(text));
    expect(commit.parents).toEqual([
      "1111111111111111111111111111111111111111",
      "2222222222222222222222222222222222222222",
    ]);
    expect(commit.authorName).toBe("Ada Lovelace");
    expect(commit.authorEmail).toBe("ada@example.com");
    expect(commit.timestampMs).toBe(1_700_000_000_000);
    expect(commit.tzOffsetMinutes).toBe(-270);
    expect(commit.summary).toBe("Merge branch 'feature'");
    expect(commit.insertions).toBeNull();
    expect(commit.deletions).toBeNull();
    expect(commit.sha).toBe("abc123");
  });

  it("handles a root commit with no parents and a single-line message", () => {
    const text = [
      "tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904",
      "author Ada <ada@example.com> 1000000000 +0900",
      "committer Ada <ada@example.com> 1000000000 +0900",
      "",
      "Initial commit",
    ].join("\n");
    const commit = parseCommitObject("f".repeat(40), bytes(text));
    expect(commit.parents).toEqual([]);
    expect(commit.summary).toBe("Initial commit");
    expect(commit.tzOffsetMinutes).toBe(540);
  });

  it("skips gpgsig continuation lines", () => {
    const text = [
      "tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904",
      "parent 3333333333333333333333333333333333333333",
      "gpgsig -----BEGIN PGP SIGNATURE-----",
      " ",
      " parent 9999999999999999999999999999999999999999",
      " -----END PGP SIGNATURE-----",
      "author Ada <ada@example.com> 1200000000 +0100",
      "",
      "Signed work",
    ].join("\n");
    const commit = parseCommitObject("deadbeef", bytes(text));
    expect(commit.parents).toEqual(["3333333333333333333333333333333333333333"]);
    expect(commit.summary).toBe("Signed work");
  });

  it("lets a commit with a garbled author through", () => {
    const text = ["tree abc", "author ???", "", "Broken but readable"].join("\n");
    const commit = parseCommitObject("0".repeat(40), bytes(text));
    expect(commit.authorName).toBe("");
    expect(commit.authorEmail).toBe("");
    expect(commit.timestampMs).toBe(0);
    expect(commit.summary).toBe("Broken but readable");
  });

  it("decodes UTF-8 names and summaries", () => {
    const text = [
      "tree abc",
      "author 山田太郎 <yamada@example.jp> 1600000000 +0900",
      "",
      "初期コミット",
    ].join("\n");
    const commit = parseCommitObject("1".repeat(40), bytes(text));
    expect(commit.authorName).toBe("山田太郎");
    expect(commit.summary).toBe("初期コミット");
  });

  it("survives a commit with no message at all", () => {
    const text = "tree abc\nauthor Ada <ada@example.com> 1600000000 +0000\n";
    const commit = parseCommitObject("2".repeat(40), bytes(text));
    expect(commit.summary).toBe("");
    expect(commit.timestampMs).toBe(1_600_000_000_000);
  });
});

describe("parsePackedRefs", () => {
  it("reads refs and skips comments and peeled lines", () => {
    const text = [
      "# pack-refs with: peeled fully-peeled sorted",
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa refs/heads/main",
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb refs/tags/v1.0",
      "^cccccccccccccccccccccccccccccccccccccccc",
      "",
    ].join("\n");
    const refs = parsePackedRefs(text);
    expect(refs.get("refs/heads/main")).toBe("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(refs.get("refs/tags/v1.0")).toBe("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    expect(refs.size).toBe(2);
  });
});
