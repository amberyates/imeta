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

// Little-endian TIFF with IFD0 (orientation, Exif pointer, GPS pointer), an
// Exif IFD holding DateTimeOriginal, and a GPS IFD with lat/lon rationals.
function buildFullExifApp1(opts: { latRef: string; lonRef: string; zeroDenominator?: boolean }): Buffer {
  const ifd0 = 8;
  const exifIfd = ifd0 + 2 + 3 * 12 + 4;
  const gpsIfd = exifIfd + 2 + 12 + 4;
  const dateAt = gpsIfd + 2 + 4 * 12 + 4;
  const latAt = dateAt + 20;
  const lonAt = latAt + 24;
  const tiff = Buffer.alloc(lonAt + 24);

  tiff.write('II', 0, 'ascii');
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(ifd0, 4);

  const entry = (at: number, tag: number, type: number, count: number, value: number | string) => {
    tiff.writeUInt16LE(tag, at);
    tiff.writeUInt16LE(type, at + 2);
    tiff.writeUInt32LE(count, at + 4);
    if (typeof value === 'string') tiff.write(value, at + 8, 'ascii');
    else if (type === 3) tiff.writeUInt16LE(value, at + 8);
    else tiff.writeUInt32LE(value, at + 8);
  };

  tiff.writeUInt16LE(3, ifd0);
  entry(ifd0 + 2, 0x0112, 3, 1, 3);
  entry(ifd0 + 14, 0x8769, 4, 1, exifIfd);
  entry(ifd0 + 26, 0x8825, 4, 1, gpsIfd);

  tiff.writeUInt16LE(1, exifIfd);
  entry(exifIfd + 2, 0x9003, 2, 20, dateAt);
  tiff.write('2023:07:14 09:30:05', dateAt, 'ascii');

  tiff.writeUInt16LE(4, gpsIfd);
  entry(gpsIfd + 2, 0x0001, 2, 2, opts.latRef);
  entry(gpsIfd + 14, 0x0002, 5, 3, latAt);
  entry(gpsIfd + 26, 0x0003, 2, 2, opts.lonRef);
  entry(gpsIfd + 38, 0x0004, 5, 3, lonAt);

  const rationals = (at: number, deg: number, min: number, sec: number) => {
    [deg, min, sec].forEach((n, i) => {
      tiff.writeUInt32LE(n, at + i * 8);
      tiff.writeUInt32LE(opts.zeroDenominator ? 0 : 1, at + i * 8 + 4);
    });
  };
  rationals(latAt, 40, 30, 36); // 40.51
  rationals(lonAt, 73, 45, 0); // 73.75

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

function u32le(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n, 0);
  return b;
}

function buildGif(width: number, height: number, version: '87a' | '89a' = '89a'): Buffer {
  const buf = Buffer.alloc(6 + 7);
  buf.write(`GIF${version}`, 0, 'ascii');
  buf.writeUInt16LE(width, 6);
  buf.writeUInt16LE(height, 8);
  return buf;
}

function buildRiff(fourCc: string, payload: Buffer): Buffer {
  const padded = payload.length % 2 === 1 ? Buffer.concat([payload, Buffer.from([0])]) : payload;
  const chunk = Buffer.concat([Buffer.from(fourCc, 'ascii'), u32le(payload.length), padded]);
  const size = 4 + chunk.length; // "WEBP" + chunk
  return Buffer.concat([Buffer.from('RIFF', 'ascii'), u32le(size), Buffer.from('WEBP', 'ascii'), chunk]);
}

function buildWebpVp8x(width: number, height: number): Buffer {
  const payload = Buffer.alloc(10);
  payload.writeUIntLE(width - 1, 4, 3);
  payload.writeUIntLE(height - 1, 7, 3);
  return buildRiff('VP8X', payload);
}

function buildWebpVp8l(width: number, height: number): Buffer {
  const payload = Buffer.alloc(5);
  payload[0] = 0x2f;
  const bits = ((height - 1) << 14) | (width - 1);
  payload.writeUInt32LE(bits >>> 0, 1);
  return buildRiff('VP8L', payload);
}

function buildWebpVp8(width: number, height: number): Buffer {
  const payload = Buffer.alloc(10);
  payload.set([0x9d, 0x01, 0x2a], 3);
  payload.writeUInt16LE(width, 6);
  payload.writeUInt16LE(height, 8);
  return buildRiff('VP8 ', payload);
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
    name: 'WebP extended format (VP8X) reports canvas size',
    buf: buildWebpVp8x(400, 300),
    expect: { format: 'webp', width: 400, height: 300 },
  },
  {
    name: 'WebP lossless (VP8L)',
    buf: buildWebpVp8l(17, 33),
    expect: { format: 'webp', width: 17, height: 33 },
  },
  {
    name: 'WebP lossy (VP8)',
    buf: buildWebpVp8(640, 480),
    expect: { format: 'webp', width: 640, height: 480 },
  },
  {
    name: 'WebP RIFF container with an unrecognized first chunk',
    buf: buildRiff('ANIM', Buffer.alloc(6)),
    expectError: MalformedImageError,
  },
  {
    name: 'empty file',
    buf: Buffer.alloc(0),
    expectError: UnsupportedFormatError,
  },
  {
    name: 'GIF89a logical screen descriptor',
    buf: buildGif(320, 240, '89a'),
    expect: { format: 'gif', width: 320, height: 240 },
  },
  {
    name: 'GIF87a logical screen descriptor',
    buf: buildGif(16, 16, '87a'),
    expect: { format: 'gif', width: 16, height: 16 },
  },
  {
    name: 'GIF cut off before the logical screen descriptor finishes',
    buf: Buffer.from('GIF89a', 'ascii'),
    expectError: MalformedImageError,
  },
  {
    name: 'JPEG that ends right after SOI, no SOF ever arrives',
    buf: Buffer.from([0xff, 0xd8]),
    expectError: MalformedImageError,
  },
];

test('EXIF timestamp and GPS from the nested Exif and GPS IFDs', () => {
  const app1 = buildFullExifApp1({ latRef: 'N', lonRef: 'E' });
  const meta = readImageMetadata(buildJpeg(64, 48, { app1 }));
  assert.equal(meta.orientation, 3);
  assert.equal(meta.dateTime, '2023:07:14 09:30:05');
  assert.ok(meta.gps);
  assert.ok(Math.abs(meta.gps.latitude - 40.51) < 1e-9);
  assert.ok(Math.abs(meta.gps.longitude - 73.75) < 1e-9);
});

test('southern and western GPS references flip the sign', () => {
  const app1 = buildFullExifApp1({ latRef: 'S', lonRef: 'W' });
  const meta = readImageMetadata(buildJpeg(64, 48, { app1 }));
  assert.ok(meta.gps);
  assert.ok(meta.gps.latitude < 0);
  assert.ok(meta.gps.longitude < 0);
});

test('GPS rationals with a zero denominator are dropped, other fields kept', () => {
  const app1 = buildFullExifApp1({ latRef: 'N', lonRef: 'E', zeroDenominator: true });
  const meta = readImageMetadata(buildJpeg(64, 48, { app1 }));
  assert.equal(meta.gps, undefined);
  assert.equal(meta.dateTime, '2023:07:14 09:30:05');
});

test('JPEG with only an orientation tag has no timestamp or GPS', () => {
  const meta = readImageMetadata(buildJpeg(10, 10, { app1: buildExifApp1(1, true) }));
  assert.equal(meta.dateTime, undefined);
  assert.equal(meta.gps, undefined);
});

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
