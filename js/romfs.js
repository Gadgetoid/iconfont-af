/*
 * romfs.js - pack and unpack MicroPython ROMFS filesystem images.
 *
 * Derived from MicroPython (https://micropython.org), MIT licensed:
 *   tools/mpremote/mpremote/romfs.py - VfsRomWriter, the reference packer.
 *   extmod/vfs_rom.c                 - the format specification and reader semantics.
 * Copyright (c) 2022 Damien P. George
 *
 * See THIRD_PARTY_NOTICES.md for the full upstream license text.
 *
 * Format summary (from extmod/vfs_rom.c):
 *   varuint - unsigned int, big-endian 7 bits per byte, high bit set if more follow.
 *             May be padded by prepending 0x80 bytes without changing its value.
 *   record  - varuint kind, varuint payload length, then the payload.
 *
 * The image is itself one record of kind 0x14a6b1, which encodes to the bytes
 * d2 cd 31 ("RM1" with the high bit set on the first two). Its payload holds the
 * root directory's records. The total image size must be even, because a padding
 * record cannot be only one byte long.
 */

export const ROMFS_HEADER = Uint8Array.of(0xd2, 0xcd, 0x31);

export const RECORD_KIND = {
  UNUSED: 0,
  PADDING: 1,
  DATA_VERBATIM: 2,
  DATA_POINTER: 3,
  DIRECTORY: 4,
  FILE: 5,
  FILESYSTEM: 0x14a6b1,
};

export class RomfsError extends Error {
  constructor(message) {
    super(message);
    this.name = "RomfsError";
  }
}

const utf8Encode = new TextEncoder();
const utf8Decode = new TextDecoder("utf-8", { fatal: false });

/* ------------------------------------------------------------------ */
/* Primitives                                                          */
/* ------------------------------------------------------------------ */

/** Encode a non-negative integer as a varuint. */
export function encodeUint(value) {
  if (!Number.isInteger(value) || value < 0) {
    throw new RomfsError(`cannot encode ${value} as a varuint`);
  }
  // Division rather than >>> so values above 2^31 survive.
  const out = [value % 128];
  value = Math.floor(value / 128);
  while (value > 0) {
    out.unshift(0x80 | (value % 128));
    value = Math.floor(value / 128);
  }
  return Uint8Array.from(out);
}

/** Decode a varuint at `pos`, refusing to read at or past `max`. */
export function decodeUint(buf, pos, max = buf.length) {
  let value = 0;
  let byte;
  do {
    if (pos >= max) throw new RomfsError("truncated varuint");
    byte = buf[pos++];
    value = value * 128 + (byte & 0x7f);
    if (!Number.isSafeInteger(value)) throw new RomfsError("varuint too large");
  } while (byte & 0x80);
  return { value, pos };
}

function concat(...parts) {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** ASCII-only, matching the reference packer's bytes(name, "ascii"). */
function encodeName(name) {
  for (let i = 0; i < name.length; i++) {
    if (name.charCodeAt(i) > 0x7f) {
      throw new RomfsError(`name ${JSON.stringify(name)} must be ASCII`);
    }
  }
  return utf8Encode.encode(name);
}

function toBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (typeof data === "string") return utf8Encode.encode(data);
  throw new RomfsError("file data must be Uint8Array, ArrayBuffer or string");
}

/** Growable byte buffer that tracks length without repeated reallocation. */
class ByteBuf {
  #chunks = [];
  length = 0;

  push(bytes) {
    this.#chunks.push(bytes);
    this.length += bytes.length;
    return this.length;
  }

  toBytes() {
    return concat(...this.#chunks);
  }
}

/* ------------------------------------------------------------------ */
/* Writer - a direct port of VfsRomWriter from romfs.py                */
/* ------------------------------------------------------------------ */

export class VfsRomWriter {
  #dirStack = [{ name: null, buf: new ByteBuf() }];

  static #pack(kind, payload) {
    return concat(encodeUint(kind), encodeUint(payload.length), payload);
  }

  #extend(data) {
    return this.#dirStack[this.#dirStack.length - 1].buf.push(data);
  }

  opendir(dirname) {
    this.#dirStack.push({ name: dirname, buf: new ByteBuf() });
  }

  closedir() {
    if (this.#dirStack.length < 2) throw new RomfsError("closedir without opendir");
    const { name, buf } = this.#dirStack.pop();
    const nameBytes = encodeName(name);
    const payload = concat(encodeUint(nameBytes.length), nameBytes, buf.toBytes());
    this.#extend(VfsRomWriter.#pack(RECORD_KIND.DIRECTORY, payload));
  }

  /**
   * Append a top-level verbatim data record and return the offset of its
   * payload, relative to the start of the filesystem record's payload. That
   * offset is what a DATA_POINTER record refers to.
   */
  mkdata(data) {
    if (this.#dirStack.length !== 1) throw new RomfsError("mkdata only at the top level");
    const bytes = toBytes(data);
    return this.#extend(VfsRomWriter.#pack(RECORD_KIND.DATA_VERBATIM, bytes)) - bytes.length;
  }

  /** `filedata` is bytes, or `{size, offset}` to point at an earlier mkdata(). */
  mkfile(filename, filedata) {
    const nameBytes = encodeName(filename);
    let nested;
    if (filedata && typeof filedata === "object" && !ArrayBuffer.isView(filedata) && "offset" in filedata) {
      const sub = concat(encodeUint(filedata.size), encodeUint(filedata.offset));
      nested = VfsRomWriter.#pack(RECORD_KIND.DATA_POINTER, sub);
    } else {
      nested = VfsRomWriter.#pack(RECORD_KIND.DATA_VERBATIM, toBytes(filedata));
    }
    const payload = concat(encodeUint(nameBytes.length), nameBytes, nested);
    this.#extend(VfsRomWriter.#pack(RECORD_KIND.FILE, payload));
  }

  finalise() {
    if (this.#dirStack.length !== 1) throw new RomfsError("unclosed directory");
    const data = this.#dirStack.pop().buf.toBytes();
    let encodedLen = encodeUint(data.length);
    // Pad the length varuint so the whole record has an even size.
    if ((ROMFS_HEADER.length + encodedLen.length + data.length) % 2 === 1) {
      encodedLen = concat(Uint8Array.of(0x80), encodedLen);
    }
    return concat(ROMFS_HEADER, encodedLen, data);
  }
}

/* ------------------------------------------------------------------ */
/* Tree building                                                       */
/* ------------------------------------------------------------------ */

function newDir() {
  return { type: "dir", children: new Map() };
}

/**
 * Normalise input into a nested tree.
 * Accepts an array of `{path, data}`, or an object mapping path to data.
 */
function buildTree(files) {
  const entries = Array.isArray(files)
    ? files.map((f) => [f.path, f.data])
    : Object.entries(files);

  const root = newDir();
  for (const [rawPath, data] of entries) {
    const parts = String(rawPath).split("/").filter((p) => p.length > 0);
    if (parts.length === 0) throw new RomfsError(`invalid path ${JSON.stringify(rawPath)}`);
    if (parts.some((p) => p === "." || p === "..")) {
      throw new RomfsError(`path ${JSON.stringify(rawPath)} must not contain . or ..`);
    }
    let node = root;
    for (const part of parts.slice(0, -1)) {
      let next = node.children.get(part);
      if (!next) {
        next = newDir();
        node.children.set(part, next);
      }
      if (next.type !== "dir") throw new RomfsError(`${part} is both a file and a directory`);
      node = next;
    }
    const name = parts[parts.length - 1];
    if (node.children.has(name)) throw new RomfsError(`duplicate path ${JSON.stringify(rawPath)}`);
    node.children.set(name, { type: "file", data: toBytes(data) });
  }
  return root;
}

/** Sorted so output is reproducible, matching mpremote's sorted(os.listdir()). */
function sortedChildren(dir) {
  return [...dir.children.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function walkFiles(dir, out = []) {
  for (const [, node] of sortedChildren(dir)) {
    if (node.type === "dir") walkFiles(node, out);
    else out.push(node);
  }
  return out;
}

function fnv1a(bytes) {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

const DEDUPE_MIN_BYTES = 16;

/** Hoist duplicate file contents into shared top-level data records. */
function buildPointers(writer, root) {
  const groups = new Map();
  for (const file of walkFiles(root)) {
    if (file.data.length < DEDUPE_MIN_BYTES) continue;
    const key = `${file.data.length}:${fnv1a(file.data)}`;
    const group = groups.get(key);
    if (group) group.push(file.data);
    else groups.set(key, [file.data]);
  }

  const pointers = new Map();
  for (const [key, datas] of groups) {
    if (datas.length < 2) continue;
    // Guard against hash collisions rather than trusting the digest.
    if (!datas.every((d) => bytesEqual(d, datas[0]))) continue;
    const offset = writer.mkdata(datas[0]);
    pointers.set(key, { data: datas[0], size: datas[0].length, offset });
  }
  return pointers;
}

function lookupPointer(pointers, data) {
  if (!pointers || data.length < DEDUPE_MIN_BYTES) return null;
  const hit = pointers.get(`${data.length}:${fnv1a(data)}`);
  if (hit && bytesEqual(hit.data, data)) return { size: hit.size, offset: hit.offset };
  return null;
}

function writeDir(writer, dir, pointers) {
  for (const [name, node] of sortedChildren(dir)) {
    if (node.type === "dir") {
      writer.opendir(name);
      writeDir(writer, node, pointers);
      writer.closedir();
    } else {
      writer.mkfile(name, lookupPointer(pointers, node.data) ?? node.data);
    }
  }
}

/**
 * Pack files into a ROMFS image.
 *
 * @param {Array<{path: string, data: Uint8Array|ArrayBuffer|string}>|Object} files
 * @param {{dedupe?: boolean}} [options] dedupe shares identical file contents
 *   via DATA_POINTER records. Off by default so output matches mpremote byte
 *   for byte.
 * @returns {Uint8Array}
 */
export function packRomfs(files, { dedupe = false } = {}) {
  const root = buildTree(files);
  const writer = new VfsRomWriter();
  const pointers = dedupe ? buildPointers(writer, root) : null;
  writeDir(writer, root, pointers);
  return writer.finalise();
}

/* ------------------------------------------------------------------ */
/* Reader - mirrors extmod/vfs_rom.c                                   */
/* ------------------------------------------------------------------ */

function extractRecord(buf, pos, max) {
  const kindRes = decodeUint(buf, pos, max);
  const lenRes = decodeUint(buf, kindRes.pos, max);
  const end = lenRes.pos + lenRes.value;
  if (end > max) throw new RomfsError("record overruns its container");
  return { kind: kindRes.value, start: lenRes.pos, end };
}

/** Resolve a file's nested data record into a view of the image. */
function extractData(buf, pos, end, fsBase) {
  while (pos < end) {
    const rec = extractRecord(buf, pos, end);
    if (rec.kind === RECORD_KIND.UNUSED) break;
    if (rec.kind === RECORD_KIND.DATA_VERBATIM) {
      return buf.subarray(rec.start, rec.end);
    }
    if (rec.kind === RECORD_KIND.DATA_POINTER) {
      const sizeRes = decodeUint(buf, rec.start, rec.end);
      const offsetRes = decodeUint(buf, sizeRes.pos, rec.end);
      const from = fsBase + offsetRes.value;
      const to = from + sizeRes.value;
      if (to > buf.length) throw new RomfsError("data pointer outside image");
      return buf.subarray(from, to);
    }
    pos = rec.end; // Unknown records must be skipped.
  }
  throw new RomfsError("file has no data record");
}

function readDir(buf, pos, end, fsBase, skipped) {
  const children = [];
  while (pos < end) {
    const rec = extractRecord(buf, pos, end);
    if (rec.kind === RECORD_KIND.UNUSED) throw new RomfsError("corrupt filesystem");

    if (rec.kind === RECORD_KIND.DIRECTORY || rec.kind === RECORD_KIND.FILE) {
      const nameRes = decodeUint(buf, rec.start, rec.end);
      const nameEnd = nameRes.pos + nameRes.value;
      if (nameEnd > rec.end) throw new RomfsError("name overruns its record");
      const name = utf8Decode.decode(buf.subarray(nameRes.pos, nameEnd));

      if (rec.kind === RECORD_KIND.DIRECTORY) {
        children.push({ type: "dir", name, children: readDir(buf, nameEnd, rec.end, fsBase, skipped) });
      } else {
        children.push({ type: "file", name, data: extractData(buf, nameEnd, rec.end, fsBase) });
      }
    } else {
      // Padding and shared data pools are expected here; anything else is a
      // record kind this reader predates, and repacking would discard it.
      skipped.add(rec.kind);
    }
    pos = rec.end;
  }
  return children;
}

/**
 * Read the declared image size from the leading bytes of an image, which is
 * all `mpremote romfs query` needs. Returns null if this is not a ROMFS.
 */
export function romfsImageSize(head) {
  const buf = toBytes(head);
  if (buf.length < 4) return null;
  for (let i = 0; i < ROMFS_HEADER.length; i++) {
    if (buf[i] !== ROMFS_HEADER[i]) return null;
  }
  let size = 0;
  for (let i = ROMFS_HEADER.length; i < buf.length; i++) {
    size = size * 128 + (buf[i] & 0x7f);
    if (!(buf[i] & 0x80)) {
      return { payloadSize: size, headerSize: i + 1, totalSize: i + 1 + size };
    }
  }
  return null; // Length varuint was truncated.
}

/** Record kinds a reader may skip without losing file data. */
const BENIGN_SKIPPED_KINDS = new Set([
  RECORD_KIND.PADDING,
  RECORD_KIND.DATA_VERBATIM, // Shared data pools referenced by DATA_POINTER.
  RECORD_KIND.DATA_POINTER,
]);

/**
 * Unpack a ROMFS image.
 * `unknownKinds` lists record kinds that were skipped and would be lost on a
 * repack, which is empty for images built by this packer or by mpremote.
 * @returns {{payloadSize: number, totalSize: number, tree: Array, files: Array<{path: string, data: Uint8Array}>, unknownKinds: number[]}}
 */
export function unpackRomfs(image) {
  const buf = toBytes(image);
  if (buf.length < 4) throw new RomfsError("image too short");
  for (let i = 0; i < ROMFS_HEADER.length; i++) {
    if (buf[i] !== ROMFS_HEADER[i]) throw new RomfsError("not a ROMFS image (bad header)");
  }

  const rec = extractRecord(buf, 0, buf.length);
  if (rec.kind !== RECORD_KIND.FILESYSTEM) throw new RomfsError("not a ROMFS image (bad record kind)");

  // DATA_POINTER offsets are relative to the filesystem record's payload.
  const fsBase = rec.start;
  const skipped = new Set();
  const tree = readDir(buf, rec.start, rec.end, fsBase, skipped);

  const files = [];
  (function flatten(nodes, prefix) {
    for (const node of nodes) {
      const path = `${prefix}/${node.name}`;
      if (node.type === "dir") flatten(node.children, path);
      else files.push({ path, data: node.data });
    }
  })(tree, "");

  const unknownKinds = [...skipped].filter((kind) => !BENIGN_SKIPPED_KINDS.has(kind));
  return { payloadSize: rec.end - rec.start, totalSize: rec.end, tree, files, unknownKinds };
}

/* ------------------------------------------------------------------ */
/* Editing an existing image                                           */
/* ------------------------------------------------------------------ */

/**
 * Load, modify and rebuild a ROMFS image.
 *
 * ROMFS is read-only and every record is length-prefixed, so a file cannot be
 * spliced into an existing image in place: the enclosing directory and
 * filesystem records would both have to grow. Instead this unpacks the image,
 * edits a path-to-bytes map, and repacks it.
 *
 * Repacking an image that was built by mpremote (or by packRomfs) reproduces it
 * byte for byte when nothing has changed. Records the format lets a reader skip
 * (padding, and any future metadata) are *not* carried across; `unknownKinds`
 * on the source image tells you whether any were present.
 */
export class RomfsBuilder {
  #files = new Map(); // path without a leading slash -> Uint8Array

  /** Build from an existing image. */
  static from(image) {
    const builder = new RomfsBuilder();
    const { files, unknownKinds } = unpackRomfs(image);
    for (const file of files) {
      // Copy out of the source image so it can be garbage collected.
      builder.#files.set(file.path.replace(/^\//, ""), Uint8Array.from(file.data));
    }
    builder.unknownKinds = unknownKinds;
    return builder;
  }

  static empty() {
    return new RomfsBuilder();
  }

  get size() {
    return this.#files.size;
  }

  /** Paths present, with a leading slash, sorted as the image stores them. */
  list() {
    return [...this.#files.keys()].sort().map((path) => ({
      path: `/${path}`,
      size: this.#files.get(path).length,
    }));
  }

  has(path) {
    return this.#files.has(normalisePath(path));
  }

  /** @returns {Uint8Array|null} */
  read(path) {
    return this.#files.get(normalisePath(path)) ?? null;
  }

  /** Add or replace a file. Chainable. */
  write(path, data) {
    this.#files.set(normalisePath(path), toBytes(data));
    return this;
  }

  /** @returns {boolean} whether the file existed. */
  delete(path) {
    return this.#files.delete(normalisePath(path));
  }

  /** Repack into an image. */
  toImage({ dedupe = false } = {}) {
    const entries = [...this.#files.entries()].map(([path, data]) => ({ path, data }));
    return packRomfs(entries, { dedupe });
  }
}

function normalisePath(path) {
  const cleaned = String(path).replace(/^\/+/, "");
  if (!cleaned) throw new RomfsError("path must not be empty");
  return cleaned;
}

/**
 * Merge files into an existing image, leaving everything else untouched.
 *
 * @param {Uint8Array|null} baseImage the image to start from, or null for empty
 * @param {Array<{path: string, data: Uint8Array|string}>} files to add or replace
 * @param {{remove?: string[], dedupe?: boolean}} [options] `remove` deletes paths first
 */
export function mergeRomfs(baseImage, files, { remove = [], dedupe = false } = {}) {
  const builder = baseImage ? RomfsBuilder.from(baseImage) : RomfsBuilder.empty();
  for (const path of remove) builder.delete(path);
  for (const { path, data } of files) builder.write(path, data);
  return builder.toImage({ dedupe });
}

/** Render an unpacked tree as indented text, for display. */
export function formatRomfsTree(tree, indent = "") {
  const lines = [];
  tree.forEach((node, i) => {
    const last = i === tree.length - 1;
    const branch = last ? "\\-- " : "|-- ";
    if (node.type === "dir") {
      lines.push(`${indent}${branch}${node.name}/`);
      lines.push(...formatRomfsTree(node.children, indent + (last ? "    " : "|   ")));
    } else {
      lines.push(`${indent}${branch}${node.name} (${node.data.length} bytes)`);
    }
  });
  return lines;
}
