import { useMemo, useState, type ReactNode } from 'react';
import { formatBytes, formatDuration, plural } from '../lib/format';
import { exactKeeper, filesOfSong, representativeOfSong, summarizePlan, type PlanItem } from '../lib/organize';
import {
  FOLDER_DUPLICATES,
  FOLDER_POTENTIAL,
  FOLDER_UNIQUE,
  type Decisions,
  type ExactGroup,
  type PotentialDecision,
  type PotentialGroup,
  type ScannedFile,
  type ScanResult,
} from '../lib/types';
import { Icon, PlayButton } from './ui';

type Tab = 'unique' | 'exact' | 'potential' | 'unreadable';
const PAGE = 60;

interface Props {
  result: ScanResult;
  decisions: Decisions;
  plan: PlanItem[];
  onDecisions: (d: Decisions) => void;
  onOrganize: () => void;
  onNewScan: () => void;
}

export function Results({ result, decisions, plan, onDecisions, onOrganize, onNewScan }: Props) {
  const [tab, setTab] = useState<Tab>(() =>
    result.exactGroups.length ? 'exact' : result.potentialGroups.length ? 'potential' : 'unique',
  );

  const summary = useMemo(() => summarizePlan(plan), [plan]);
  const extraCopies = result.exactGroups.reduce((a, g) => a + g.fileIds.length - 1, 0);
  const savable = summary.bytes[FOLDER_DUPLICATES];
  const potentialFiles = result.potentialGroups.reduce(
    (a, g) => a + g.songKeys.reduce((b, k) => b + filesOfSong(result, k).length, 0),
    0,
  );
  const scanned = result.files.length + result.unreadable.length;
  const nothingFound = result.exactGroups.length === 0 && result.potentialGroups.length === 0;

  return (
    <div className="results">
      <section className="done-banner">
        <div className="done-icon"><Icon name="check" size={26} /></div>
        <div>
          <h1>Scan complete</h1>
          <p className="muted">
            {result.sourceLabel} · {plural(scanned, 'file')} scanned
            {nothingFound ? ' · No duplicates found — your collection is already clean.' : ''}
          </p>
        </div>
        <button type="button" className="btn btn-ghost done-new" onClick={onNewScan}>New scan</button>
      </section>

      <section className="stats" aria-label="Scan summary">
        <Stat label="Files scanned" value={scanned.toLocaleString()} />
        <Stat label="Unique songs" value={result.uniqueIds.length.toLocaleString()} tone="green" />
        <Stat
          label="Exact duplicates"
          value={extraCopies.toLocaleString()}
          sub={result.exactGroups.length ? `extra copies in ${plural(result.exactGroups.length, 'group')}` : 'none found'}
          tone="red"
        />
        <Stat
          label="Potential duplicates"
          value={result.potentialGroups.length.toLocaleString()}
          sub={result.potentialGroups.length ? `groups to review (${potentialFiles} files)` : 'none found'}
          tone="amber"
        />
        <Stat label="Space you could save" value={formatBytes(savable)} sub="by setting duplicates aside" tone="blue" />
      </section>

      <div className="tabs" role="tablist" aria-label="Results">
        <TabButton id="unique" tab={tab} setTab={setTab} tone="green" count={result.uniqueIds.length}>Unique Songs</TabButton>
        <TabButton id="exact" tab={tab} setTab={setTab} tone="red" count={result.exactGroups.length}>Exact Duplicates</TabButton>
        <TabButton id="potential" tab={tab} setTab={setTab} tone="amber" count={result.potentialGroups.length}>Potential Duplicates</TabButton>
        {result.unreadable.length > 0 && (
          <TabButton id="unreadable" tab={tab} setTab={setTab} tone="gray" count={result.unreadable.length}>Could not read</TabButton>
        )}
      </div>

      <div className="tab-body" role="tabpanel">
        {tab === 'unique' && <UniqueList result={result} />}
        {tab === 'exact' && <ExactList result={result} decisions={decisions} onDecisions={onDecisions} />}
        {tab === 'potential' && <PotentialList result={result} decisions={decisions} onDecisions={onDecisions} />}
        {tab === 'unreadable' && (
          <div className="list">
            <p className="callout callout-warn"><Icon name="alert" /> These files could not be read, so they were not checked and will not be copied. Your originals are untouched.</p>
            {result.unreadable.map((u) => (
              <div className="file-row" key={u.path}>
                <div className="file-main">
                  <div className="file-title">{u.path.split('/').pop()}</div>
                  <div className="file-path">{u.path}</div>
                  <div className="file-error">{u.error}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="organize-bar">
        <div className="organize-bar-text">
          <strong>{plural(plan.length, 'file')} ready</strong>
          <span className="muted small">
            {summary.counts[FOLDER_UNIQUE]} → Unique Songs · {summary.counts[FOLDER_DUPLICATES]} → Duplicates · {summary.counts[FOLDER_POTENTIAL]} → Potential Duplicates
          </span>
        </div>
        <button type="button" className="btn btn-primary btn-big" onClick={onOrganize} disabled={plan.length === 0}>
          <Icon name="folder" /> Organize My Music
        </button>
      </div>
    </div>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className={`stat ${tone ? `stat-${tone}` : ''}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

function TabButton({ id, tab, setTab, count, tone, children }: { id: Tab; tab: Tab; setTab: (t: Tab) => void; count: number; tone: string; children: ReactNode }) {
  return (
    <button type="button" role="tab" aria-selected={tab === id} className={`tab ${tab === id ? 'is-active' : ''}`} onClick={() => setTab(id)}>
      {children} <span className={`count count-${tone}`}>{count.toLocaleString()}</span>
    </button>
  );
}

/* ------------------------------------------------------------------ */

function FileDetails({ f, extra }: { f: ScannedFile; extra?: ReactNode }) {
  const sub = [f.meta.artist, f.meta.album].filter(Boolean).join(' · ');
  return (
    <>
      <PlayButton file={f.file} />
      <div className="file-main">
        <div className="file-title">
          {f.displayTitle}
          {f.titleFromFileName && <span className="hint" title="This file has no song name stored inside it, so the file name is shown."> (from file name)</span>}
        </div>
        {sub && <div className="file-sub">{sub}</div>}
        <div className="file-path" title={f.path}>{f.path}</div>
        {f.metaWarning && <div className="file-error">{f.metaWarning}</div>}
        {extra}
      </div>
      <div className="file-meta">
        <span className="fmt">{f.ext.toUpperCase()}</span>
        <span>{formatBytes(f.size)}</span>
        {f.meta.duration !== undefined && <span>{formatDuration(f.meta.duration)}</span>}
        {f.meta.bitrate !== undefined && <span>{f.meta.bitrate} kbps</span>}
      </div>
    </>
  );
}

function usePaged<T>(items: T[]) {
  const [shown, setShown] = useState(PAGE);
  const more = items.length > shown ? (
    <button type="button" className="btn btn-ghost show-more" onClick={() => setShown((s) => s + PAGE * 2)}>
      Show more ({(items.length - shown).toLocaleString()} left)
    </button>
  ) : null;
  return { visible: items.slice(0, shown), more };
}

function matches(f: ScannedFile, q: string) {
  if (!q) return true;
  const hay = `${f.displayTitle} ${f.meta.artist ?? ''} ${f.meta.album ?? ''} ${f.path}`.toLowerCase();
  return q.toLowerCase().split(/\s+/).every((w) => hay.includes(w));
}

function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <input className="search" type="search" value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} aria-label={placeholder} />
  );
}

/* ------------------------------------------------------------------ */

function UniqueList({ result }: { result: ScanResult }) {
  const [q, setQ] = useState('');
  const files = useMemo(
    () => result.uniqueIds.map((id) => result.filesById.get(id)!).filter((f) => matches(f, q)),
    [result, q],
  );
  const { visible, more } = usePaged(files);
  return (
    <div className="list">
      <p className="tab-intro">
        Songs with no detected duplicate. They will be copied to <strong>Unique Songs</strong>, together with the copy you keep from each duplicate group.
      </p>
      {result.uniqueIds.length > 8 && <SearchBox value={q} onChange={setQ} placeholder="Search songs, artists or folders" />}
      {files.length === 0 && <p className="empty">{q ? 'No songs match your search.' : 'Every song has at least one possible duplicate.'}</p>}
      {visible.map((f) => (
        <div className="file-row" key={f.id}>
          <FileDetails f={f} />
        </div>
      ))}
      {more}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function ExactList({ result, decisions, onDecisions }: { result: ScanResult; decisions: Decisions; onDecisions: (d: Decisions) => void }) {
  const { visible, more } = usePaged(result.exactGroups);
  if (result.exactGroups.length === 0) {
    return <p className="empty">No identical copies were found.</p>;
  }
  const setKeep = (g: ExactGroup, id: number) =>
    onDecisions({ ...decisions, exactKeep: { ...decisions.exactKeep, [g.id]: id } });
  return (
    <div className="list">
      <p className="tab-intro">
        These files are byte-for-byte identical (same SHA-256 fingerprint). Choose the copy to keep — it goes to <strong>Unique Songs</strong>.
        The other copies go to <strong>Duplicates</strong>. Nothing is deleted.
      </p>
      {Object.keys(decisions.exactKeep).length > 0 && (
        <button type="button" className="btn btn-link" onClick={() => onDecisions({ ...decisions, exactKeep: {} })}>
          Reset to suggested copies
        </button>
      )}
      {visible.map((g) => {
        const keep = exactKeeper(result, decisions, g.id);
        const files = g.fileIds.map((id) => result.filesById.get(id)!);
        const first = result.filesById.get(keep)!;
        return (
          <article className="group group-exact" key={g.id}>
            <header className="group-head">
              <div>
                <h3>{first.displayTitle}</h3>
                <div className="muted small">
                  {files.length} identical copies · {formatBytes(first.size)} each · {formatBytes(first.size * (files.length - 1))} could be saved
                </div>
              </div>
            </header>
            <div className="group-rows" role="radiogroup" aria-label={`Choose which copy of ${first.displayTitle} to keep`}>
              {files.map((f) => {
                const isKeep = f.id === keep;
                return (
                  <label className={`file-row selectable ${isKeep ? 'is-keep' : ''}`} key={f.id}>
                    <input type="radio" name={`keep-${g.id}`} checked={isKeep} onChange={() => setKeep(g, f.id)} />
                    <FileDetails
                      f={f}
                      extra={
                        <span className={`badge ${isKeep ? 'badge-keep' : 'badge-dup'}`}>
                          {isKeep ? (f.id === g.defaultKeep ? 'Keep (suggested original)' : 'Keep') : 'Duplicate copy'}
                        </span>
                      }
                    />
                  </label>
                );
              })}
            </div>
          </article>
        );
      })}
      {more}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function PotentialList({ result, decisions, onDecisions }: { result: ScanResult; decisions: Decisions; onDecisions: (d: Decisions) => void }) {
  const { visible, more } = usePaged(result.potentialGroups);
  if (result.potentialGroups.length === 0) {
    return <p className="empty">No similar songs were found.</p>;
  }
  const setDecision = (g: PotentialGroup, d: PotentialDecision) =>
    onDecisions({ ...decisions, potential: { ...decisions.potential, [g.id]: d } });
  const reviewed = result.potentialGroups.filter((g) => (decisions.potential[g.id]?.kind ?? 'later') !== 'later').length;

  return (
    <div className="list">
      <p className="callout callout-warn" role="note">
        <Icon name="alert" />
        <span>
          <strong>These are not confirmed duplicates.</strong> The files have similar song details but different contents —
          they may be the same song at a different quality, or a different version (live, remix, edit). Listen and decide.
          Anything you don’t decide goes to <strong>Potential Duplicates</strong>.
        </span>
      </p>
      <p className="muted small">{reviewed} of {result.potentialGroups.length} groups reviewed</p>
      {visible.map((g) => {
        const d = decisions.potential[g.id] ?? { kind: 'later' };
        const keep = d.kind === 'same' ? d.keep : g.suggestedKeep;
        const first = representativeOfSong(result, decisions, g.songKeys[0]);
        return (
          <article className={`group group-potential decided-${d.kind}`} key={g.id}>
            <header className="group-head">
              <div>
                <h3>{first.displayTitle}</h3>
                <div className="muted small">{g.songKeys.length} similar files</div>
              </div>
            </header>
            <ul className="reasons">
              {g.reasons.map((r) => <li key={r}>{r}</li>)}
            </ul>
            <div className="group-rows">
              {g.songKeys.map((k) => {
                const f = representativeOfSong(result, decisions, k);
                const copies = filesOfSong(result, k).length - 1;
                const isKeep = d.kind === 'same' && keep === k;
                const extra = (
                  <>
                    {copies > 0 && <span className="hint">+ {plural(copies, 'identical copy', 'identical copies')} (see Exact Duplicates)</span>}
                    {d.kind === 'same' && (
                      <span className={`badge ${isKeep ? 'badge-keep' : 'badge-dup'}`}>{isKeep ? 'Keep' : 'Duplicate'}</span>
                    )}
                    {d.kind === 'same' || k !== g.suggestedKeep ? null : <span className="hint">Best quality</span>}
                  </>
                );
                return d.kind === 'same' ? (
                  <label className={`file-row selectable ${isKeep ? 'is-keep' : ''}`} key={k}>
                    <input type="radio" name={`pkeep-${g.id}`} checked={isKeep} onChange={() => setDecision(g, { kind: 'same', keep: k })} />
                    <FileDetails f={f} extra={extra} />
                  </label>
                ) : (
                  <div className="file-row" key={k}>
                    <FileDetails f={f} extra={extra} />
                  </div>
                );
              })}
            </div>
            <div className="decision">
              <span className="decision-label">Are these the same song?</span>
              <div className="segmented" role="radiogroup" aria-label="Decision">
                <button type="button" role="radio" aria-checked={d.kind === 'later'} className={d.kind === 'later' ? 'is-on' : ''} onClick={() => setDecision(g, { kind: 'later' })}>
                  Decide later
                </button>
                <button type="button" role="radio" aria-checked={d.kind === 'different'} className={d.kind === 'different' ? 'is-on' : ''} onClick={() => setDecision(g, { kind: 'different' })}>
                  No, keep all
                </button>
                <button type="button" role="radio" aria-checked={d.kind === 'same'} className={d.kind === 'same' ? 'is-on' : ''} onClick={() => setDecision(g, { kind: 'same', keep })}>
                  Yes, keep one
                </button>
              </div>
              <p className="decision-note muted small">
                {d.kind === 'later' && <>All {g.songKeys.length} files go to <strong>Potential Duplicates</strong> for you to check later.</>}
                {d.kind === 'different' && <>All {g.songKeys.length} files go to <strong>Unique Songs</strong>.</>}
                {d.kind === 'same' && <>The selected file goes to <strong>Unique Songs</strong>; the others go to <strong>Duplicates</strong>.</>}
              </p>
            </div>
          </article>
        );
      })}
      {more}
    </div>
  );
}
