// Generate placeholder icons that electron-builder accepts.
//
// We need: desktop/icons/{icon.png, icon.ico, icon.icns} (electron-builder
// looks at buildResources/icon.* by default). This script emits valid
// minimal files (solid Memoria blue #2a6df4) using pure Node so the build
// pipeline works out of the box — no electron-builder native helpers, no
// sharp, no platform-specific tooling needed.
//
// To replace with proper artwork later, drop a 1024x1024 source PNG here
// as `icon.png` and electron-builder will regenerate the platform-specific
// formats from it (it has its own pipeline). This script is fallback for
// fresh checkouts where the artwork isn't checked in.

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { Buffer } from 'node:buffer';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ICON_DIR = resolve(__dirname, '..', 'icons');

const COLOR = { r: 0x2a, g: 0x6d, b: 0xf4, a: 0xff } as const;

let CRC_TABLE: Uint32Array | null = null;
function crc32(buf: Buffer): number {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let v = 0xffffffff;
  for (let i = 0; i < buf.length; i++) v = CRC_TABLE[(v ^ buf[i]) & 0xff] ^ (v >>> 8);
  return (v ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function makePng(size: number): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;          // bit depth
  ihdr[9] = 6;          // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const rowLen = 1 + size * 4;
  const raw = Buffer.alloc(rowLen * size);
  for (let y = 0; y < size; y++) {
    const off = y * rowLen;
    raw[off] = 0;
    for (let x = 0; x < size; x++) {
      const p = off + 1 + x * 4;
      raw[p] = COLOR.r;
      raw[p + 1] = COLOR.g;
      raw[p + 2] = COLOR.b;
      raw[p + 3] = COLOR.a;
    }
  }
  const idat = deflateSync(raw);
  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

interface IcoEntry { size: number; data: Buffer; }

function makeIco(pngBuffers: IcoEntry[]): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngBuffers.length, 4);
  let offset = 6 + 16 * pngBuffers.length;
  const entries: Buffer[] = [];
  for (const { size, data } of pngBuffers) {
    const e = Buffer.alloc(16);
    e[0] = size === 256 ? 0 : size;
    e[1] = size === 256 ? 0 : size;
    e[2] = 0;
    e[3] = 0;
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += data.length;
  }
  return Buffer.concat([header, ...entries, ...pngBuffers.map(p => p.data)]);
}

function makeIcns(pngBuffers: IcoEntry[]): Buffer {
  const TYPES: Record<number, string> = {
    32: 'ic11',
    64: 'ic12',
    128: 'ic07',
    256: 'ic08',
    512: 'ic09',
    1024: 'ic10',
  };
  const blocks: Buffer[] = [];
  for (const { size, data } of pngBuffers) {
    const t = TYPES[size];
    if (!t) continue;
    const head = Buffer.alloc(8);
    head.write(t, 0, 'ascii');
    head.writeUInt32BE(8 + data.length, 4);
    blocks.push(Buffer.concat([head, data]));
  }
  const body = Buffer.concat(blocks);
  const file = Buffer.alloc(8);
  file.write('icns', 0, 'ascii');
  file.writeUInt32BE(8 + body.length, 4);
  return Buffer.concat([file, body]);
}

mkdirSync(ICON_DIR, { recursive: true });
const png16 = makePng(16);
const png32 = makePng(32);
const png48 = makePng(48);
const png64 = makePng(64);
const png128 = makePng(128);
const png256 = makePng(256);
const png512 = makePng(512);

// Linux: single icon.png at 512px.
writeFileSync(resolve(ICON_DIR, 'icon.png'), png512);
// Smaller PNGs are useful for the Linux desktop entry generator.
writeFileSync(resolve(ICON_DIR, '32x32.png'), png32);
writeFileSync(resolve(ICON_DIR, '128x128.png'), png128);
writeFileSync(resolve(ICON_DIR, '256x256.png'), png256);
writeFileSync(resolve(ICON_DIR, '512x512.png'), png512);
// Windows: multi-size .ico
writeFileSync(resolve(ICON_DIR, 'icon.ico'), makeIco([
  { size: 16,  data: png16 },
  { size: 32,  data: png32 },
  { size: 48,  data: png48 },
  { size: 64,  data: png64 },
  { size: 128, data: png128 },
  { size: 256, data: png256 },
]));
// macOS: .icns
writeFileSync(resolve(ICON_DIR, 'icon.icns'), makeIcns([
  { size: 32,  data: png32 },
  { size: 64,  data: png64 },
  { size: 128, data: png128 },
  { size: 256, data: png256 },
  { size: 512, data: png512 },
]));

console.log('[icons] wrote placeholders to', ICON_DIR);
