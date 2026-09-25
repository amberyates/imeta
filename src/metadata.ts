export type ImageFormat = 'png' | 'jpeg' | 'webp' | 'gif';

export interface ImageMetadata {
  format: ImageFormat;
  width: number;
  height: number;
  /** Only ever set for JPEGs that carry an EXIF orientation tag. */
  orientation?: number;
}

export class UnsupportedFormatError extends Error {
  constructor(message = 'not a recognized PNG or JPEG file') {
    super(message);
    this.name = 'UnsupportedFormatError';
  }
}

export class MalformedImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MalformedImageError';
  }
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function readImageMetadata(buf: Buffer): ImageMetadata {
  if (buf.length >= PNG_SIGNATURE.length && buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return parsePng(buf);
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xd8) {
    return parseJpeg(buf);
  }
  if (
    buf.length >= 12 &&
    buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return parseWebp(buf);
  }
  if (
    buf.length >= 6 &&
    buf.toString('ascii', 0, 3) === 'GIF' &&
    (buf.toString('ascii', 3, 6) === '87a' || buf.toString('ascii', 3, 6) === '89a')
  ) {
    return parseGif(buf);
  }
  throw new UnsupportedFormatError();
}

function parsePng(buf: Buffer): ImageMetadata {
  // The PNG spec requires IHDR to be the very first chunk, so we don't
  // need a general chunk walker just to find width and height.
  if (buf.length < 8 + 8 + 13) {
    throw new MalformedImageError('PNG file is too short to contain an IHDR chunk');
  }
  const chunkType = buf.toString('ascii', 12, 16);
  if (chunkType !== 'IHDR') {
    throw new MalformedImageError(`expected IHDR as the first chunk, found "${chunkType}"`);
  }
  return {
    format: 'png',
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
  };
}

// The Logical Screen Descriptor follows the 6-byte "GIF87a"/"GIF89a" header
// directly: width and height are the first two fields, both little-endian
// 16-bit, so there's no need to walk into the color table or image blocks.
function parseGif(buf: Buffer): ImageMetadata {
  if (buf.length < 6 + 7) {
    throw new MalformedImageError('GIF file is too short to contain a logical screen descriptor');
  }
  return {
    format: 'gif',
    width: buf.readUInt16LE(6),
    height: buf.readUInt16LE(8),
  };
}

// A WEBP file is a RIFF container holding exactly one of three chunk types,
// each of which encodes width/height differently. VP8X (the "extended"
// header, used for animation, alpha, or tiling) carries the canvas size
// directly, so we don't need to walk into the frame chunks that follow it.
const VP8L_SIGNATURE = 0x2f;
const VP8_START_CODE = Buffer.from([0x9d, 0x01, 0x2a]);

function parseWebp(buf: Buffer): ImageMetadata {
  if (buf.length < 20) {
    throw new MalformedImageError('WEBP file is too short to contain a chunk header');
  }
  const fourCc = buf.toString('ascii', 12, 16);
  const chunkSize = buf.readUInt32LE(16);
  const payloadStart = 20;
  if (payloadStart + chunkSize > buf.length) {
    throw new MalformedImageError('WEBP chunk size runs past end of file');
  }

  if (fourCc === 'VP8X') {
    if (chunkSize < 10) {
      throw new MalformedImageError('VP8X chunk is too short to contain canvas dimensions');
    }
    const width = 1 + buf.readUIntLE(payloadStart + 4, 3);
    const height = 1 + buf.readUIntLE(payloadStart + 7, 3);
    return { format: 'webp', width, height };
  }

  if (fourCc === 'VP8L') {
    if (chunkSize < 5 || buf[payloadStart] !== VP8L_SIGNATURE) {
      throw new MalformedImageError('malformed VP8L chunk');
    }
    const bits = buf.readUInt32LE(payloadStart + 1);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >>> 14) & 0x3fff) + 1;
    return { format: 'webp', width, height };
  }

  if (fourCc === 'VP8 ') {
    if (chunkSize < 10 || !buf.subarray(payloadStart + 3, payloadStart + 6).equals(VP8_START_CODE)) {
      throw new MalformedImageError('malformed VP8 chunk');
    }
    const width = buf.readUInt16LE(payloadStart + 6) & 0x3fff;
    const height = buf.readUInt16LE(payloadStart + 8) & 0x3fff;
    return { format: 'webp', width, height };
  }

  throw new MalformedImageError(`expected VP8X, VP8L or VP8 as the first chunk, found "${fourCc}"`);
}

// SOFn markers that actually carry frame dimensions. 0xC4, 0xC8 and 0xCC
// share the numeric range but are DHT / JPG-extension / DAC, not SOF.
const SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);
// Markers with no length field / payload of their own.
const STANDALONE_MARKERS = new Set([
  0x01, 0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9,
]);

function parseJpeg(buf: Buffer): ImageMetadata {
  let offset = 2; // past SOI
  let width: number | undefined;
  let height: number | undefined;
  let orientation: number | undefined;

  while (offset < buf.length) {
    if (buf[offset] !== 0xff) {
      throw new MalformedImageError(`expected a marker at byte ${offset}`);
    }
    // A marker code can be preceded by 0xFF fill bytes.
    let markerOffset = offset + 1;
    while (buf[markerOffset] === 0xff) markerOffset++;
    const marker = buf[markerOffset];
    offset = markerOffset + 1;

    if (marker === 0xd9 /* EOI */) break;
    if (STANDALONE_MARKERS.has(marker)) continue;

    if (offset + 2 > buf.length) {
      throw new MalformedImageError('truncated segment header');
    }
    const length = buf.readUInt16BE(offset); // includes these 2 length bytes
    const segmentStart = offset + 2;
    if (segmentStart + (length - 2) > buf.length) {
      throw new MalformedImageError('segment length runs past end of file');
    }

    if (SOF_MARKERS.has(marker)) {
      height = buf.readUInt16BE(segmentStart + 1);
      width = buf.readUInt16BE(segmentStart + 3);
    } else if (marker === 0xe1 /* APP1 */) {
      const segment = buf.subarray(segmentStart, segmentStart + length - 2);
      const found = tryReadExifOrientation(segment);
      if (found !== undefined) orientation = found;
    }

    offset = segmentStart + (length - 2);

    if (marker === 0xda /* SOS */) break; // entropy-coded data follows
  }

  if (width === undefined || height === undefined) {
    throw new MalformedImageError('no SOF marker found');
  }
  return { format: 'jpeg', width, height, orientation };
}

const EXIF_HEADER = Buffer.from('Exif\0\0', 'ascii');
const ORIENTATION_TAG = 0x0112;

function tryReadExifOrientation(app1: Buffer): number | undefined {
  if (app1.length < EXIF_HEADER.length || !app1.subarray(0, 6).equals(EXIF_HEADER)) {
    return undefined;
  }
  const tiff = app1.subarray(6);
  if (tiff.length < 8) return undefined;

  const byteOrderMark = tiff.toString('ascii', 0, 2);
  let littleEndian: boolean;
  if (byteOrderMark === 'II') littleEndian = true;
  else if (byteOrderMark === 'MM') littleEndian = false;
  else return undefined;

  const readU16 = (off: number): number =>
    littleEndian ? tiff.readUInt16LE(off) : tiff.readUInt16BE(off);
  const readU32 = (off: number): number =>
    littleEndian ? tiff.readUInt32LE(off) : tiff.readUInt32BE(off);

  if (readU16(2) !== 42) return undefined; // TIFF magic number

  const ifdOffset = readU32(4);
  if (ifdOffset + 2 > tiff.length) return undefined;

  const entryCount = readU16(ifdOffset);
  const entriesStart = ifdOffset + 2;
  for (let i = 0; i < entryCount; i++) {
    const entryOffset = entriesStart + i * 12;
    if (entryOffset + 12 > tiff.length) break;
    if (readU16(entryOffset) === ORIENTATION_TAG) {
      // SHORT values live in the first two bytes of the 4-byte value field.
      return readU16(entryOffset + 8);
    }
  }
  return undefined;
}
