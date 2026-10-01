#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { readImageMetadata, UnsupportedFormatError, MalformedImageError } from './metadata.js';

function usage(): never {
  process.stderr.write('usage: imeta [--json] <file>\n');
  process.exit(2);
}

function main(argv: string[]): void {
  const args = argv.slice(2);
  let json = false;
  const files: string[] = [];

  for (const arg of args) {
    if (arg === '--json') json = true;
    else if (arg === '--help' || arg === '-h') usage();
    else files.push(arg);
  }
  if (files.length !== 1) usage();

  const path = files[0];
  let buf: Buffer;
  try {
    buf = readFileSync(path);
  } catch (err) {
    process.stderr.write(`imeta: cannot read ${path}: ${(err as Error).message}\n`);
    process.exit(1);
  }

  try {
    const meta = readImageMetadata(buf);
    if (json) {
      process.stdout.write(JSON.stringify(meta) + '\n');
    } else {
      process.stdout.write(`format:      ${meta.format}\n`);
      process.stdout.write(`width:       ${meta.width}\n`);
      process.stdout.write(`height:      ${meta.height}\n`);
      if (meta.orientation !== undefined) {
        process.stdout.write(`orientation: ${meta.orientation}\n`);
      }
      if (meta.dateTime !== undefined) {
        process.stdout.write(`taken:       ${meta.dateTime}\n`);
      }
      if (meta.gps !== undefined) {
        process.stdout.write(`gps:         ${meta.gps.latitude.toFixed(6)}, ${meta.gps.longitude.toFixed(6)}\n`);
      }
    }
  } catch (err) {
    if (err instanceof UnsupportedFormatError || err instanceof MalformedImageError) {
      process.stderr.write(`imeta: ${path}: ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }
}

main(process.argv);
