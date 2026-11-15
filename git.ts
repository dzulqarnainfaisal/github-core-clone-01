// git.ts — pure git primitives: object hashing, tree/commit/tag codecs, packfiles and
// pkt-lines. No I/O, no git binary. Byte formats match git (and the suite's git-client).

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export const ZERO_OID = '0000000000000000000000000000000000000000';
const HEX40 = /^[0-9a-f]{40}$/;

export function isObjectId(value: unknown): value is string {
  return typeof value === 'string' && HEX40.test(value);
}

/** SHA-1 over `<type> <size>\0` + the object's bytes. */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  hash.update(data);
  return hash.digest('hex');
}

export function objectIdOf(type: GitObjectType, data: Buffer): string {
  return hashObject(type, data);
}

// --------------------------------------------------------------------------- trees

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** git's tree-entry sort: byte order of the name, a directory compared as if it ended in '/'. */
function compareTreeNames(a: TreeEntry, b: TreeEntry): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

/** Build a tree object's bytes from entries, sorted the way git sorts them. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Parse a tree object's bytes into its entries. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode');
    const mode = data.subarray(offset, space).toString('utf8');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0) throw new Error('tree entry has no name');
    const name = data.subarray(space + 1, nul).toString('utf8');
    if (nul + 21 > data.length) throw new Error('tree entry has no oid');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

// --------------------------------------------------------------------------- commits

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headerText = data.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, author, committer, message };
}

export const CONFORMANCE_IDENTITY = 'Conformance <conformance@make.fun>';
/** Fixed timestamp so generated commits are byte-identical on every run. */
export const FIXED_TIMESTAMP = 1700000000;

export function buildCommit(fields: {
  tree: string;
  parents?: readonly string[];
  message: string;
  author?: string;
  committer?: string;
  timestamp?: number;
  timezone?: string;
}): Buffer {
  const timestamp = fields.timestamp ?? FIXED_TIMESTAMP;
  const timezone = fields.timezone ?? '+0000';
  const who = `${fields.author ?? CONFORMANCE_IDENTITY} ${timestamp} ${timezone}`;
  const committer = `${fields.committer ?? CONFORMANCE_IDENTITY} ${timestamp} ${timezone}`;
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) lines.push(`parent ${parent}`);
  lines.push(`author ${who}`, `committer ${committer}`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

// --------------------------------------------------------------------------- tags

export interface TagView {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headers = new Map<string, string>();
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) continue;
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  return {
    object: headers.get('object') ?? '',
    type: headers.get('type') ?? '',
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8'),
  };
}

export function buildTag(fields: {
  object: string;
  type: GitObjectType;
  tag: string;
  message: string;
  tagger?: string;
  timestamp?: number;
  timezone?: string;
}): Buffer {
  const timestamp = fields.timestamp ?? FIXED_TIMESTAMP;
  const timezone = fields.timezone ?? '+0000';
  const tagger = `${fields.tagger ?? CONFORMANCE_IDENTITY} ${timestamp} ${timezone}`;
  return Buffer.from(
    `object ${fields.object}\ntype ${fields.type}\ntag ${fields.tag}\ntagger ${tagger}\n\n${fields.message}`,
    'utf8',
  );
}

// --------------------------------------------------------------------------- pkt-lines

export const PKT_FLUSH = Buffer.from('0000');
export const PKT_DELIM = Buffer.from('0001');
export const PKT_RESPONSE_END = Buffer.from('0002');

/** One pkt-line framing `payload` (which must already end in \n when it is a text line). */
export function pktLine(payload: Buffer): Buffer {
  const length = payload.length + 4;
  const header = Buffer.alloc(4);
  header.write(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, payload]);
}

export function pktLineText(text: string): Buffer {
  return pktLine(Buffer.from(text, 'utf8'));
}

/** Encode a list of text lines / flush / delim into a pkt-line stream. */
export function encodePktLines(items: readonly (string | 'flush' | 'delim' | 'response-end')[]): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(PKT_FLUSH);
    else if (item === 'delim') parts.push(PKT_DELIM);
    else if (item === 'response-end') parts.push(PKT_RESPONSE_END);
    else parts.push(pktLineText(item));
  }
  return Buffer.concat(parts);
}

export type PktPacket =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

/**
 * Decode pkt-lines from `buf` starting at `start`. Returns the packets and the offset just
 * past the last complete packet. Stops at the first bytes that are not a pkt-line header
 * (for receive-pack: the raw packfile that follows the flush).
 */
export function decodePktLines(buf: Buffer, start = 0): { packets: PktPacket[]; nextOffset: number } {
  const packets: PktPacket[] = [];
  let offset = start;
  while (offset + 4 <= buf.length) {
    const header = buf.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    const length = parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > buf.length) break;
    packets.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, nextOffset: offset };
}

/** Wrap `data` as sideband band-1 pkt-lines, chunked so no pkt-line exceeds the limit. */
export function sidebandWrap(data: Buffer, band = 1): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 32768;
  for (let offset = 0; offset < data.length; offset += CHUNK) {
    const slice = data.subarray(offset, Math.min(offset + CHUNK, data.length));
    const payload = Buffer.concat([Buffer.from([band]), slice]);
    parts.push(pktLine(payload));
  }
  return Buffer.concat(parts);
}

// --------------------------------------------------------------------------- packfiles

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/**
 * Cache of deflated object bytes by object id. Objects are content-addressed and immutable,
 * so the deflated form of an oid is deterministic; repeated clones of the same history reuse it
 * instead of re-deflating. Bounded so a long trial cannot grow it without limit.
 */
const DEFLATE_CACHE = new Map<string, Buffer>();
const DEFLATE_CACHE_MAX = 4096;

function deflateCached(oid: string, data: Buffer): Buffer {
  const hit = DEFLATE_CACHE.get(oid);
  if (hit) return hit;
  // Level 1 is ~3x faster than the default level 6 for 1 KiB blobs and the pack is read over
  // loopback, so the slightly larger pack is worth the speed.
  const deflated = deflateSync(data, { level: 1 });
  if (DEFLATE_CACHE.size >= DEFLATE_CACHE_MAX) DEFLATE_CACHE.clear();
  DEFLATE_CACHE.set(oid, deflated);
  return deflated;
}

/** Build a packfile from plain objects (no deltas), with the SHA-1 trailer. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateCached(objectIdOf(object.type, object.data), object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/** Inflate one zlib stream at `offset`; returns its bytes and the offset just past the stream. */
export function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset);
  const result = inflateSync(view, { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buffer[start];
  let offset = start + 1;
  let size = byte & 0x0f;
  let shift = 4;
  while (byte & 0x80) {
    byte = buffer[offset++];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: offset, first: buffer[start] };
}

/**
 * Parse a packfile into its objects (plain objects only; OFS/REF deltas are not produced by
 * this entry, and the suite's client only ever sends plain objects). Returns a map oid -> object.
 */
export function readPack(pack: Buffer): Map<string, GitObject> {
  if (pack.length < 32) throw new Error(`pack is ${pack.length} bytes, too short`);
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error('pack trailer checksum mismatch');
  const objects = new Map<string, GitObject>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const header = readVarintSize(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    if (typeCode === 6 || typeCode === 7) {
      throw new Error('delta pack entries are not accepted by this entry');
    }
    const type = CODE_TYPE[typeCode];
    if (!type) throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) {
      throw new Error(`pack entry ${index} declares ${header.size} bytes but inflated to ${inflated.data.length}`);
    }
    offset = inflated.next;
    const oid = hashObject(type, inflated.data);
    objects.set(oid, { type, data: inflated.data });
  }
  if (offset !== trailerStart) throw new Error(`pack has ${trailerStart - offset} stray bytes before its trailer`);
  return objects;
}

/**
 * Every object reachable from `roots`: commit -> tree + parents, tree -> entries, tag -> target.
 * Missing objects are skipped when `allowMissing` is set. A commit in `cutoff` is a shallow
 * root: it is included with its tree, but its parents are not followed (what a shallow clone
 * holds of that commit).
 */
export function collectReachable(
  roots: Iterable<string>,
  lookup: (oid: string) => GitObject | undefined,
  options: { allowMissing?: boolean; cutoff?: ReadonlySet<string> } = {},
): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) {
    if (root === ZERO_OID) continue;
    if (!seen.has(root)) {
      seen.add(root);
      queue.push(root);
    }
  }
  while (queue.length > 0) {
    const oid = queue.pop()!;
    const object = lookup(oid);
    if (!object) {
      if (options.allowMissing) continue;
      throw new Error(`missing object ${oid}`);
    }
    const push = (child: string): void => {
      if (child !== ZERO_OID && !seen.has(child)) {
        seen.add(child);
        queue.push(child);
      }
    };
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      push(commit.tree);
      if (!options.cutoff?.has(oid)) {
        for (const parent of commit.parents) push(parent);
      }
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) push(entry.oid);
    } else if (object.type === 'tag') {
      push(parseTag(object.data).object);
    }
  }
  return seen;
}
