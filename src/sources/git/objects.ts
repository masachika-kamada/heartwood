/**
 * Loose object and packfile reading for a browser-side `.git` reader.
 *
 * Nothing here touches the network. The only I/O is `FileSystemFileHandle`
 * reads of files inside the `.git` directory the user picked.
 */

import { inflate, inflateAtMost } from "./zlib";

export type GitObjectType = "commit" | "tree" | "blob" | "tag";

export interface RawObject {
  readonly type: GitObjectType;
  readonly data: Uint8Array;
}

const TYPE_BY_ID: Record<number, GitObjectType> = {
  1: "commit",
  2: "tree",
  3: "blob",
  4: "tag",
};

const OFS_DELTA = 6;
const REF_DELTA = 7;

const HEX = "0123456789abcdef";

export function toHex(bytes: Uint8Array, start = 0, length = bytes.length - start): string {
  let out = "";
  for (let i = start; i < start + length; i++) {
    const b = bytes[i]!;
    out += HEX[b >> 4]! + HEX[b & 0x0f]!;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Varints
 * ------------------------------------------------------------------ */

export interface VarintResult {
  readonly value: number;
  /** Index of the first byte after the varint. */
  readonly next: number;
}

/**
 * The "offset varint" used by ofs-delta entries and by pack index v2's large
 * offsets. Note the `+1` accumulation: each continuation byte first bumps the
 * running value so that encodings of different lengths never overlap.
 */
export function decodeOffsetVarint(data: Uint8Array, pos: number): VarintResult {
  let at = pos;
  let c = data[at++];
  if (c === undefined) throw new Error("Truncated offset varint in packfile.");
  let value = c & 0x7f;
  while (c & 0x80) {
    c = data[at++];
    if (c === undefined) throw new Error("Truncated offset varint in packfile.");
    value = (value + 1) * 0x80 + (c & 0x7f);
  }
  return { value, next: at };
}

/** The plain little-endian 7-bits-per-byte varint used for delta sizes. */
export function decodeSizeVarint(data: Uint8Array, pos: number): VarintResult {
  let at = pos;
  let value = 0;
  let shift = 0;
  for (;;) {
    const c = data[at++];
    if (c === undefined) throw new Error("Truncated size varint in delta.");
    value += (c & 0x7f) * 2 ** shift;
    if ((c & 0x80) === 0) break;
    shift += 7;
  }
  return { value, next: at };
}

export interface PackEntryHeader {
  /** Raw git type id: 1..4 for plain objects, 6 ofs-delta, 7 ref-delta. */
  readonly type: number;
  /** Inflated size of the entry payload (the delta itself, for deltas). */
  readonly size: number;
  readonly next: number;
}

/**
 * Pack entry header. The first byte carries the type in bits 4-6 and the low
 * four bits of the size; every continuation byte adds seven more size bits.
 */
export function readPackEntryHeader(data: Uint8Array, pos: number): PackEntryHeader {
  let at = pos;
  let c = data[at++];
  if (c === undefined) throw new Error("Truncated pack entry header.");
  const type = (c >> 4) & 0x07;
  let size = c & 0x0f;
  let shift = 4;
  while (c & 0x80) {
    c = data[at++];
    if (c === undefined) throw new Error("Truncated pack entry header.");
    size += (c & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { type, size, next: at };
}

/* ------------------------------------------------------------------ *
 * Delta application
 * ------------------------------------------------------------------ */

/**
 * Apply a git delta buffer to a base object.
 *
 * Layout: base-size varint, result-size varint, then instructions.
 *  - byte & 0x80: copy from base. Bits 0-3 flag which of four offset bytes are
 *    present, bits 4-6 which of three size bytes; both little-endian, absent
 *    bytes are zero. A resulting size of 0 means 0x10000.
 *  - otherwise: the byte is a literal run length (1..127); that many bytes
 *    follow and are appended verbatim. A length of 0 is invalid.
 */
export function applyDelta(base: Uint8Array, delta: Uint8Array): Uint8Array {
  let at = 0;
  const baseSize = decodeSizeVarint(delta, at);
  at = baseSize.next;
  const resultSize = decodeSizeVarint(delta, at);
  at = resultSize.next;

  if (baseSize.value !== base.length) {
    throw new Error(
      `Delta base size mismatch (expected ${baseSize.value}, got ${base.length}).`,
    );
  }

  const out = new Uint8Array(resultSize.value);
  let written = 0;

  while (at < delta.length) {
    const op = delta[at++]!;
    if (op & 0x80) {
      let offset = 0;
      if (op & 0x01) offset |= delta[at++]!;
      if (op & 0x02) offset |= delta[at++]! << 8;
      if (op & 0x04) offset |= delta[at++]! << 16;
      // The fourth byte can push past 2^31, so multiply rather than shift.
      if (op & 0x08) offset += delta[at++]! * 0x1000000;

      let size = 0;
      if (op & 0x10) size |= delta[at++]!;
      if (op & 0x20) size |= delta[at++]! << 8;
      if (op & 0x40) size |= delta[at++]! << 16;
      if (size === 0) size = 0x10000;

      if (offset + size > base.length) throw new Error("Delta copy runs past the base object.");
      if (written + size > out.length) throw new Error("Delta copy overflows the result.");
      out.set(base.subarray(offset, offset + size), written);
      written += size;
    } else if (op > 0) {
      if (at + op > delta.length) throw new Error("Delta literal runs past the delta buffer.");
      if (written + op > out.length) throw new Error("Delta literal overflows the result.");
      out.set(delta.subarray(at, at + op), written);
      written += op;
      at += op;
    } else {
      throw new Error("Invalid delta opcode 0.");
    }
  }

  if (written !== out.length) {
    throw new Error(`Delta produced ${written} bytes, expected ${out.length}.`);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Pack index
 * ------------------------------------------------------------------ */

export interface PackIndex {
  /** Object sha (lowercase hex) to byte offset inside the `.pack` file. */
  readonly offsets: ReadonlyMap<string, number>;
}

/** Parse a `.idx` file, version 1 or 2. */
export function parsePackIndex(buffer: Uint8Array): PackIndex {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const isV2 =
    buffer.length > 8 &&
    buffer[0] === 0xff &&
    buffer[1] === 0x74 &&
    buffer[2] === 0x4f &&
    buffer[3] === 0x63;

  const offsets = new Map<string, number>();

  if (!isV2) {
    // Version 1: fanout, then n × (4-byte offset, 20-byte sha).
    const count = view.getUint32(255 * 4, false);
    let at = 256 * 4;
    for (let i = 0; i < count; i++) {
      const offset = view.getUint32(at, false);
      offsets.set(toHex(buffer, at + 4, 20), offset);
      at += 24;
    }
    return { offsets };
  }

  const version = view.getUint32(4, false);
  if (version !== 2) throw new Error(`Unsupported pack index version ${version}.`);

  const fanoutAt = 8;
  const count = view.getUint32(fanoutAt + 255 * 4, false);
  const shaAt = fanoutAt + 256 * 4;
  const crcAt = shaAt + count * 20;
  const offsetAt = crcAt + count * 4;
  const largeAt = offsetAt + count * 4;

  for (let i = 0; i < count; i++) {
    const raw = view.getUint32(offsetAt + i * 4, false);
    let offset: number;
    if (raw & 0x80000000) {
      // High bit set: the low 31 bits index the 8-byte large-offset table.
      const slot = raw & 0x7fffffff;
      const hi = view.getUint32(largeAt + slot * 8, false);
      const lo = view.getUint32(largeAt + slot * 8 + 4, false);
      offset = hi * 0x100000000 + lo;
    } else {
      offset = raw;
    }
    offsets.set(toHex(buffer, shaAt + i * 20, 20), offset);
  }

  return { offsets };
}

/* ------------------------------------------------------------------ *
 * Object store
 * ------------------------------------------------------------------ */

interface LoadedPack {
  readonly name: string;
  readonly data: Uint8Array;
  readonly index: PackIndex;
}

/** One link of an unresolved delta chain, innermost last. */
interface DeltaLink {
  readonly pack: LoadedPack;
  readonly delta: Uint8Array;
}

const MAX_CACHE_ENTRIES = 2000;

/**
 * Reads objects out of a `.git` directory: loose objects first, then any
 * packfile that claims the sha. Packs are read into memory once.
 */
export class GitObjectStore {
  private readonly gitDir: FileSystemDirectoryHandle;
  private readonly packs: LoadedPack[] = [];
  /** Bounded, insertion-ordered LRU-ish cache of resolved payloads. */
  private readonly cache = new Map<string, RawObject>();

  private constructor(gitDir: FileSystemDirectoryHandle) {
    this.gitDir = gitDir;
  }

  static async open(gitDir: FileSystemDirectoryHandle): Promise<GitObjectStore> {
    const store = new GitObjectStore(gitDir);
    await store.loadPacks();
    return store;
  }

  get packCount(): number {
    return this.packs.length;
  }

  private async loadPacks(): Promise<void> {
    let packDir: FileSystemDirectoryHandle;
    try {
      const objects = await this.gitDir.getDirectoryHandle("objects");
      packDir = await objects.getDirectoryHandle("pack");
    } catch {
      return; // A repository with only loose objects is perfectly valid.
    }

    const idxNames: string[] = [];
    for await (const [name, handle] of packDir.entries()) {
      if (handle.kind === "file" && name.endsWith(".idx")) idxNames.push(name);
    }

    for (const idxName of idxNames) {
      const base = idxName.slice(0, -4);
      try {
        const idxFile = await (await packDir.getFileHandle(idxName)).getFile();
        const packFile = await (await packDir.getFileHandle(`${base}.pack`)).getFile();
        const index = parsePackIndex(new Uint8Array(await idxFile.arrayBuffer()));
        const data = new Uint8Array(await packFile.arrayBuffer());
        this.packs.push({ name: base, data, index });
      } catch {
        // A pack we cannot read (missing .pack, unknown idx version) is skipped
        // rather than failing the whole load.
      }
    }
  }

  private remember(sha: string, object: RawObject): void {
    this.cache.set(sha, object);
    if (this.cache.size > MAX_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next();
      if (!oldest.done) this.cache.delete(oldest.value);
    }
  }

  /** Read an object by sha, or null when it is not in this repository. */
  async read(sha: string): Promise<RawObject | null> {
    const key = sha.toLowerCase();
    const cached = this.cache.get(key);
    if (cached) return cached;

    const loose = await this.readLoose(key);
    if (loose) {
      this.remember(key, loose);
      return loose;
    }

    for (const pack of this.packs) {
      const offset = pack.index.offsets.get(key);
      if (offset === undefined) continue;
      const object = await this.readFromPack(pack, offset);
      this.remember(key, object);
      return object;
    }
    return null;
  }

  private async readLoose(sha: string): Promise<RawObject | null> {
    if (sha.length !== 40) return null;
    try {
      const objects = await this.gitDir.getDirectoryHandle("objects");
      const bucket = await objects.getDirectoryHandle(sha.slice(0, 2));
      const file = await (await bucket.getFileHandle(sha.slice(2))).getFile();
      const raw = await inflate(new Uint8Array(await file.arrayBuffer()));
      return parseLooseObject(raw);
    } catch {
      return null;
    }
  }

  /**
   * Resolve a pack entry, unwinding delta chains iteratively: chains can run
   * dozens deep, so we collect the deltas on a list and only then apply them
   * outermost-last.
   */
  private async readFromPack(pack: LoadedPack, startOffset: number): Promise<RawObject> {
    const chain: DeltaLink[] = [];
    let currentPack = pack;
    let offset = startOffset;
    let baseType: GitObjectType | null = null;
    let baseData: Uint8Array | null = null;

    for (;;) {
      const header = readPackEntryHeader(currentPack.data, offset);
      let bodyAt = header.next;
      let refSha: string | null = null;
      let ofsBase = -1;

      if (header.type === OFS_DELTA) {
        // The varint is a *negative* distance from this entry's own start.
        const rel = decodeOffsetVarint(currentPack.data, bodyAt);
        bodyAt = rel.next;
        ofsBase = offset - rel.value;
        if (ofsBase < 0) throw new Error("ofs-delta points before the start of the pack.");
      } else if (header.type === REF_DELTA) {
        refSha = toHex(currentPack.data, bodyAt, 20);
        bodyAt += 20;
      }

      const payload = await inflateAtMost(currentPack.data, bodyAt, header.size);

      if (header.type === OFS_DELTA) {
        chain.push({ pack: currentPack, delta: payload });
        offset = ofsBase;
        continue;
      }
      if (header.type === REF_DELTA) {
        chain.push({ pack: currentPack, delta: payload });
        const sha = refSha!;
        const cached = this.cache.get(sha);
        if (cached) {
          baseType = cached.type;
          baseData = cached.data;
          break;
        }
        const located = this.locate(sha);
        if (!located) {
          const loose = await this.readLoose(sha);
          if (!loose) throw new Error(`Missing delta base object ${sha}.`);
          baseType = loose.type;
          baseData = loose.data;
          break;
        }
        currentPack = located.pack;
        offset = located.offset;
        continue;
      }

      const type = TYPE_BY_ID[header.type];
      if (!type) throw new Error(`Unknown pack object type ${header.type}.`);
      baseType = type;
      baseData = payload;
      break;
    }

    let data = baseData!;
    for (let i = chain.length - 1; i >= 0; i--) {
      data = applyDelta(data, chain[i]!.delta);
    }
    return { type: baseType!, data };
  }

  private locate(sha: string): { pack: LoadedPack; offset: number } | null {
    for (const pack of this.packs) {
      const offset = pack.index.offsets.get(sha);
      if (offset !== undefined) return { pack, offset };
    }
    return null;
  }
}

/** Split an inflated loose object into its `"<type> <size>\0"` header and payload. */
export function parseLooseObject(raw: Uint8Array): RawObject {
  const nul = raw.indexOf(0);
  if (nul < 0) throw new Error("Loose object has no header terminator.");
  const header = new TextDecoder().decode(raw.subarray(0, nul));
  const space = header.indexOf(" ");
  const typeName = (space < 0 ? header : header.slice(0, space)) as GitObjectType;
  if (typeName !== "commit" && typeName !== "tree" && typeName !== "blob" && typeName !== "tag") {
    throw new Error(`Unknown loose object type "${typeName}".`);
  }
  return { type: typeName, data: raw.subarray(nul + 1) };
}
