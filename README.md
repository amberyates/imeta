# imeta

A command-line tool that reads the width, height, and (for JPEGs) EXIF
orientation out of image files, without pulling in an image library to do it.

I keep needing this for one-off scripts: "is this upload actually portrait or
did the phone just rotate it," "what resolution did this batch get exported
at." Every time I've reached for a full image library to answer a two-field
question. `imeta` parses just enough of the PNG, JPEG, WebP, and GIF container
formats to answer that question and nothing else.

## Usage

```
$ imeta photo.jpg
format:      jpeg
width:       4032
height:      3024
orientation: 6

$ imeta icon.png
format:      png
width:       512
height:      512

$ imeta --json photo.jpg
{"format":"jpeg","width":4032,"height":3024,"orientation":6}
```

`orientation` is only printed when the file actually carries an EXIF
orientation tag - most PNGs and many JPEGs won't have one.

Exit code is `1` if the file can't be read or isn't a PNG/JPEG, `2` if the
arguments are wrong.

## How it works

- PNG: the spec guarantees the IHDR chunk is the first thing after the
  8-byte signature, so width and height are read straight out of two fixed
  offsets.
- JPEG: the file is a sequence of markers. We walk them looking for a SOFn
  marker (frame dimensions) and an APP1 marker whose payload starts with
  `Exif\0\0` (a TIFF structure we walk to find the Orientation tag, tag
  `0x0112`). We stop as soon as we hit the start-of-scan marker, since actual
  pixel data follows and there's nothing left to read.
- WebP: a RIFF container whose first chunk is one of `VP8X` (extended
  header - width/height are stored directly, minus one, as 24-bit fields;
  this is also what's present on animated or alpha WebPs), `VP8L` (lossless
  - width/height minus one are packed into a 32-bit field starting right
  after the `0x2f` signature byte), or `VP8 ` (lossy - width/height are
  14-bit fields following the three-byte `0x9d012a` start code). There's no
  EXIF orientation support for WebP yet.
- GIF: width and height are the first two fields of the Logical Screen
  Descriptor, right after the 6-byte `GIF87a`/`GIF89a` header - both
  little-endian 16-bit, no need to touch the color table or any image
  blocks that follow.

No image is ever decoded - only headers are touched, so this is safe and
fast even on large files.

## Building

```
npm install
npm run build
node dist/cli.js some-photo.jpg
```

Has no runtime dependencies. `typescript` and `@types/node` are dev-only,
needed to compile the tool, not to run it.

## Testing

```
npm run build
npm test
```

`src/metadata.test.ts` is a table of cases, each built as a small synthetic
buffer, covering the formats and the awkward edges: truncated chunks, both
EXIF byte orders, files with no EXIF at all, and inputs that aren't images.

## Status

Handles baseline PNG, JPEG, WebP, and GIF dimensions. Not yet handled:
progressive JPEG component count edge cases beyond SOF2, HEIC, WebP EXIF
orientation, GPS/timestamp EXIF fields, and multi-IFD EXIF blocks. See the
issues for what's next.

## License

MIT, see [LICENSE](LICENSE).
