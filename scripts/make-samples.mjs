// Generates a small test music collection in ./test-samples with known duplicates.
// Run: npm run make-samples
import { mkdirSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'test-samples');
rmSync(root, { recursive: true, force: true });

/* ---------- WAV with RIFF INFO tags ---------- */
function infoChunk(tags) {
  const subs = [];
  for (const [id, value] of Object.entries(tags)) {
    if (!value) continue;
    const text = Buffer.from(value + '\0', 'latin1');
    const pad = text.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0);
    const head = Buffer.alloc(8);
    head.write(id, 0, 'ascii');
    head.writeUInt32LE(text.length, 4);
    subs.push(head, text, pad);
  }
  if (!subs.length) return Buffer.alloc(0);
  const body = Buffer.concat([Buffer.from('INFO'), ...subs]);
  const head = Buffer.alloc(8);
  head.write('LIST', 0, 'ascii');
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
}

function wav({ seconds, freq, amp = 0.4, title, artist, album }) {
  const rate = 8000;
  const n = Math.round(seconds * rate);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * amp * 32767), i * 2);
  const fmt = Buffer.alloc(24);
  fmt.write('fmt ', 0, 'ascii');
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(1, 8); // PCM
  fmt.writeUInt16LE(1, 10); // mono
  fmt.writeUInt32LE(rate, 12);
  fmt.writeUInt32LE(rate * 2, 16);
  fmt.writeUInt16LE(2, 20);
  fmt.writeUInt16LE(16, 22);
  const dataHead = Buffer.alloc(8);
  dataHead.write('data', 0, 'ascii');
  dataHead.writeUInt32LE(data.length, 4);
  const info = infoChunk({ INAM: title, IART: artist, IPRD: album });
  const body = Buffer.concat([Buffer.from('WAVE'), fmt, info, dataHead, data]);
  const riff = Buffer.alloc(8);
  riff.write('RIFF', 0, 'ascii');
  riff.writeUInt32LE(body.length, 4);
  return Buffer.concat([riff, body]);
}

/* ---------- MP3 with ID3v2.3 tags and silent MPEG-1 Layer III frames ---------- */
function id3(tags) {
  const frames = [];
  for (const [id, value] of Object.entries(tags)) {
    if (!value) continue;
    const text = Buffer.concat([Buffer.from([0]), Buffer.from(value, 'latin1')]);
    const head = Buffer.alloc(10);
    head.write(id, 0, 'ascii');
    head.writeUInt32BE(text.length, 4);
    frames.push(head, text);
  }
  const body = Buffer.concat(frames);
  const size = body.length;
  const head = Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, (size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f]);
  return Buffer.concat([head, body]);
}

function mp3({ seconds, kbps = 128, title, artist, album }) {
  const bitrateIndex = { 128: 0b1001, 160: 0b1010, 192: 0b1011 }[kbps];
  const frameLen = Math.floor((144 * kbps * 1000) / 44100);
  const frames = Math.round((seconds * 44100) / 1152);
  const frame = Buffer.alloc(frameLen);
  frame[0] = 0xff;
  frame[1] = 0xfb;
  frame[2] = (bitrateIndex << 4) | 0b0000; // 44.1 kHz, no padding
  frame[3] = 0x64;
  const audio = Buffer.concat(Array.from({ length: frames }, () => frame));
  return Buffer.concat([id3({ TIT2: title, TPE1: artist, TALB: album }), audio]);
}

/* ---------- the collection ---------- */
const files = [];
function put(rel, buf) {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, buf);
  files.push(rel);
}
function copy(fromRel, toRel) {
  const to = join(root, toRel);
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(join(root, fromRel), to);
  files.push(toRel);
}

// My Music
put('My Music/Morning Light.wav', wav({ seconds: 12, freq: 440, title: 'Morning Light', artist: 'Test Band', album: 'Sunrise' }));
put('My Music/Evening Song.mp3', mp3({ seconds: 10, kbps: 128, title: 'Evening Song', artist: 'Nova', album: 'Night' }));
put('My Music/Track01.wav', wav({ seconds: 9, freq: 330, title: 'Ocean Drive', artist: 'Blue Coast' }));
put('My Music/Shared Name.wav', wav({ seconds: 8, freq: 500, title: 'Alpha', artist: 'X' }));
put('My Music/01 Rain Dance.wav', wav({ seconds: 7, freq: 600 }));
put('My Music/Morning Light (Live).wav', wav({ seconds: 15, freq: 450, title: 'Morning Light (Live)', artist: 'Test Band' }));
put('My Music/broken.mp3', Buffer.from(Array.from({ length: 5000 }, (_, i) => (i * 7919) % 251)));
put('My Music/empty.mp3', Buffer.alloc(0));
put('My Music/._Morning Light.wav', Buffer.from('Mac OS X resource fork, not audio'));
put('My Music/cover.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xd9]));

// Backup (another source folder)
copy('My Music/Morning Light.wav', 'Backup/Morning Light.wav'); // exact duplicate
copy('My Music/Morning Light.wav', 'Backup/Morning Light (1).wav'); // exact duplicate
put('Backup/Evening Song 320.mp3', mp3({ seconds: 10, kbps: 160, title: 'Evening Song', artist: 'Nova', album: 'Night' })); // re-encode
put('Backup/Shared Name.wav', wav({ seconds: 8, freq: 520, title: 'Beta', artist: 'Y' })); // different song, same file name
put('Backup/Rain Dance (1).wav', wav({ seconds: 7, freq: 610 })); // untagged, same name pattern, different content
put('Backup/Ocean Drive.wav', wav({ seconds: 9, freq: 335, title: 'Ocean Drive', artist: 'Different Artist' })); // same title, other artist
put('Backup/Morning Light remaster.wav', wav({ seconds: 30, freq: 445, title: 'Morning Light', artist: 'Test Band' })); // much longer version

// "FILM = SONG" names with different spellings, no tags
put('Old Songs/27 HASINA MAAN JAYEGI = CHALE THE SAATH MILKE.wav', wav({ seconds: 11, freq: 700 }));
put('Old Songs/CHALE THE SAATH MILKAR.wav', wav({ seconds: 11.4, freq: 705 })); // same song, other spelling -> potential
put('Old Songs/12 KHILONA = KHUSH RAHE TU SADA.wav', wav({ seconds: 6, freq: 720 }));
put('Old Songs/KHUSH RAHE TU SADAA.wav', wav({ seconds: 13, freq: 730 })); // similar name but 7s longer -> not flagged

writeFileSync(join(root, 'manifest.json'), JSON.stringify(files, null, 2));
console.log(`Wrote ${files.length} test files to ${root}`);
