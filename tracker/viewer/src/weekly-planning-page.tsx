import { useMemo, useState } from 'react';
import { Link, useRouteContext } from '@tanstack/react-router';
import type { PlanningArchiveEntry } from './planning-archive';

function statusLabel(status: PlanningArchiveEntry['status']): string {
  return status === 'draft' ? 'Current draft'
    : status === 'approved' ? 'Approved'
      : status === 'superseded' ? 'Superseded' : 'Blocked';
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function textValue(value: unknown, fallback = 'Not recorded'): string {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

function coverageLabel(value: unknown): string {
  const coverage = recordValue(value);
  if (!coverage) return 'Not recorded';
  const range = [coverage.from, coverage.to].filter(item => typeof item === 'string').join(' to ');
  const state = coverage.complete === true ? 'Complete' : coverage.complete === false ? 'Partial' : 'Coverage state unknown';
  const timezone = typeof coverage.timezone === 'string' ? ` (${coverage.timezone})` : '';
  return `${state}${range ? ` · ${range}` : ''}${timezone}`;
}

function presentationDocument(html: string): string {
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; font-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none';"><style>html{color-scheme:light dark}body{font:14px/1.5 system-ui,sans-serif;margin:2rem;color:#1f2937;background:#fff}table{border-collapse:collapse;max-width:100%}th,td{border:1px solid #d1d5db;padding:.4rem;text-align:left}a{color:#1d4ed8}</style></head><body>${html}</body></html>`;
}

function taskRefs(entry: PlanningArchiveEntry): string[] {
  const refs = Array.isArray(entry.plan.canonicalTaskRefs)
    ? entry.plan.canonicalTaskRefs
    : Array.isArray(entry.plan.outcomes)
      ? entry.plan.outcomes.map(outcome => typeof outcome === 'object' && outcome !== null && 'taskId' in outcome ? outcome.taskId : null)
      : [];
  if (!Array.isArray(refs)) return [];
  return refs.filter((value): value is string => typeof value === 'string' && value.length > 0).slice(0, 200);
}

function planParts(entry: PlanningArchiveEntry, key: 'queues' | 'proposals' | 'gaps'): unknown[] {
  const value = entry.plan[key];
  return Array.isArray(value) ? value.slice(0, 100) : [];
}

function outcomeLabel(value: unknown): string {
  const outcome = recordValue(value);
  if (!outcome) return 'Recorded outcome details are unavailable.';
  const owner = recordValue(outcome.owner);
  const details = [
    textValue(outcome.title, textValue(outcome.taskId, 'Untitled outcome')),
    `status ${textValue(outcome.status, 'unknown')}`,
    `owner ${textValue(owner?.personId, 'unassigned')}`,
    `next step: ${textValue(outcome.nextStep)}`,
    `completion: ${textValue(outcome.completionCondition)}`,
  ];
  const date = outcome.approvedDate ?? outcome.forecastDate;
  if (typeof date === 'string' && date) details.push(`date ${date}`);
  return details.join(' · ');
}

function planningPartLabel(key: 'queues' | 'proposals' | 'gaps', value: unknown): string {
  const part = recordValue(value);
  if (!part) return 'Recorded planning detail is unavailable.';
  if (key === 'gaps') return `${textValue(part.code, 'Coverage gap')}: ${textValue(part.message, 'Details are not recorded.')}`;
  if (key === 'queues') {
    const queued = Array.isArray(part.queuedSlices) ? part.queuedSlices.map(slice => recordValue(slice)?.taskId).filter(item => typeof item === 'string') : [];
    const primary = textValue(part.primaryTaskId, 'No primary task');
    const capacity = recordValue(part.capacity);
    const availability = capacity?.availableDays === null || capacity?.availableDays === undefined ? '' : `, ${capacity.availableDays} days available`;
    return `${textValue(part.personId, 'Unassigned')}: primary ${primary}; queued ${queued.length ? queued.join(', ') : 'none'}; capacity ${textValue(capacity?.state, 'unknown')}${availability}.`;
  }
  const taskIds = Array.isArray(part.taskIds) ? part.taskIds.filter(item => typeof item === 'string').join(', ') : '';
  return `${textValue(part.kind, 'Pending decision')}: ${textValue(part.summary, 'Review is required.')}${taskIds ? ` Tasks: ${taskIds}.` : ''}`;
}

function EntryRow({ entry, selected, marker, onSelect }: { entry: PlanningArchiveEntry; selected: boolean; marker: string | null; onSelect: () => void }) {
  return <button type="button" className={`weekly-planning-entry${selected ? ' weekly-planning-entry-selected' : ''}`} onClick={onSelect} aria-pressed={selected}>
    <span className="weekly-planning-entry-heading"><strong>{entry.week}</strong><span>{entry.revision}</span></span>
    <span className="weekly-planning-entry-meta"><span className={`weekly-planning-status weekly-planning-status-${entry.status}`}>{statusLabel(entry.status)}</span>{marker === null ? null : <span className="weekly-planning-marker">{marker}</span>}</span>
    <span className="weekly-planning-entry-coverage">Coverage: {coverageLabel(entry.coverage)}</span>
  </button>;
}

function EntryDetail({ entry }: { entry: PlanningArchiveEntry }) {
  const refs = taskRefs(entry);
  return <div className="weekly-planning-detail">
    <div className="weekly-planning-detail-heading">
      <div><p className="eyebrow">Saved weekly presentation</p><h2>{entry.week} · {entry.revision}</h2><p className="weekly-planning-detail-subtitle">{statusLabel(entry.status)} · immutable archive revision</p></div>
      <span className={`weekly-planning-status weekly-planning-status-${entry.status}`}>{statusLabel(entry.status)}</span>
    </div>
    <dl className="weekly-planning-facts">
      <div><dt>Episode</dt><dd>{entry.id}</dd></div>
      <div><dt>Presented</dt><dd>{entry.date ?? textValue(entry.manifest.generatedAt)}</dd></div>
      <div><dt>Coverage</dt><dd>{coverageLabel(entry.coverage)}</dd></div>
      <div><dt>Approval references</dt><dd>{Array.isArray(entry.plan.approvalRefs) && entry.plan.approvalRefs.length ? entry.plan.approvalRefs.filter(item => typeof item === 'string').join(', ') : 'None recorded'}</dd></div>
    </dl>
    <div className="weekly-planning-preview-heading"><div><h3>Presentation</h3><p>Rendered from the saved HTML for this revision. The archive is read-only.</p></div><span className="weekly-planning-readonly">Read only</span></div>
    <iframe className="weekly-planning-frame" title={`Weekly planning presentation for ${entry.week} ${entry.revision}`} sandbox="" referrerPolicy="no-referrer" srcDoc={presentationDocument(entry.presentationHtml)} />
    <div className="weekly-planning-assignments"><div><h3>Planned outcomes</h3><p>These outcomes are descriptive content captured in the saved revision.</p></div>{Array.isArray(entry.plan.outcomes) && entry.plan.outcomes.length ? <ul>{entry.plan.outcomes.slice(0, 100).map((outcome, index) => <li key={`outcome-${index}`}>{outcomeLabel(outcome)}</li>)}</ul> : <p className="weekly-planning-muted">None recorded.</p>}</div>
    <div className="weekly-planning-assignments"><div><h3>As planned assignment</h3><p>These are references captured when the presentation was saved. Current tracker details remain separate.</p></div>{refs.length === 0 ? <p className="weekly-planning-muted">No canonical task references were recorded.</p> : <ul>{refs.map(id => <li key={id}><Link to="/work/$itemId" params={{ itemId: id }}>{id}</Link></li>)}</ul>}</div>
    <div className="weekly-planning-assignments"><div><h3>Pending decisions and queues</h3><p>These fields are descriptive planning context captured in this revision. They do not approve or change tracker work.</p></div>{(['proposals', 'queues', 'gaps'] as const).map(key => { const parts = planParts(entry, key); return <div key={key}><h4>{key[0].toUpperCase() + key.slice(1)}</h4>{parts.length === 0 ? <p className="weekly-planning-muted">None recorded.</p> : <ul>{parts.map((part, index) => <li key={`${key}-${index}`}>{planningPartLabel(key, part)}</li>)}</ul>}</div>; })}</div>
    <details className="weekly-planning-provenance"><summary>Archive provenance</summary><p>Source commit: {textValue(recordValue(entry.plan.source)?.sourceCommit, 'Not recorded')} · immutable artifact paths are retained in the archive manifest.</p></details>
  </div>;
}

export function WeeklyPlanningPage() {
  const { planningArchive } = useRouteContext({ from: '__root__' });
  const defaultEntry = planningArchive.entries.find(entry => entry.id === planningArchive.currentDraftId)
    ?? planningArchive.entries.find(entry => entry.id === planningArchive.latestApprovedId)
    ?? planningArchive.entries[0]
    ?? null;
  const [selectedId, setSelectedId] = useState(defaultEntry?.id ?? null);
  const selected = useMemo(() => planningArchive.entries.find(entry => entry.id === selectedId) ?? defaultEntry, [defaultEntry, planningArchive.entries, selectedId]);
  const sortedEntries = useMemo(() => [...planningArchive.entries].sort((left, right) => left.week.localeCompare(right.week) || right.revision.localeCompare(left.revision)), [planningArchive.entries]);

  return <main className="route-page weekly-planning-page">
    <div className="route-heading"><div><p className="eyebrow">Planning archive</p><h1>Weekly planning</h1><p>Browse immutable weekly presentations and the coverage captured for each revision.</p></div><span className="weekly-planning-readonly">Archive only</span></div>
    {planningArchive.entries.length === 0 ? <section className="surface-card weekly-planning-empty"><h2>No weekly plans saved yet.</h2><p>Saved planning episodes will appear here when the selected data root contains a validated archive.</p></section> : <div className="weekly-planning-layout">
      <section className="surface-card weekly-planning-gallery" aria-label="Weekly planning episodes"><div className="weekly-planning-gallery-heading"><div><h2>Episodes</h2><p>{planningArchive.entries.length} saved revision{planningArchive.entries.length === 1 ? '' : 's'}</p></div></div><div className="weekly-planning-entry-list">{sortedEntries.map(entry => <EntryRow key={entry.id} entry={entry} selected={selected?.id === entry.id} marker={entry.id === planningArchive.currentDraftId ? 'Current draft' : entry.id === planningArchive.latestApprovedId ? 'Latest approved' : null} onSelect={() => setSelectedId(entry.id)} />)}</div></section>
      {selected === undefined || selected === null ? <section className="surface-card weekly-planning-empty"><h2>Choose an episode</h2><p>Select a saved revision to open its presentation.</p></section> : <section className="surface-card"><EntryDetail entry={selected} /></section>}
    </div>}
  </main>;
}
