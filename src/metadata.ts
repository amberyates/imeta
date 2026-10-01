export type ImageFormat = 'png' | 'jpeg' | 'webp' | 'gif';

export interface GpsPosition {
  /** Decimal degrees, negative for south. */
  latitude: number;
  /** Decimal degrees, negative for west. */
  longitude: number;
}

export interface ImageMetadata {
  format: ImageFormat;
  width: number;
  height: number;
  /** Only ever set for JPEGs that carry an EXIF orientation tag. */
  orientation?: number;
  /** EXIF "YYYY:MM:DD HH:MM:SS" string, as stored; it has no time zone. */
  dateTime?: string;
  gps?: GpsPosition;
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
  let dateTime: string | undefined;
  let gps: GpsPosition | undefined;

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
      const found = parseExif(segment);
      if (found?.orientation !== undefined) orientation = found.orientation;
      if (found?.dateTime !== undefined) dateTime = found.dateTime;
      if (found?.gps !== undefined) gps = found.gps;
    }

    offset = segmentStart + (length - 2);

    if (marker === 0xda /* SOS */) break; // entropy-coded data follows
  }

  if (width === undefined || height === undefined) {
    throw new MalformedImageError('no SOF marker found');
  }
  return { format: 'jpeg', width, height, orientation, dateTime, gps };
}

const EXIF_HEADER = Buffer.from('Exif\0\0', 'ascii');
const TAG_ORIENTATION = 0x0112;
const TAG_DATE_TIME = 0x0132;
const TAG_EXIF_IFD = 0x8769;
const TAG_GPS_IFD = 0x8825;
const TAG_DATE_TIME_ORIGINAL = 0x9003;
const TAG_GPS_LAT_REF = 0x0001;
const TAG_GPS_LAT = 0x0002;
const TAG_GPS_LON_REF = 0x0003;
const TAG_GPS_LON = 0x0004;

const TYPE_ASCII = 2;
const TYPE_SHORT = 3;
const TYPE_RATIONAL = 5;

interface ExifData {
  orientation?: number;
  dateTime?: string;
  gps?: GpsPosition;
}

interface IfdEntry {
  type: number;
  count: number;
  /** Offset of the entry's 4-byte value field, or of the data it points at. */
  dataOffset: number;
  /** True when the value is stored in the 4-byte field rather than elsewhere. */
  inline: boolean;
}

function parseExif(app1: Buffer): ExifData | undefined {
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

  // Camera EXIF is untrusted input: every offset is checked before use, and
  // a bad one just drops that field instead of failing the whole file.
  const typeSize: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1 };

  const readIfd = (ifdOffset: number): Map<number, IfdEntry> => {
    const entries = new Map<number, IfdEntry>();
    if (ifdOffset + 2 > tiff.length) return entries;
    const entryCount = readU16(ifdOffset);
    for (let i = 0; i < entryCount; i++) {
      const entryOffset = ifdOffset + 2 + i * 12;
      if (entryOffset + 12 > tiff.length) break;
      const type = readU16(entryOffset + 2);
      const count = readU32(entryOffset + 4);
      const size = (typeSize[type] ?? 0) * count;
      const inline = size <= 4;
      const dataOffset = inline ? entryOffset + 8 : readU32(entryOffset + 8);
      if (size === 0 || dataOffset + size > tiff.length) continue;
      entries.set(readU16(entryOffset), { type, count, dataOffset, inline });
    }
    return entries;
  };

  const readShort = (e: IfdEntry | undefined): number | undefined =>
    e && e.type === TYPE_SHORT ? readU16(e.dataOffset) : undefined;

  const readAscii = (e: IfdEntry | undefined): string | undefined => {
    if (!e || e.type !== TYPE_ASCII) return undefined;
    const raw = tiff.toString('ascii', e.dataOffset, e.dataOffset + e.count);
    const nul = raw.indexOf('\0');
    return nul === -1 ? raw : raw.slice(0, nul);
  };

  const readPointer = (e: IfdEntry | undefined): number | undefined =>
    e && e.inline && e.count === 1 ? readU32(e.dataOffset) : undefined;

  // Degrees, minutes, seconds as three rationals -> decimal degrees.
  const readDegrees = (e: IfdEntry | undefined): number | undefined => {
    if (!e || e.type !== TYPE_RATIONAL || e.count !== 3) return undefined;
    const parts: number[] = [];
    for (let i = 0; i < 3; i++) {
      const num = readU32(e.dataOffset + i * 8);
      const den = readU32(e.dataOffset + i * 8 + 4);
      if (den === 0) return undefined;
      parts.push(num / den);
    }
    return parts[0] + parts[1] / 60 + parts[2] / 3600;
  };

  const result: ExifData = {};
  const ifd0 = readIfd(readU32(4));
  result.orientation = readShort(ifd0.get(TAG_ORIENTATION));
  result.dateTime = readAscii(ifd0.get(TAG_DATE_TIME));

  const exifOffset = readPointer(ifd0.get(TAG_EXIF_IFD));
  if (exifOffset !== undefined) {
    // DateTimeOriginal is when the shutter fired; IFD0's DateTime is only the
    // last time any software touched the file, so prefer the former.
    const original = readAscii(readIfd(exifOffset).get(TAG_DATE_TIME_ORIGINAL));
    if (original !== undefined) result.dateTime = original;
  }

  const gpsOffset = readPointer(ifd0.get(TAG_GPS_IFD));
  if (gpsOffset !== undefined) {
    const gps = readIfd(gpsOffset);
    const lat = readDegrees(gps.get(TAG_GPS_LAT));
    const lon = readDegrees(gps.get(TAG_GPS_LON));
    if (lat !== undefined && lon !== undefined) {
      result.gps = {
        latitude: readAscii(gps.get(TAG_GPS_LAT_REF)) === 'S' ? -lat : lat,
        longitude: readAscii(gps.get(TAG_GPS_LON_REF)) === 'W' ? -lon : lon,
      };
    }
  }

  return result;
}
