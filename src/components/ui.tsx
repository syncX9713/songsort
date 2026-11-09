import { useEffect, useRef, useState, type ReactNode } from 'react';

type IconName =
  | 'folder' | 'files' | 'music' | 'check' | 'copy' | 'alert' | 'play' | 'pause' | 'download'
  | 'x' | 'plus' | 'shield' | 'clock' | 'drive' | 'phone' | 'info' | 'arrow';

const PATHS: Record<IconName, ReactNode> = {
  folder: <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h3.6l2 2.2h7.4A2.5 2.5 0 0 1 21 9.7v7.8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z" />,
  files: <><path d="M8 3h7l4 4v11a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" /><path d="M15 3v4h4" /><path d="M3 8v11a2 2 0 0 0 2 2h9" /></>,
  music: <><path d="M9 18V5l11-2v13" /><circle cx="6.5" cy="18" r="2.5" /><circle cx="17.5" cy="16" r="2.5" /></>,
  check: <path d="M5 12.5l4.2 4.2L19 7" />,
  copy: <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></>,
  alert: <><path d="M12 3.5l9.5 16.5h-19z" /><path d="M12 10v4.5" /><path d="M12 17.6v.1" /></>,
  play: <path d="M8 5.5v13l11-6.5z" />,
  pause: <><path d="M8 5v14" /><path d="M16 5v14" /></>,
  download: <><path d="M12 4v11" /><path d="M7 10.5l5 5 5-5" /><path d="M4.5 19.5h15" /></>,
  x: <><path d="M6 6l12 12" /><path d="M18 6L6 18" /></>,
  plus: <><path d="M12 5v14" /><path d="M5 12h14" /></>,
  shield: <><path d="M12 3l8 3v6c0 4.5-3.4 8.2-8 9-4.6-.8-8-4.5-8-9V6z" /><path d="M8.5 12l2.5 2.5 4.5-5" /></>,
  clock: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>,
  drive: <><rect x="3" y="13" width="18" height="7" rx="2" /><path d="M5 13l2.5-8h9L19 13" /><path d="M7 16.5h.1" /></>,
  phone: <><rect x="6.5" y="2.5" width="11" height="19" rx="2.5" /><path d="M11 18.5h2" /></>,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5.5" /><path d="M12 7.6v.1" /></>,
  arrow: <><path d="M5 12h14" /><path d="M13 6l6 6-6 6" /></>,
};

export function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  );
}

export function ProgressBar({ value, label }: { value: number; label?: string }) {
  const pct = Math.max(0, Math.min(100, value * 100));
  return (
    <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} aria-label={label}>
      <div className="progress-fill" style={{ width: `${pct}%` }} />
    </div>
  );
}

/**
 * One shared audio player so users can listen before deciding.
 * The file is played straight from their device; an object URL is created only on demand.
 */
let activeStop: (() => void) | null = null;

export function PlayButton({ file }: { file: File }) {
  const [playing, setPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);

  const stop = () => {
    audioRef.current?.pause();
    audioRef.current = null;
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = null;
    setPlaying(false);
  };

  useEffect(() => () => stop(), []);

  const toggle = () => {
    if (playing) {
      stop();
      activeStop = null;
      return;
    }
    activeStop?.();
    const url = URL.createObjectURL(file);
    urlRef.current = url;
    const audio = new Audio(url);
    audioRef.current = audio;
    audio.onended = () => stop();
    audio.onerror = () => {
      stop();
      alert('This browser cannot play this file format. You can still organize it.');
    };
    audio.play().then(
      () => setPlaying(true),
      () => stop(),
    );
    activeStop = stop;
  };

  return (
    <button type="button" className={`btn-icon ${playing ? 'is-playing' : ''}`} onClick={toggle} aria-label={playing ? 'Stop preview' : 'Play preview'} title={playing ? 'Stop' : 'Listen'}>
      <Icon name={playing ? 'pause' : 'play'} size={16} />
    </button>
  );
}
