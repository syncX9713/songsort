import { useEffect, useRef, useState } from 'react';
import { formatBytes, plural } from '../lib/format';
import type { ScanSummary } from '../lib/history';
import { ACCEPT_ATTR, caps } from '../lib/platform';
import type { Selection } from '../lib/select';
import { Icon } from './ui';

interface Props {
  selection: Selection;
  listing: { found: number } | null;
  error: string | null;
  /** null while loading */
  history: ScanSummary[] | null;
  historyAvailable: boolean;
  rescanBusy: boolean;
  onPickDirectory: () => void;
  onFiles: (files: FileList) => void;
  onCancelListing: () => void;
  onClear: () => void;
  onScan: () => void;
  onClearHistory: () => void;
  onViewScan: (id: string) => void;
  onRescan: (id: string) => void;
  onDownloadLink: (url: string) => void;
}

export function Home(p: Props) {
  const fileInput = useRef<HTMLInputElement>(null);
  const dirInput = useRef<HTMLInputElement>(null);
  const [chooser, setChooser] = useState(false);
  const [songLink, setSongLink] = useState('');

  useEffect(() => {
    dirInput.current?.setAttribute('webkitdirectory', '');
    dirInput.current?.setAttribute('directory', '');
  }, []);

  // Close the chooser on Escape or a click elsewhere.
  useEffect(() => {
    if (!chooser) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setChooser(false);
    const onDown = (e: PointerEvent) => {
      if (!(e.target as Element).closest?.('.pick-wrap')) setChooser(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onDown);
    };
  }, [chooser]);

  // A new selection (or clearing it) closes the chooser.
  useEffect(() => setChooser(false), [p.selection, p.listing]);

  const canPickFolder = caps.pickDirectory || caps.directoryInput;
  const pickFolder = () => {
    setChooser(false);
    if (caps.pickDirectory) p.onPickDirectory();
    else dirInput.current?.click();
  };
  const pickFiles = () => {
    setChooser(false);
    fileInput.current?.click();
  };
  const onMainButton = () => (canPickFolder ? setChooser((v) => !v) : pickFiles());

  const sel = p.selection;
  const hasSelection = sel.files.length > 0;
  const totalBytes = sel.files.reduce((a, f) => a + f.size, 0);

  const hiddenInputs = (
    <>
      <input
        ref={fileInput}
        type="file"
        multiple
        accept={ACCEPT_ATTR}
        hidden
        onChange={(e) => {
          if (e.target.files?.length) p.onFiles(e.target.files);
          e.target.value = '';
        }}
      />
      <input
        ref={dirInput}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files?.length) p.onFiles(e.target.files);
          e.target.value = '';
        }}
      />
    </>
  );

  const chooserMenu = chooser && (
    <div className="chooser" role="menu">
      <button type="button" className="chooser-option" onClick={pickFolder} role="menuitem">
        <span className="chooser-icon"><Icon name="folder" size={22} /></span>
        <span>
          <strong>A folder or drive</strong>
          <small>Includes every song in its sub-folders. Works with USB pen drives and external hard drives too.</small>
        </span>
      </button>
      <button type="button" className="chooser-option" onClick={pickFiles} role="menuitem">
        <span className="chooser-icon"><Icon name="files" size={22} /></span>
        <span>
          <strong>Individual songs</strong>
          <small>Pick one or many music files.</small>
        </span>
      </button>
    </div>
  );

  return (
    <div className="home">
      {hiddenInputs}
      <section className="hero">
        <h1>Clean your music collection.</h1>
        <p className="lead">
          SongSort finds duplicate songs and separates them from your unique music. It never deletes anything,
          and your music never leaves this device.
        </p>
      </section>

      <section className="panel pick-panel" aria-labelledby="organize-title">
        <h2 id="organize-title" className="panel-title">
          <Icon name="music" /> Organize My Music
        </h2>

        {p.listing ? (
          <div className="listing">
            <div className="spinner" aria-hidden="true" />
            <div>
              <strong>Looking for music…</strong>
              <div className="muted">{plural(p.listing.found, 'music file')} found so far</div>
            </div>
            <button type="button" className="btn btn-ghost" onClick={p.onCancelListing}>Cancel</button>
          </div>
        ) : !hasSelection ? (
          <div className="pick-empty">
            <div className="pick-wrap">
              <button type="button" className="btn btn-primary btn-huge" onClick={onMainButton} aria-expanded={canPickFolder ? chooser : undefined}>
                <Icon name="folder" size={24} /> Select Music Folder / Files
              </button>
              {chooserMenu}
            </div>
            <p className="muted small center">
              MP3, WAV, M4A, AAC, FLAC, OGG and WMA files are supported.
            </p>
          </div>
        ) : (
          <div className="selection">
            <div className="selection-head">
              <span className="selection-icon"><Icon name={sel.labels.length === 1 && sel.files.length > 1 ? 'folder' : 'files'} size={22} /></span>
              <div className="selection-name">
                <div className="muted small">Selected</div>
                <strong title={sel.labels.join(', ')}>{sel.labels.join(', ')}</strong>
              </div>
            </div>
            <dl className="selection-stats">
              <div>
                <dt>Music files</dt>
                <dd>{sel.files.length.toLocaleString()}</dd>
              </div>
              <div>
                <dt>Total size</dt>
                <dd>{formatBytes(totalBytes)}</dd>
              </div>
            </dl>
            {(sel.otherFiles > 0 || sel.ignoredFiles > 0 || sel.skippedFolders.length > 0) && (
              <ul className="notes">
                {sel.otherFiles > 0 && <li>{plural(sel.otherFiles, 'other file')} (pictures, documents…) will be left out.</li>}
                {sel.ignoredFiles > 0 && <li>{plural(sel.ignoredFiles, 'hidden system file')} that only {sel.ignoredFiles === 1 ? 'looks' : 'look'} like music will be left out.</li>}
                {sel.skippedFolders.length > 0 && (
                  <li>
                    {plural(sel.skippedFolders.length, 'item')} skipped:{' '}
                    {sel.skippedFolders.slice(0, 3).map((s) => `${s.path} (${s.reason})`).join('; ')}
                    {sel.skippedFolders.length > 3 && '…'}
                  </li>
                )}
              </ul>
            )}
            <button type="button" className="btn btn-primary btn-huge" onClick={p.onScan}>
              <Icon name="check" size={22} /> Scan Music
            </button>
            <div className="selection-actions">
              <div className="pick-wrap">
                <button type="button" className="btn btn-ghost" onClick={onMainButton}>
                  <Icon name="plus" size={18} /> Add more music
                </button>
                {chooserMenu}
              </div>
              <button type="button" className="btn btn-ghost" onClick={p.onClear}>
                <Icon name="x" size={18} /> Start over
              </button>
            </div>
          </div>
        )}

        {!hasSelection && !p.listing && sel.labels.length > 0 && (
          <p className="callout callout-warn" role="status">
            <Icon name="info" /> No music files were found in “{sel.labels.join(', ')}”. Try another folder, or choose the songs individually.
          </p>
        )}
        {p.error && (
          <p className="callout callout-error" role="alert">
            <Icon name="alert" /> {p.error}
          </p>
        )}
      </section>

      <section className="panel dl-home" aria-labelledby="dl-title">
        <h2 id="dl-title" className="panel-title"><Icon name="download" /> Download a Song</h2>
        <form
          className="dl-form"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            p.onDownloadLink(songLink);
          }}
        >
          <input
            className="search dl-input"
            type="text"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            placeholder="Paste your song link here."
            aria-label="Song link"
            value={songLink}
            onChange={(e) => setSongLink(e.target.value)}
          />
          <button type="submit" className="btn btn-primary" disabled={!songLink.trim()}>Check Link</button>
        </form>
        <p className="muted small">Every file is checked to make sure it is real, safe audio before you can save it.</p>
      </section>

      <section className="panel history" aria-labelledby="history-title">
        <div className="panel-row">
          <h2 id="history-title" className="panel-title"><Icon name="clock" /> Previous Scans</h2>
          {(p.history?.length ?? 0) > 1 && (
            <button type="button" className="btn btn-link" onClick={p.onClearHistory}>Delete all</button>
          )}
        </div>
        {p.history === null ? (
          <p className="muted small">Loading…</p>
        ) : !p.historyAvailable ? (
          <p className="muted small">This browser is not allowing SongSort to save anything (for example in a private window), so scans can’t be kept.</p>
        ) : p.history.length === 0 ? (
          <p className="history-empty muted">
            Your scans will appear here, so you can look at their results again later. Only song names, locations and
            sizes are saved, privately in this browser — never the music.
          </p>
        ) : (
          <ul className="history-list">
            {p.history.map((h) => (
              <li key={h.id}>
                <button type="button" className="history-open" onClick={() => p.onViewScan(h.id)} aria-label={`View report for ${h.source}`}>
                  <div className="history-main">
                    <strong title={h.source}>{h.source}</strong>
                    <span className="muted small">{new Date(h.at).toLocaleString()}</span>
                  </div>
                  <div className="history-nums small">
                    <span>{plural(h.files, 'file')}</span>
                    <span className="tag tag-green">{h.unique.toLocaleString()} unique</span>
                    <span className="tag tag-red">{plural(h.extraCopies, 'exact copy', 'exact copies')}</span>
                    <span className="tag tag-amber">{h.potentialGroups.toLocaleString()} to review</span>
                    {h.savableBytes > 0 && <span className="muted">{formatBytes(h.savableBytes)} savable</span>}
                    {h.organized && <span className="tag tag-blue"><Icon name="check" size={12} /> Organized</span>}
                  </div>
                </button>
                <div className="history-actions">
                  {h.canRescan && caps.pickDirectory && (
                    <button type="button" className="btn btn-ghost btn-small" onClick={() => p.onRescan(h.id)} disabled={p.rescanBusy}>
                      Scan again
                    </button>
                  )}
                  <button type="button" className="btn btn-ghost btn-small" onClick={() => p.onViewScan(h.id)}>
                    View <Icon name="arrow" size={14} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="trust">
        <div><Icon name="shield" /> <span><strong>Private.</strong> Files are read on this device only. Nothing is uploaded.</span></div>
        <div><Icon name="copy" /> <span><strong>Safe.</strong> SongSort copies files. Your originals are never changed or deleted.</span></div>
        <div><Icon name="check" /> <span><strong>Careful.</strong> Only byte-for-byte identical files are called duplicates. Similar songs are left for you to decide.</span></div>
      </section>

      <details className="panel help">
        <summary>
          <Icon name="info" /> Where can I scan music from?
        </summary>
        <div className="help-body">
          <div>
            <h3><Icon name="drive" /> Computers (Windows, Mac)</h3>
            <p>
              Choose any folder, including a USB pen drive or an external hard drive — they appear in the folder picker.
              {caps.writeDirectory
                ? ' This browser can also save the organized folders straight to a drive.'
                : ' This browser cannot write folders directly, so your organized music will be saved as a ZIP file. For direct folder saving use Chrome or Edge.'}
            </p>
          </div>
          <div>
            <h3><Icon name="phone" /> Phones (Android, iPhone)</h3>
            <p>
              Use “Individual songs”: your phone opens its own file picker, where you can select many songs at once.
              Phone browsers cannot open whole folders or browse all storage, and USB drives only work if your phone’s
              file picker shows them. Results are saved as a ZIP file.
            </p>
          </div>
          <div>
            <h3><Icon name="alert" /> Good to know</h3>
            <p>
              Browsers block some system locations (for example the main system drive or Windows folders). If a folder
              is refused, choose the folder that holds your music instead. Keep this tab open while scanning.
            </p>
          </div>
        </div>
      </details>
    </div>
  );
}
