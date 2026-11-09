import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { checkAudioFile } from '../downloader/checkFile';
import { compareWithCollection, saveIntoFolder, saveToDevice, type CollectionCheck } from '../downloader/collection';
import { CONVERT_TARGETS, converterSupported, convertAudio, MAX_CONVERT_BYTES, planConversion, targetLabel, type ConversionPlan } from '../downloader/convert';
import { FetchError, fetchLink } from '../downloader/fetchAudio';
import { nameFromTags, nameFromUrl, safeFileName } from '../downloader/filename';
import { classifyLink, looksLikeAudioPath, parseLink } from '../downloader/links';
import { FORMATS, type AudioKind } from '../downloader/sniff';
import { audioLinksFromPage, loadArchive, loadCommons, loadPlatform, pageTitle, SourceError, storeSearchLinks, type Candidate, type PlatformResult, type SourceInfo } from '../downloader/sources';
import { REJECTED, type AudioDetails } from '../downloader/validate';
import { errorMessage, formatBytes, formatDuration, plural } from '../lib/format';
import { caps, ACCEPT_ATTR } from '../lib/platform';
import type { ScanProgress } from '../lib/scan';
import { describePickerError, fromDirectoryHandle, fromFileList, type Selection } from '../lib/select';
import { Icon, ProgressBar } from './ui';

interface Ready {
  file: File;
  details: AudioDetails;
  warnings: string[];
  info: SourceInfo;
  fileUrl: string;
  via: 'browser' | 'helper';
}

interface Converted {
  file: File;
  details: AudioDetails;
  plan: ConversionPlan;
}

type View =
  | { k: 'idle' }
  | { k: 'busy'; step: string; received?: number; total?: number }
  | { k: 'error'; message: string; rejected?: boolean }
  | { k: 'platform'; data: PlatformResult }
  | { k: 'choose'; info: SourceInfo; candidates: Candidate[]; fromPage: boolean }
  | { k: 'ready'; item: Ready };

type Coll =
  | { k: 'closed' }
  | { k: 'busy'; step: string; progress?: number }
  | { k: 'result'; check: CollectionCheck; dir?: FileSystemDirectoryHandle; folderName: string; version: File }
  | { k: 'saved'; savedAs: string; folderName: string; renamed: boolean; check: CollectionCheck }
  | { k: 'error'; message: string };

const siteOf = (u: string) => {
  try {
    return new URL(u).hostname.replace(/^www\./, '');
  } catch {
    return u;
  }
};

function qualityText(d: AudioDetails): string | undefined {
  if (d.lossless) {
    const parts = [d.bitsPerSample ? `${d.bitsPerSample}-bit` : null, d.sampleRate ? `${(d.sampleRate / 1000).toFixed(d.sampleRate % 1000 ? 1 : 0)} kHz` : null].filter(Boolean);
    return `Lossless${parts.length ? ` (${parts.join(', ')})` : ''}`;
  }
  if (d.bitrate) return `${d.bitrate} kbps${d.sampleRate ? ` · ${(d.sampleRate / 1000).toFixed(d.sampleRate % 1000 ? 1 : 0)} kHz` : ''}`;
  return undefined;
}

function formatName(d: AudioDetails): string {
  const codec = d.codec ?? '';
  if (d.kind === 'm4a') return /alac/i.test(codec) ? 'M4A (Apple Lossless)' : 'M4A (AAC)';
  if (d.kind === 'ogg') return /opus/i.test(codec) ? 'OGG (Opus)' : /flac/i.test(codec) ? 'OGG (FLAC)' : 'OGG (Vorbis)';
  return d.formatLabel;
}

export function Downloader({ initialUrl, onBack }: { initialUrl?: string; onBack: () => void }) {
  const [link, setLink] = useState(initialUrl ?? '');
  const [view, setView] = useState<View>({ k: 'idle' });
  const [converted, setConverted] = useState<Converted[]>([]);
  const [convertOpen, setConvertOpen] = useState(false);
  const [converting, setConverting] = useState<{ target: AudioKind; stage: string; progress: number } | null>(null);
  const [convertError, setConvertError] = useState<string | null>(null);
  const [saveNote, setSaveNote] = useState<string | null>(null);
  const [coll, setColl] = useState<Coll>({ k: 'closed' });
  const [shownCandidates, setShownCandidates] = useState(20);
  const abortRef = useRef<AbortController | null>(null);
  const collInput = useRef<HTMLInputElement>(null);

  const previewUrl = useMemo(() => (view.k === 'ready' ? URL.createObjectURL(view.item.file) : null), [view]);
  useEffect(() => () => void (previewUrl && URL.revokeObjectURL(previewUrl)), [previewUrl]);

  useEffect(() => {
    if (collInput.current && caps.directoryInput) collInput.current.setAttribute('webkitdirectory', '');
  }, []);

  useEffect(() => {
    // check() cancels any earlier run itself, so running this twice (React development mode) is safe.
    if (initialUrl) void check(initialUrl);
    return () => abortRef.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const reset = () => {
    abortRef.current?.abort();
    setConverted([]);
    setConvertOpen(false);
    setConverting(null);
    setConvertError(null);
    setSaveNote(null);
    setColl({ k: 'closed' });
    setShownCandidates(20);
  };

  /* ---------------- checking a link ---------------- */

  async function downloadCandidate(c: Candidate, info: SourceInfo, signal: AbortSignal) {
    let url: URL;
    const parsed = parseLink(c.url);
    if (!parsed.ok) throw new FetchError('blocked-url', parsed.message);
    url = parsed.url;
    setView({ k: 'busy', step: 'Downloading the song…' });
    const got = await fetchLink(url, {
      expect: 'audio',
      looksAudio: true,
      signal,
      onProgress: (received, total) => setView({ k: 'busy', step: 'Downloading the song…', received, total }),
    });
    await validateAndShow(got.blob, got.suggestedName ?? c.name, got.contentType, info, got.finalUrl, got.via, signal);
  }

  async function validateAndShow(blob: Blob, nameHint: string | undefined, contentType: string | null, info: SourceInfo, fileUrl: string, via: 'browser' | 'helper', signal: AbortSignal) {
    setView({ k: 'busy', step: 'Checking that the file is real, safe audio…' });
    const v = await checkAudioFile({ blob, name: nameHint, contentType });
    if (signal.aborted) return; // a newer check has started
    if (!v.ok) {
      setView({ k: 'error', rejected: true, message: v.reason });
      return;
    }
    const d = v.details;
    const fallback = nameFromTags(d.title ?? info.title, d.artist ?? info.artist) ?? 'song';
    const name = safeFileName(nameHint ?? nameFromUrl(fileUrl), d.kind, safeFileName(fallback, d.kind).replace(/\.[^.]+$/, ''));
    const file = new File([blob], name, { type: FORMATS[d.kind].mime });
    setView({ k: 'ready', item: { file, details: d, warnings: v.warnings, info, fileUrl, via } });
  }

  async function check(raw: string) {
    reset();
    const ac = new AbortController();
    abortRef.current = ac;
    const parsed = parseLink(raw);
    if (!parsed.ok) {
      setView({ k: 'error', message: parsed.message });
      return;
    }
    const src = classifyLink(parsed.url);
    setView({ k: 'busy', step: 'Checking the link…' });
    try {
      if (src.kind === 'platform') {
        const data = await loadPlatform(src.platform, src.url, ac.signal);
        if (!ac.signal.aborted) setView({ k: 'platform', data });
      } else if (src.kind === 'archive' || src.kind === 'commons') {
        const { info, candidates } = src.kind === 'archive' ? await loadArchive(src.id, src.file, ac.signal) : await loadCommons(src.title, ac.signal);
        if (ac.signal.aborted) return;
        if (candidates.length === 1) await downloadCandidate(candidates[0], info, ac.signal);
        else setView({ k: 'choose', info, candidates, fromPage: false });
      } else {
        const looksAudio = looksLikeAudioPath(src.url);
        const got = await fetchLink(src.url, {
          expect: 'auto',
          looksAudio,
          signal: ac.signal,
          onProgress: (received, total) => setView({ k: 'busy', step: 'Downloading…', received, total }),
        });
        const info: SourceInfo = { site: siteOf(got.finalUrl), pageUrl: src.url.href };
        if (ac.signal.aborted) return;
        if (got.kind === 'page') {
          const candidates = audioLinksFromPage(got.text ?? '', got.finalUrl);
          const title = pageTitle(got.text ?? '');
          if (!candidates.length) {
            setView({ k: 'error', message: 'This page doesn’t offer any downloadable audio files. If the song is protected or only plays on the website, it can’t be downloaded.' });
          } else if (candidates.length === 1) {
            await downloadCandidate(candidates[0], { ...info, title: undefined }, ac.signal);
          } else {
            setView({ k: 'choose', info: { ...info, title }, candidates, fromPage: true });
          }
        } else {
          await validateAndShow(got.blob, got.suggestedName ?? nameFromUrl(got.finalUrl), got.contentType, info, got.finalUrl, got.via, ac.signal);
        }
      }
    } catch (err) {
      if (ac.signal.aborted) {
        if (abortRef.current === ac) setView({ k: 'idle' }); // the user pressed Cancel
        return;
      }
      if (err instanceof FetchError) setView({ k: 'error', message: err.message, rejected: err.code === 'rejected' });
      else if (err instanceof SourceError) setView({ k: 'error', message: err.message });
      else setView({ k: 'error', message: `Something went wrong: ${errorMessage(err)}` });
    }
  }

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void check(link);
  };

  /* ---------------- downloading / converting ---------------- */

  const saveFile = async (file: File) => {
    setSaveNote(null);
    try {
      const how = await saveToDevice(file);
      if (how === 'saved') setSaveNote(`Saved “${file.name}”.`);
      else if (how === 'downloaded') setSaveNote(`“${file.name}” is downloading — look in your Downloads.`);
    } catch (err) {
      setSaveNote(`The file could not be saved: ${errorMessage(err)}`);
    }
  };

  const runConversion = async (item: Ready, target: AudioKind) => {
    const plan = planConversion(item.details, target);
    const ac = new AbortController();
    abortRef.current = ac;
    setConvertError(null);
    setConverting({ target, stage: 'Preparing the converter…', progress: 0 });
    try {
      const out = await convertAudio(
        item.file,
        item.details.kind,
        plan,
        (s) => setConverting({ target, stage: s.stage === 'loading' ? 'Preparing the converter (first time only: about 31 MB)…' : 'Converting…', progress: s.progress }),
        ac.signal,
      );
      setConverting({ target, stage: 'Checking the converted file…', progress: 1 });
      const base = item.file.name.replace(/\.[^.]+$/, '');
      const name = safeFileName(`${base} (converted)`, target);
      const v = await checkAudioFile({ blob: out, name });
      if (!v.ok) throw new Error(`the converted file did not pass the safety check (${v.reason})`);
      const file = new File([out], name, { type: FORMATS[target].mime });
      setConverted((list) => [...list.filter((c) => c.plan.target !== target), { file, details: v.details, plan }]);
    } catch (err) {
      if (!ac.signal.aborted) setConvertError(`Conversion failed: ${errorMessage(err)}`);
    } finally {
      setConverting(null);
    }
  };

  /* ---------------- adding to the music collection ---------------- */

  const compare = async (selection: Selection, version: File, dir?: FileSystemDirectoryHandle) => {
    const ac = new AbortController();
    abortRef.current = ac;
    const folderName = selection.labels.join(', ') || 'your music';
    setColl({ k: 'busy', step: `Comparing with ${plural(selection.files.length, 'song')} in “${folderName}”…` });
    const check = await compareWithCollection(
      selection,
      version,
      (p: ScanProgress) => setColl({ k: 'busy', step: `Comparing with ${plural(selection.files.length, 'song')} in “${folderName}”…`, progress: p.phase === 'compare' && p.bytesTotal ? p.bytesDone / p.bytesTotal : p.total ? p.done / p.total : 0 }),
      ac.signal,
    );
    if (dir && check.identical.length === 0 && check.similar.length === 0) {
      await addNow(dir, version, folderName, check);
    } else {
      setColl({ k: 'result', check, dir, folderName, version });
    }
  };

  const addNow = async (dir: FileSystemDirectoryHandle, version: File, folderName: string, check: CollectionCheck) => {
    setColl({ k: 'busy', step: 'Checking the file once more and saving it…' });
    try {
      const { savedAs, renamed } = await saveIntoFolder(dir, version);
      setColl({ k: 'saved', savedAs, folderName, renamed, check });
    } catch (err) {
      setColl({ k: 'error', message: errorMessage(err) });
    }
  };

  const startAdd = async (version: File) => {
    setColl({ k: 'closed' });
    if (caps.pickDirectory) {
      let dir: FileSystemDirectoryHandle;
      try {
        dir = await window.showDirectoryPicker!({ id: 'songsort-collection', mode: 'readwrite' });
      } catch (err) {
        const msg = describePickerError(err);
        if (msg) setColl({ k: 'error', message: msg });
        return;
      }
      try {
        setColl({ k: 'busy', step: `Looking through “${dir.name}”…` });
        const ac = new AbortController();
        abortRef.current = ac;
        const sel = await fromDirectoryHandle(dir, () => {}, ac.signal);
        await compare(sel, version, dir);
      } catch (err) {
        setColl({ k: 'error', message: `Could not read “${dir.name}”: ${errorMessage(err)}` });
      }
    } else {
      pendingVersion.current = version;
      collInput.current?.click();
    }
  };
  const pendingVersion = useRef<File | null>(null);

  /* ---------------- rendering ---------------- */

  const busy = view.k === 'busy';

  return (
    <div className="downloader">
      <button type="button" className="btn btn-link back" onClick={onBack}>← Back</button>
      <section className="panel dl-panel">
        <h1 className="panel-title"><Icon name="download" /> Download a Song</h1>
        <form className="dl-form" onSubmit={onSubmit} noValidate>
          <input
            className="search dl-input"
            type="text"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            placeholder="Paste your song link here."
            aria-label="Song link"
            value={link}
            onChange={(e) => setLink(e.target.value)}
          />
          <button type="submit" className="btn btn-primary" disabled={busy || !link.trim()}>Check Link</button>
        </form>
        <p className="muted small">
          Works with direct links to audio files, free music libraries such as Internet Archive and Wikimedia Commons, and pages
          that offer downloads. Streaming services (YouTube, Spotify, Apple Music…) don’t allow downloads; SongSort shows you the official options instead.
        </p>
      </section>

      {view.k === 'busy' && (
        <section className="panel" aria-live="polite">
          <p><strong>{view.step}</strong></p>
          {view.received !== undefined && (
            <>
              <ProgressBar value={view.total ? view.received / view.total : 0} label={view.step} />
              <p className="muted small">{formatBytes(view.received)}{view.total ? ` of ${formatBytes(view.total)}` : ''}</p>
            </>
          )}
          <button type="button" className="btn btn-ghost" onClick={() => abortRef.current?.abort()}><Icon name="x" size={18} /> Cancel</button>
        </section>
      )}

      {view.k === 'error' && (
        <section className="callout callout-error dl-error" role="alert">
          <Icon name="alert" />
          <div>
            {view.rejected ? <strong>{REJECTED}</strong> : <strong>This link can’t be downloaded.</strong>}
            <p>{view.message}</p>
            {view.rejected && <p className="muted small">Nothing was saved to your device.</p>}
          </div>
        </section>
      )}

      {view.k === 'platform' && <PlatformCard data={view.data} />}

      {view.k === 'choose' && (
        <section className="panel">
          <h2 className="panel-title">Choose a file</h2>
          <p className="muted small">
            {view.fromPage ? `This page on ${view.info.site} offers ${view.candidates.length} audio files.` : `${view.info.site} offers this in ${view.candidates.length} files.`}{' '}
            {!view.fromPage && 'The original upload keeps the best quality.'} Every file is checked before you can save it.
          </p>
          <InfoRows rows={[['Title', view.info.title], ['Artist', view.info.artist], ['License', view.info.license]]} />
          <ul className="cand-list">
            {view.candidates.slice(0, shownCandidates).map((c) => (
              <li key={c.url} className={c.original ? 'is-original' : ''}>
                <div className="cand-main">
                  <strong className="file-title">{c.name}</strong>
                  <span className="muted small">
                    {[c.formatHint, c.size ? formatBytes(c.size) : null, c.duration ? formatDuration(c.duration) : null].filter(Boolean).join(' · ')}
                  </span>
                  {c.note && <span className={`badge ${c.original ? 'badge-keep' : 'badge-neutral'}`}>{c.note}</span>}
                </div>
                <button
                  type="button"
                  className="btn btn-ghost btn-small"
                  onClick={() => {
                    const ac = new AbortController();
                    abortRef.current = ac;
                    downloadCandidate(c, view.info, ac.signal).catch((err) => {
                      if (ac.signal.aborted) return setView({ k: 'idle' });
                      setView({ k: 'error', message: err instanceof Error ? err.message : String(err), rejected: err instanceof FetchError && err.code === 'rejected' });
                    });
                  }}
                >
                  Get this file
                </button>
              </li>
            ))}
          </ul>
          {view.candidates.length > shownCandidates && (
            <button type="button" className="btn btn-ghost show-more" onClick={() => setShownCandidates((n) => n + 40)}>
              Show more ({view.candidates.length - shownCandidates} left)
            </button>
          )}
        </section>
      )}

      {view.k === 'ready' && (
        <>
          <section className="panel song-card">
            <div className="song-head">
              <span className="done-icon"><Icon name="check" size={22} /></span>
              <div>
                <h2>{view.item.details.title ?? view.item.info.title ?? view.item.file.name}</h2>
                <p className="muted small">Checked: real {formatName(view.item.details)} audio. {view.item.via === 'helper' ? 'Downloaded with SongSort’s helper on this computer.' : ''}</p>
              </div>
            </div>
            <InfoRows
              rows={[
                ['Song', view.item.details.title ?? view.item.info.title],
                ['Artist', view.item.details.artist ?? view.item.info.artist],
                ['Album', view.item.details.album],
                ['Duration', view.item.details.duration ? formatDuration(view.item.details.duration) : undefined],
                ['Source', <a key="s" href={view.item.info.pageUrl} target="_blank" rel="noopener noreferrer nofollow">{view.item.info.site}</a>],
                ['Original format', formatName(view.item.details)],
                ['Quality', qualityText(view.item.details)],
                ['File size', formatBytes(view.item.file.size)],
                ['License', view.item.info.license && (view.item.info.licenseUrl ? <a key="l" href={view.item.info.licenseUrl} target="_blank" rel="noopener noreferrer nofollow">{view.item.info.license}</a> : view.item.info.license)],
                ['File name', view.item.file.name],
              ]}
            />
            {view.item.warnings.map((w) => <p key={w} className="callout callout-info small"><Icon name="info" /> {w}</p>)}
            {previewUrl && <AudioPreview src={previewUrl} />}
            <div className="dl-actions">
              <button type="button" className="btn btn-primary btn-big" onClick={() => saveFile(view.item.file)}>
                <Icon name="download" /> Download Original Format
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => setConvertOpen((o) => !o)} aria-expanded={convertOpen}>
                Convert to Another Format
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => startAdd(view.item.file)}>
                <Icon name="folder" size={18} /> Add to Music Collection
              </button>
            </div>
            {saveNote && <p className="callout callout-ok small" role="status"><Icon name="check" /> {saveNote}</p>}
          </section>

          {convertOpen && (
            <ConvertPanel
              item={view.item}
              converting={converting}
              error={convertError}
              converted={converted}
              onConvert={(t) => runConversion(view.item, t)}
              onCancel={() => abortRef.current?.abort()}
              onSave={saveFile}
              onAdd={startAdd}
            />
          )}

          <CollectionPanel coll={coll} onAdd={addNow} onClose={() => setColl({ k: 'closed' })} onDownload={saveFile} />
        </>
      )}

      <input
        ref={collInput}
        type="file"
        multiple
        hidden
        accept={caps.directoryInput ? undefined : ACCEPT_ATTR}
        onChange={(e) => {
          const files = e.target.files;
          const version = pendingVersion.current;
          e.target.value = '';
          if (!files?.length || !version) return;
          compare(fromFileList(files), version).catch((err) => setColl({ k: 'error', message: errorMessage(err) }));
        }}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */

function InfoRows({ rows }: { rows: [string, ReactNode | undefined][] }) {
  const shown = rows.filter(([, v]) => v !== undefined && v !== null && v !== '');
  if (!shown.length) return null;
  return (
    <dl className="info-rows">
      {shown.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function AudioPreview({ src }: { src: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <p className="muted small">Your browser can’t play a preview of this format, but the file is fine to download.</p>;
  return <audio className="preview" controls preload="metadata" src={src} onError={() => setFailed(true)} />;
}

function PlatformCard({ data }: { data: PlatformResult }) {
  const query = [data.artist, data.title].filter(Boolean).join(' ');
  return (
    <section className="panel platform-card">
      <h2 className="panel-title"><Icon name="info" /> {data.platform.store ? `${data.platform.name} is a music store` : `${data.platform.name} doesn’t allow downloads`}</h2>
      <InfoRows rows={[[data.titleLabel ?? 'Song', data.title], [data.artistLabel ?? 'Artist', data.artist], ['Album', data.album], ['Duration', data.duration ? formatDuration(data.duration) : undefined]]} />
      <p>{data.platform.explanation}</p>
      {!data.platform.store && <p className="muted small">SongSort doesn’t get around copy protection, paywalls or streaming restrictions.</p>}
      {data.previewUrl && (
        <div>
          <p className="muted small">Official 30-second preview from Apple:</p>
          <audio className="preview" controls preload="none" src={data.previewUrl} />
        </div>
      )}
      <div className="dl-actions">
        <a className="btn btn-primary" href={data.url} target="_blank" rel="noopener noreferrer nofollow">{data.platform.openLabel}</a>
        {data.buyUrl && <a className="btn btn-ghost" href={data.buyUrl} target="_blank" rel="noopener noreferrer nofollow">{data.buyLabel}</a>}
      </div>
      {!data.platform.store && !data.buyUrl && query && (
        <div className="store-links">
          <p className="muted small">Where you may be able to buy a download legally:</p>
          <ul>
            {storeSearchLinks(query).map((s) => (
              <li key={s.url}><a href={s.url} target="_blank" rel="noopener noreferrer nofollow">{s.label}</a></li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function ConvertPanel(p: {
  item: Ready;
  converting: { target: AudioKind; stage: string; progress: number } | null;
  error: string | null;
  converted: Converted[];
  onConvert: (t: AudioKind) => void;
  onCancel: () => void;
  onSave: (f: File) => void;
  onAdd: (f: File) => void;
}) {
  const src = p.item.details;
  const tooBig = p.item.file.size > MAX_CONVERT_BYTES;
  const targets = CONVERT_TARGETS.filter((t) => t !== src.kind);
  return (
    <section className="panel convert-panel">
      <h2 className="panel-title">Convert to Another Format</h2>
      <p className="muted small">
        Optional. Your original {formatName(src)} file stays as it is. Converting happens on this device. It never makes a song sound better than the original.
      </p>
      {!converterSupported() || tooBig ? (
        <p className="callout callout-info"><Icon name="info" /> {tooBig ? `Files over ${MAX_CONVERT_BYTES / 1048576} MB can’t be converted in the browser.` : 'This browser can’t run the converter.'}</p>
      ) : (
        <ul className="convert-list">
          {targets.map((t) => {
            const plan = planConversion(src, t);
            const busy = p.converting?.target === t;
            return (
              <li key={t}>
                <div>
                  <strong>{targetLabel(t)}</strong> <span className="muted small">· {plan.quality}</span>
                  <div className="muted small">{plan.note}</div>
                </div>
                <button type="button" className="btn btn-ghost btn-small" disabled={!!p.converting} onClick={() => p.onConvert(t)}>
                  {busy ? 'Working…' : 'Convert'}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {p.converting && (
        <div aria-live="polite" className="convert-progress">
          <p className="small"><strong>{p.converting.stage}</strong></p>
          <ProgressBar value={p.converting.progress} label="Converting" />
          <button type="button" className="btn btn-link" onClick={p.onCancel}>Cancel</button>
        </div>
      )}
      {p.error && <p className="callout callout-error small" role="alert"><Icon name="alert" /> {p.error}</p>}
      {p.converted.length > 0 && (
        <div className="converted">
          <h3>Converted copies</h3>
          {p.converted.map((c) => (
            <div className="file-row" key={c.file.name}>
              <div className="file-main">
                <div className="file-title">{c.file.name}</div>
                <div className="muted small">
                  <span className="badge badge-neutral">Converted</span> from {formatName(src)} · {formatName(c.details)} · {qualityText(c.details) ?? c.plan.quality} · {formatBytes(c.file.size)}
                </div>
              </div>
              <div className="row-actions">
                <button type="button" className="btn btn-ghost btn-small" onClick={() => p.onSave(c.file)}><Icon name="download" size={16} /> Download</button>
                <button type="button" className="btn btn-ghost btn-small" onClick={() => p.onAdd(c.file)}>Add to collection</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function MatchList({ title, items }: { title: string; items: { path: string; title: string }[] }) {
  if (!items.length) return null;
  return (
    <div>
      <p className="small"><strong>{title}</strong></p>
      <ul className="match-list">
        {items.slice(0, 10).map((m) => <li key={m.path} className="file-path">{m.path}</li>)}
        {items.length > 10 && <li className="muted small">…and {items.length - 10} more</li>}
      </ul>
    </div>
  );
}

function CollectionPanel({ coll, onAdd, onClose, onDownload }: {
  coll: Coll;
  onAdd: (dir: FileSystemDirectoryHandle, version: File, folderName: string, check: CollectionCheck) => void;
  onClose: () => void;
  onDownload: (f: File) => void;
}) {
  if (coll.k === 'closed') return null;
  return (
    <section className="panel coll-panel" aria-live="polite">
      <h2 className="panel-title"><Icon name="folder" /> Add to Music Collection</h2>
      {coll.k === 'busy' && (
        <>
          <p><strong>{coll.step}</strong></p>
          {coll.progress !== undefined && <ProgressBar value={coll.progress} label={coll.step} />}
        </>
      )}
      {coll.k === 'error' && <p className="callout callout-error" role="alert"><Icon name="alert" /> {coll.message}</p>}
      {coll.k === 'saved' && (
        <div className="callout callout-ok">
          <Icon name="check" />
          <div>
            <strong>Added “{coll.savedAs}” to “{coll.folderName}”.</strong>
            <p className="small">
              {coll.renamed ? 'Another file in that folder already had this name, so the new song was saved under a new name. Nothing was overwritten. ' : ''}
              {coll.check.identical.length || coll.check.similar.length
                ? ''
                : `No copy of this song was found among the ${plural(coll.check.scanned, 'song')} already there.`}{' '}
              Use “Organize My Music” any time to scan the whole collection for duplicates.
            </p>
          </div>
        </div>
      )}
      {coll.k === 'result' && (
        <>
          {coll.check.identical.length > 0 ? (
            <p className="callout callout-warn"><Icon name="alert" /> <span><strong>You already have this exact song</strong> in “{coll.folderName}” (identical file).</span></p>
          ) : coll.check.similar.length > 0 ? (
            <p className="callout callout-warn"><Icon name="alert" /> <span><strong>You may already have this song</strong> — a file with the same details is in “{coll.folderName}”. It could be another version or quality.</span></p>
          ) : (
            <p className="callout callout-ok"><Icon name="check" /> <span>This song is not in “{coll.folderName}” yet ({plural(coll.check.scanned, 'song')} checked).</span></p>
          )}
          <MatchList title="Identical copies already there:" items={coll.check.identical} />
          <MatchList title="Possibly the same song:" items={coll.check.similar} />
          <div className="dl-actions">
            {coll.dir ? (
              <>
                {coll.check.identical.length > 0 ? (
                  <button type="button" className="btn btn-primary" onClick={onClose}>Don’t add it</button>
                ) : null}
                <button type="button" className={`btn ${coll.check.identical.length ? 'btn-ghost' : 'btn-primary'}`} onClick={() => onAdd(coll.dir!, coll.version, coll.folderName, coll.check)}>
                  {coll.check.identical.length || coll.check.similar.length ? 'Add it anyway' : `Add to “${coll.folderName}”`}
                </button>
                {coll.check.identical.length === 0 && <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>}
              </>
            ) : (
              <>
                <p className="muted small">
                  This browser can’t save into your folders directly. Download the song, then move it into your music folder.
                </p>
                <button type="button" className="btn btn-primary" onClick={() => onDownload(coll.version)}><Icon name="download" size={18} /> Download to Device</button>
              </>
            )}
          </div>
        </>
      )}
      {(coll.k === 'saved' || coll.k === 'error') && <button type="button" className="btn btn-link" onClick={onClose}>Close</button>}
    </section>
  );
}
