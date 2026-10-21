import fs from 'node:fs';
import path from 'node:path';

/**
 * A real, playable WAV written under an `.m4a` name — a fixture for the audio
 * path.
 *
 * The cache serves whatever file sits at `<SONORA_AUDIO_DIR>/<id>.m4a`, and
 * Chromium sniffs the container rather than trusting the extension, so this
 * exercises genuine `<audio>` playback with no ffmpeg, no yt-dlp and no
 * network. 8 kHz mono 16-bit keeps it ~16 KB per second; a 40 s fixture is
 * ~640 KB, which is why the tests that use it clean up after themselves.
 */
export function writeWav(file, { seconds = 40, freq = 440, rate = 8000 } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const samples = Math.floor(seconds * rate);
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    // Quiet on purpose: a fixture should not be audible if a run leaks a tab.
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 2200), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([header, data]));
  return file;
}
