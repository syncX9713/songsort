/**
 * Address rules shared by the browser and the local download helper.
 * SongSort only talks to public internet addresses: never this computer, the home/office network,
 * or special-purpose ranges (this is what protects against "SSRF").
 */

function ipv4Parts(ip: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const p = m.slice(1).map(Number);
  return p.every((x) => x <= 255) ? p : null;
}

export function isBlockedIPv4(ip: string): boolean {
  const p = ipv4Parts(ip);
  if (!p) return false;
  const [a, b, c] = p;
  return (
    a === 0 || // "this" network
    a === 10 || // private
    a === 127 || // this computer
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local (incl. cloud metadata 169.254.169.254)
    (a === 172 && b >= 16 && b <= 31) || // private
    (a === 192 && b === 0 && (c === 0 || c === 2)) || // IETF / documentation
    (a === 192 && b === 88 && c === 99) || // 6to4 relay
    (a === 192 && b === 168) || // private
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51 && c === 100) || // documentation
    (a === 203 && b === 0 && c === 113) || // documentation
    a >= 224 // multicast + reserved + broadcast
  );
}

/** Expand an IPv6 address to 8 numbers, or null. */
function ipv6Words(ip: string): number[] | null {
  let s = ip.toLowerCase();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  if (!s.includes(':')) return null;
  // Embedded IPv4 at the end (e.g. ::ffff:127.0.0.1)
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4) {
    const p = ipv4Parts(v4[1]);
    if (!p) return null;
    s = s.slice(0, -v4[1].length) + ((p[0] << 8) | p[1]).toString(16) + ':' + ((p[2] << 8) | p[3]).toString(16);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 && missing !== 0) return null;
  if (missing < 0) return null;
  const words = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail].map((w) => parseInt(w, 16));
  return words.length === 8 && words.every((w) => Number.isInteger(w) && w >= 0 && w <= 0xffff) ? words : null;
}

export function isBlockedIPv6(ip: string): boolean {
  const w = ipv6Words(ip);
  if (!w) return false;
  const all0 = (from: number, to: number) => w.slice(from, to).every((x) => x === 0);
  if (all0(0, 8)) return true; // ::
  if (all0(0, 7) && w[7] === 1) return true; // ::1
  // IPv4-mapped / -compatible addresses are never needed for public websites: always blocked.
  if (all0(0, 5) && (w[5] === 0xffff || w[5] === 0)) return true;
  // NAT64: judge the embedded IPv4 address
  const embedded = `${w[6] >> 8}.${w[6] & 255}.${w[7] >> 8}.${w[7] & 255}`;
  if (w[0] === 0x64 && w[1] === 0xff9b) return isBlockedIPv4(embedded);
  if ((w[0] & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
  if ((w[0] & 0xffc0) === 0xfe80) return true; // link-local
  if ((w[0] & 0xff00) === 0xff00) return true; // multicast
  if (w[0] === 0x2001 && w[1] === 0x0db8) return true; // documentation
  if (w[0] === 0x0100 && all0(1, 4)) return true; // discard prefix
  if (w[0] === 0x2002) return true; // 6to4 (can tunnel to private IPv4)
  return false;
}

export function isBlockedIP(ip: string): boolean {
  return ipv4Parts(ip) ? isBlockedIPv4(ip) : isBlockedIPv6(ip);
}

const LOCAL_NAMES = /(^|\.)(localhost|local|internal|intranet|lan|home|corp|arpa|localdomain)$/i;

/**
 * Check a host name before any request. Returns a reason if it is not allowed.
 * (The local helper additionally checks every address the name resolves to.)
 */
export function hostProblem(hostname: string): string | null {
  const h = hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!h) return 'The link has no website address.';
  if (ipv4Parts(h)) return isBlockedIPv4(h) ? 'Links to this computer or to private networks are not allowed.' : null;
  if (h.includes(':')) return isBlockedIPv6(h) ? 'Links to this computer or to private networks are not allowed.' : null;
  if (/^\d+$/.test(h) || /^0x[0-9a-f]+$/.test(h)) return 'This kind of address is not allowed.';
  if (LOCAL_NAMES.test(h) || !h.includes('.')) return 'Links to this computer or to private networks are not allowed.';
  return null;
}
