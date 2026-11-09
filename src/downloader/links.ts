import { hostProblem } from './address';

export interface Platform {
  name: string;
  /** Plain explanation of what the platform allows. */
  explanation: string;
  /** What the "official" button should say. */
  openLabel: string;
  /** Is this a store where songs can be bought or downloaded legitimately? */
  store?: boolean;
}

export type LinkSource =
  | { kind: 'web'; url: URL }
  | { kind: 'archive'; url: URL; id: string; file?: string }
  | { kind: 'commons'; url: URL; title: string }
  | { kind: 'platform'; url: URL; platform: Platform };

/** In development only, an automated test may allow its own local test server (never in the published app). */
function testOrigin(): string | null {
  if (!import.meta.env.DEV) return null;
  return (import.meta.env.VITE_SONGSORT_TEST_ORIGIN as string | undefined) ?? null;
}

export function isTestOrigin(url: URL): boolean {
  const t = testOrigin();
  return !!t && url.origin === t;
}

/** Turn what the user pasted into a safe URL, or explain why it can't be used. */
export function parseLink(input: string): { ok: true; url: URL } | { ok: false; message: string } {
  let s = input.trim();
  if (!s) return { ok: false, message: 'Paste a link to a song first.' };
  if (/\s/.test(s)) s = s.split(/\s+/).find((w) => /^[a-z][a-z0-9+.-]*:/i.test(w) || w.includes('.')) ?? s;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s) && /^[\w-]+(\.[\w-]+)+([/?#]|$)/.test(s)) s = 'https://' + s;
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return { ok: false, message: 'That doesn’t look like a web link. Copy the full address of the song, starting with https://' };
  }
  if (isTestOrigin(url)) return { ok: true, url };
  if (url.protocol === 'http:') {
    return { ok: false, message: 'Only secure links (starting with https://) are supported, to protect the file on its way to you.' };
  }
  if (url.protocol !== 'https:') {
    return { ok: false, message: `Links starting with “${url.protocol}” can’t be used. Only web links (https://) are supported.` };
  }
  if (url.username || url.password) return { ok: false, message: 'Links that contain a user name or password are not allowed.' };
  if (url.port && url.port !== '443') return { ok: false, message: 'Links to unusual network ports are not supported.' };
  const problem = hostProblem(url.hostname);
  if (problem) return { ok: false, message: problem };
  return { ok: true, url };
}

const P = (name: string, explanation: string, extra: Partial<Platform> = {}): Platform => ({
  name,
  explanation,
  openLabel: `Open in ${name}`,
  ...extra,
});

const PLATFORMS: [RegExp, Platform][] = [
  [/(^|\.)music\.youtube\.com$/, P('YouTube Music', 'YouTube Music does not allow songs to be downloaded outside its app. With YouTube Music Premium you can save songs for offline listening inside the app.')],
  [/(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/, P('YouTube', 'YouTube does not allow downloading the audio of videos, and SongSort does not get around that. Many artists also sell their music on official stores; see the links below.')],
  [/(^|\.)(spotify\.com|spotify\.link)$/, P('Spotify', 'Spotify songs are protected and can only be played inside Spotify. Spotify Premium can save them for offline listening in the Spotify app, but not as files.')],
  [/(^|\.)(music\.apple\.com|itunes\.apple\.com)$/, P('Apple Music', 'Apple Music songs are protected (DRM) and only play in Apple’s apps. Songs bought on the iTunes Store are yours to download as AAC (M4A) files.')],
  [/(^|\.)(soundcloud\.com|snd\.sc)$/, P('SoundCloud', 'SoundCloud only allows a download when the artist has switched on the Download button on the track’s page. If you see that button on SoundCloud, use it there.')],
  [/(^|\.)bandcamp\.com$/, P('Bandcamp', 'Bandcamp is an official music store. You can buy the song there (or download it free when the artist offers that), usually in MP3, FLAC, AAC, OGG or WAV. Afterwards, paste Bandcamp’s download link here or add the file to your collection.', { store: true })],
  [/(^|\.)(deezer\.com|deezer\.page\.link|dzr\.page\.link)$/, P('Deezer', 'Deezer songs are protected and can only be played inside the Deezer app.')],
  [/(^|\.)(tidal\.com)$/, P('TIDAL', 'TIDAL songs are protected and can only be played inside the TIDAL app.')],
  [/(^|\.)(music\.amazon\.[a-z.]+)$/, P('Amazon Music', 'Amazon Music streaming songs are protected. Songs you buy as MP3 from Amazon can be downloaded from your Amazon account.')],
  [/(^|\.)(jiosaavn\.com|saavn\.com)$/, P('JioSaavn', 'JioSaavn songs are protected and can only be played or saved offline inside the JioSaavn app.')],
  [/(^|\.)(gaana\.com)$/, P('Gaana', 'Gaana songs are protected and can only be played or saved offline inside the Gaana app.')],
  [/(^|\.)(wynk\.in)$/, P('Wynk Music', 'Wynk songs are protected and can only be played or saved offline inside the Wynk app.')],
  [/(^|\.)(hungama\.com)$/, P('Hungama', 'Hungama songs are protected and can only be played or saved offline inside the Hungama app.')],
  [/(^|\.)(audiomack\.com)$/, P('Audiomack', 'Audiomack only allows offline listening inside its app, unless the artist offers a download on the song’s page.')],
  [/(^|\.)(anghami\.com)$/, P('Anghami', 'Anghami songs are protected and can only be played inside the Anghami app.')],
  [/(^|\.)(pandora\.com)$/, P('Pandora', 'Pandora songs are protected and can only be played inside Pandora.')],
  [/(^|\.)(qobuz\.com)$/, P('Qobuz', 'Qobuz streams are protected, but Qobuz also sells downloads (often in FLAC) in its store.', { store: true })],
  [/(^|\.)(napster\.com)$/, P('Napster', 'Napster songs are protected and can only be played inside the Napster app.')],
];

export function classifyLink(url: URL): LinkSource {
  const host = url.hostname.toLowerCase().replace(/^(www|m)\./, '');
  for (const [re, platform] of PLATFORMS) if (re.test(host)) return { kind: 'platform', url, platform };

  if (host === 'archive.org') {
    const m = /^\/(details|download)\/([^/]+)(?:\/(.+))?/.exec(url.pathname);
    if (m) {
      const file = m[3] ? decodeURIComponent(m[3]).replace(/\/+$/, '') : undefined;
      return { kind: 'archive', url, id: decodeURIComponent(m[2]), file: file || undefined };
    }
  }
  if (host === 'commons.wikimedia.org') {
    const fromPath = /^\/wiki\/(File:.+)$/i.exec(url.pathname);
    const fromQuery = url.searchParams.get('title');
    const title = fromPath ? decodeURIComponent(fromPath[1]) : fromQuery?.startsWith('File:') ? fromQuery : null;
    if (title) return { kind: 'commons', url, title: title.replace(/_/g, ' ') };
  }
  return { kind: 'web', url };
}

/** Does the link's path end with an audio file name? (Only a hint — the bytes decide.) */
export function looksLikeAudioPath(url: URL): boolean {
  return /\.(mp3|aac|m4a|mp4|wav|flac|ogg|oga|opus|wma|aif|aiff)$/i.test(url.pathname);
}
