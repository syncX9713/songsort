/** What this browser can actually do. Never assume more than this. */
export interface Capabilities {
  /** File System Access API: pick a folder and read it (Chrome / Edge / Opera on desktop). */
  pickDirectory: boolean;
  /** Classic folder upload input (most desktop browsers). */
  directoryInput: boolean;
  /** Can write organized folders straight to disk. */
  writeDirectory: boolean;
  /** Can stream a ZIP straight to a file chosen by the user. */
  saveFilePicker: boolean;
  isMobile: boolean;
  isIOS: boolean;
  isAndroid: boolean;
}

function detect(): Capabilities {
  const ua = navigator.userAgent;
  const isIOS =
    /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isAndroid = /Android/i.test(ua);
  const isMobile = isIOS || isAndroid || /Mobi/i.test(ua);
  const w = window as unknown as Record<string, unknown>;
  const pickDirectory = typeof w.showDirectoryPicker === 'function' && window.isSecureContext;
  const input = document.createElement('input');
  const directoryInput = 'webkitdirectory' in input && !isMobile;
  return {
    pickDirectory,
    directoryInput,
    writeDirectory: pickDirectory,
    saveFilePicker: typeof w.showSaveFilePicker === 'function' && window.isSecureContext,
    isMobile,
    isIOS,
    isAndroid,
  };
}

export const caps: Capabilities = detect();

export const AUDIO_EXTENSIONS = [
  'mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'oga', 'opus', 'wma', 'aif', 'aiff',
] as const;

export const ACCEPT_ATTR =
  'audio/*,' + AUDIO_EXTENSIONS.map((e) => '.' + e).join(',');
