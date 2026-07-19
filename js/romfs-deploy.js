/*
 * romfs-deploy.js - query, deploy and read back ROMFS partitions on a device.
 *
 * Bridges romfs.js (the image format) and mp-serial.js (the transport). It has
 * no DOM dependencies and no knowledge of how the image was built.
 *
 * Derived from MicroPython (https://micropython.org), MIT licensed:
 *   tools/mpremote/mpremote/commands.py - _do_romfs_query / _do_romfs_deploy.
 * Copyright (c) 2022 Damien P. George
 *
 * See THIRD_PARTY_NOTICES.md for the full upstream license text.
 *
 * A device exposes its ROMFS partitions through `vfs.rom_ioctl(cmd, ...)`:
 *   1              - number of ROMFS partitions
 *   2, id          - get the partition: a block device, a writable memoryview,
 *                    or a negative int if it does not exist
 *   3, id, size    - prepare for writing, returns the minimum write size
 *   4, id, off, buf- write buf at off
 *   5, id          - finish writing
 * Partitions exposed as a block device are erased with ioctl(6, block) and
 * written with writeblocks() instead.
 */

import { ROMFS_HEADER, romfsImageSize, unpackRomfs } from "./romfs.js";

export class RomfsDeployError extends Error {
  constructor(message) {
    super(message);
    this.name = "RomfsDeployError";
  }
}

const CHUNK_SIZE = 4096;

function toBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function toHex(bytes) {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

function fromHex(text) {
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(text.substr(i * 2, 2), 16);
  return out;
}

/** Probe the fastest byte-transfer encoding this device supports. */
async function detectEncoding(mp) {
  if (await mp.tryExec("from binascii import a2b_base64")) return "base64";
  if (await mp.evalBool("hasattr(bytes,'fromhex')")) return "hex";
  throw new RomfsDeployError("device supports neither a2b_base64 nor bytes.fromhex");
}

/*
 * Note on compression: mpremote can send chunks as raw deflate, but it compresses
 * with a 512-byte window (wbits=-9) to match the device's DeflateIO(..., RAW, 9).
 * The browser's CompressionStream("deflate-raw") always uses a 32 KiB window, so
 * the device would mis-decode back-references beyond 512 bytes. Base64 it is.
 */
function encodeChunkCommand(chunk, encoding) {
  if (encoding === "base64") return `buf=a2b_base64(b'${toBase64(chunk)}')`;
  return `buf=bytes.fromhex('${toHex(chunk)}')`;
}

/** Resolve `vfs.rom_ioctl(2, id)` into a description of the partition. */
async function openPartition(mp, partition) {
  await mp.exec("import vfs");
  if (!(await mp.evalBool("hasattr(vfs,'rom_ioctl')"))) {
    throw new RomfsDeployError(
      "ROMFS is not enabled on this device (firmware built without MICROPY_VFS_ROM)",
    );
  }
  await mp.exec(`dev=vfs.rom_ioctl(2,${partition})`);
  if (await mp.evalBool("isinstance(dev,int) and dev<0")) {
    throw new RomfsDeployError(`ROMFS partition ${partition} not found on device`);
  }

  const isBlockDev = await mp.evalBool("hasattr(dev,'ioctl')");
  if (isBlockDev) {
    const blockCount = await mp.evalInt("dev.ioctl(4,0)");
    const blockSize = await mp.evalInt("dev.ioctl(5,0)");
    return { partition, isBlockDev, blockCount, blockSize, size: blockCount * blockSize };
  }
  return { partition, isBlockDev, size: await mp.evalInt("len(dev)") };
}

/** List the ROMFS partitions and what each currently holds. */
export async function queryRomfs(mp) {
  await mp.exec("import vfs");
  if (!(await mp.evalBool("hasattr(vfs,'rom_ioctl')"))) {
    throw new RomfsDeployError(
      "ROMFS is not enabled on this device (firmware built without MICROPY_VFS_ROM)",
    );
  }
  const count = await mp.evalInt("vfs.rom_ioctl(1)");
  if (count <= 0) throw new RomfsDeployError("no ROMFS partitions available");

  await mp.exec("from binascii import hexlify");

  const partitions = [];
  for (let id = 0; id < count; id++) {
    const info = await openPartition(mp, id);
    const head = fromHex(await mp.evalStr("hexlify(bytes(memoryview(dev)[:12])).decode()"));
    const image = romfsImageSize(head);
    partitions.push({ ...info, valid: image !== null, imageSize: image?.totalSize ?? null });
  }
  return partitions;
}

/**
 * Write a ROMFS image to a device partition.
 *
 * @param {import("./mp-serial.js").MicroPythonSerial} mp connected, in raw REPL.
 * @param {Uint8Array} image
 * @param {{partition?: number, onProgress?: (p: {phase: string, written: number, total: number}) => void}} options
 */
export async function deployRomfs(mp, image, { partition = 0, onProgress = null } = {}) {
  for (let i = 0; i < ROMFS_HEADER.length; i++) {
    if (image[i] !== ROMFS_HEADER[i]) throw new RomfsDeployError("not a valid ROMFS image");
  }

  const report = (phase, written = 0) => onProgress?.({ phase, written, total: image.length });

  report("connecting");
  const dev = await openPartition(mp, partition);
  if (image.length > dev.size) {
    throw new RomfsDeployError(
      `image is ${image.length} bytes but partition ${partition} holds only ${dev.size}`,
    );
  }

  // Unmount before touching the flash it is mapped from.
  await mp.exec("import vfs\ntry:\n vfs.umount('/rom')\nexcept:\n pass");

  report("erasing");
  let chunkSize = CHUNK_SIZE;
  if (dev.isBlockDev) {
    for (let offset = 0; offset < image.length; offset += dev.blockSize) {
      await mp.exec(`dev.ioctl(6,${Math.floor(offset / dev.blockSize)})`, { timeout: 30000 });
    }
    chunkSize = Math.min(chunkSize, dev.blockSize);
  } else {
    const minWrite = await mp.evalInt(`vfs.rom_ioctl(3,${partition},${image.length})`, { timeout: 30000 });
    chunkSize = Math.max(chunkSize, minWrite);
  }

  const encoding = await detectEncoding(mp);

  report("writing");
  for (let offset = 0; offset < image.length; offset += chunkSize) {
    // The final chunk is zero-padded up to the write granularity.
    const chunk = new Uint8Array(chunkSize);
    chunk.set(image.subarray(offset, Math.min(offset + chunkSize, image.length)));

    await mp.exec(encodeChunkCommand(chunk, encoding), { timeout: 30000 });
    if (dev.isBlockDev) {
      const block = Math.floor(offset / dev.blockSize);
      await mp.exec(`dev.writeblocks(${block},buf,${offset % dev.blockSize})`, { timeout: 30000 });
    } else {
      await mp.exec(`vfs.rom_ioctl(4,${partition},${offset},buf)`, { timeout: 30000 });
    }
    report("writing", Math.min(offset + chunkSize, image.length));
  }

  if (!dev.isBlockDev) await mp.evalStr(`vfs.rom_ioctl(5,${partition})`, { timeout: 30000 });

  report("done", image.length);
  return { size: image.length, partition, blockDevice: dev.isBlockDev };
}

/** Read a ROMFS image back off the device, for verification. */
export async function readRomfsImage(mp, { partition = 0, onProgress = null } = {}) {
  const dev = await openPartition(mp, partition);
  await mp.exec("from binascii import hexlify");

  const head = fromHex(await mp.evalStr("hexlify(bytes(memoryview(dev)[:12])).decode()"));
  const info = romfsImageSize(head);
  if (!info) throw new RomfsDeployError(`partition ${partition} does not contain a ROMFS image`);
  if (info.totalSize > dev.size) throw new RomfsDeployError("declared image size exceeds the partition");

  const image = new Uint8Array(info.totalSize);
  const readSize = 1024;
  for (let offset = 0; offset < info.totalSize; offset += readSize) {
    const end = Math.min(offset + readSize, info.totalSize);
    const text = await mp.evalStr(`hexlify(bytes(memoryview(dev)[${offset}:${end}])).decode()`);
    image.set(fromHex(text), offset);
    onProgress?.({ phase: "reading", written: end, total: info.totalSize });
  }
  return image;
}

/** True when two byte arrays hold identical bytes. */
export function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** Read back and confirm the device holds exactly `image`. */
export async function verifyRomfs(mp, image, { partition = 0, onProgress = null } = {}) {
  const actual = await readRomfsImage(mp, { partition, onProgress });
  if (actual.length !== image.length) {
    return { ok: false, reason: `size differs: device has ${actual.length}, expected ${image.length}` };
  }
  // A whole-image compare that reports where it first diverged, for the log.
  for (let i = 0; i < image.length; i++) {
    if (actual[i] !== image[i]) return { ok: false, reason: `first difference at byte ${i}` };
  }
  return { ok: true, files: unpackRomfs(actual).files };
}
