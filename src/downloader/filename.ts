import { FORMATS, type AudioKind } from './sniff';

const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

/**
 * Make a safe file name: no folders ("../"), no characters Windows/macOS/Android forbid, no control
 * characters, not a reserved device name, sensible length — and always the extension of the format
 * the file really is.
 */
export function safeFileName(raw: string | undefined, kind: AudioKind, fallback = 'song'): string {
  let name = (raw ?? '').normalize('NFC');
  name = name.split(/[\\/]/).pop() ?? ''; // never keep folder parts
  name = name
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .replace(/[​-‏‪-‮⁦-⁩]/g, '') // invisible / direction-changing characters
    .replace(/[<>:"|?*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Drop whatever extension it claims; the real format decides.
  name = name.replace(/\.[a-z0-9]{1,5}$/i, '').replace(/[. ]+$/, '').replace(/^[. ]+/, '');
  if (!name || RESERVED.test(name)) name = fallback;
  if (name.length > 120) name = name.slice(0, 120).trim();
  return `${name}.${FORMATS[kind].ext}`;
}

/** File name from a Content-Disposition header, if any. */
export function nameFromDisposition(header: string | null): string | undefined {
  if (!header) return undefined;
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(header);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ''));
    } catch {
      /* fall through */
    }
  }
  const plain = /filename\s*=\s*("([^"]*)"|[^;]+)/i.exec(header);
  return plain ? (plain[2] ?? plain[1]).trim() : undefined;
}

/** File name from the last part of a URL path. */
export function nameFromUrl(url: string): string | undefined {
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop();
    return last ? decodeURIComponent(last) : undefined;
  } catch {
    return undefined;
  }
}

/** "Artist - Title" when both are known. */
export function nameFromTags(title?: string, artist?: string): string | undefined {
  if (!title) return undefined;
  return artist ? `${artist} - ${title}` : title;
}
