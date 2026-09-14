import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  readImageMetadata,
  UnsupportedFormatError,
  MalformedImageError,
} from './metadata.js';

function u16be(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n, 0);
  return b;
}

function buildPng(width: number, height: number, opts: { truncateIhdr?: boolean } = {}): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const data = Buffer.alloc(13);
  data.writeUInt32BE(width, 0);
  data.writeUInt32BE(height, 4);
  data[8] = 8; // bit depth
  data[9] = 2; // color type: truecolor
  const type = Buffer.from('IHDR', 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(13, 0);
  const crc = Buffer.alloc(4); // the parser never checks the CRC
  const chunk = opts.truncateIhdr ? data.subarray(0, 4) : data;
  return Buffer.concat([signature, length, type, chunk, crc]);
}

function buildExifApp1(orientation: number, littleEndian: boolean): Buffer {
  // header(8) + entry count(2) + one 12-byte entry + next-IFD offset(4)
  const tiff = Buffer.alloc(8 + 2 + 12 + 4);
  const write16 = (off: number, v: number) =>
    littleEndian ? tiff.writeUInt16LE(v, off) : tiff.writeUInt16BE(v, off);
  const write32 = (off: number, v: number) =>
    littleEndian ? tiff.writeUInt32LE(v, off) : tiff.writeUInt32BE(v, off);

  tiff.write(littleEndian ? 'II' : 'MM', 0, 'ascii');
  write16(2, 42);
  write32(4, 8); // IFD0 starts right after this 8-byte header
  write16(8, 1); // one directory entry
  write16(10, 0x0112); // Orientation tag
  write16(12, 3); // type SHORT
  write32(14, 1); // count
  write16(18, orientation);
  write32(20, 0); // no next IFD

  return Buffer.concat([Buffer.from('Exif\0\0', 'ascii'), tiff]);
}

function buildJpeg(width: number, height: number, opts: { app1?: Buffer } = {}): Buffer {
  const segments: Buffer[] = [Buffer.from([0xff, 0xd8])]; // SOI

  if (opts.app1) {
    const length = opts.app1.length + 2;
    segments.push(Buffer.from([0xff, 0xe1]), u16be(length), opts.app1);
  }

  const sof = Buffer.concat([
    Buffer.from([8]), // sample precision
    u16be(height),
    u16be(width),
    Buffer.from([1, 1, 0x11, 0]), // 1 component: id, sampling factors, quant table
  ]);
  segments.push(Buffer.from([0xff, 0xc0]), u16be(sof.length + 2), sof);
  segments.push(Buffer.from([0xff, 0xd9])); // EOI

  return Buffer.concat(segments);
}

interface Case {
  name: string;
  buf: Buffer;
  expect?: { format: string; width: number; height: number; orientation?: number };
  expectError?: new (...args: never[]) => Error;
}

const cases: Case[] = [
  {
    name: 'valid PNG',
    buf: buildPng(800, 600),
    expect: { format: 'png', width: 800, height: 600 },
  },
  {
    name: 'PNG cut off mid-download, before IHDR finishes',
    buf: buildPng(800, 600, { truncateIhdr: true }),
    expectError: MalformedImageError,
  },
  {
    name: 'minimal JPEG with no EXIF at all',
    buf: buildJpeg(320, 240),
    expect: { format: 'jpeg', width: 320, height: 240 },
  },
  {
    name: 'JPEG with big-endian (MM) EXIF orientation',
    buf: buildJpeg(100, 50, { app1: buildExifApp1(6, false) }),
    expect: { format: 'jpeg', width: 100, height: 50, orientation: 6 },
  },
  {
    name: 'JPEG with little-endian (II) EXIF orientation',
    buf: buildJpeg(100, 50, { app1: buildExifApp1(8, true) }),
    expect: { format: 'jpeg', width: 100, height: 50, orientation: 8 },
  },
  {
    name: 'empty file',
    buf: Buffer.alloc(0),
    expectError: UnsupportedFormatError,
  },
  {
    name: 'GIF signature is recognized but unsupported',
    buf: Buffer.from('GIF89a', 'ascii'),
    expectError: UnsupportedFormatError,
  },
  {
    name: 'JPEG that ends right after SOI, no SOF ever arrives',
    buf: Buffer.from([0xff, 0xd8]),
    expectError: MalformedImageError,
  },
];

for (const c of cases) {
  test(c.name, () => {
    if (c.expectError) {
      assert.throws(() => readImageMetadata(c.buf), c.expectError);
      return;
    }
    const meta = readImageMetadata(c.buf);
    assert.equal(meta.format, c.expect!.format);
    assert.equal(meta.width, c.expect!.width);
    assert.equal(meta.height, c.expect!.height);
    assert.equal(meta.orientation, c.expect!.orientation);
  });
}
