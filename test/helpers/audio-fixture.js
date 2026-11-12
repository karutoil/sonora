import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Generated with ffmpeg's anullsrc and native AAC encoder, once per duration:
//   ffmpeg -f lavfi -i anullsrc=r=8000:cl=mono -t 150 -c:a aac -b:a 8k \
//     -movflags +faststart test/fixtures/silent-150.m4a
// ffprobe reports exactly 150/240 seconds, matching each test's room metadata.
// Keeping the real fixtures means browser tests need neither ffmpeg nor network.
const SILENCE = new Map([150, 240].map((seconds) => [seconds,
  fileURLToPath(new URL(`../fixtures/silent-${seconds}.m4a`, import.meta.url)),
]));

export function writeSilentM4a(file, { seconds } = {}) {
  const fixture = SILENCE.get(seconds);
  if (!fixture) throw new Error(`no genuine silent AAC fixture for ${seconds} seconds`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.copyFileSync(fixture, file);
  return file;
}
