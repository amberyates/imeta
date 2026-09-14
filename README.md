# imeta

A command-line tool that reads the width, height, and (for JPEGs) EXIF
orientation out of image files, without pulling in an image library to do it.

I keep needing this for one-off scripts: "is this upload actually portrait or
did the phone just rotate it," "what resolution did this batch get exported
at." Every time I've reached for a full image library to answer a two-field
question. `imeta` parses just enough of the PNG and JPEG container formats to
answer that question and nothing else.

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

Handles baseline PNG and JPEG. Not yet handled: progressive JPEG component
count edge cases beyond SOF2, WebP, HEIC, GPS/timestamp EXIF fields, and
multi-IFD EXIF blocks. See the issues for what's next.

## License

MIT, see [LICENSE](LICENSE).
