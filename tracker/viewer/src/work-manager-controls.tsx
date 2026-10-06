import { useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import {
  BadgeCheck,
  Check,
  CircleHelp,
  CircleDot,
  ChevronDown,
  Grid2X2,
  Play,
  UserRound,
  Users,
} from 'lucide-react';
import { Button } from './components/ui/button.tsx';
import { Checkbox } from './components/ui/checkbox.tsx';
import { Popover, PopoverContent, PopoverTrigger } from './components/ui/popover.tsx';
import type { ManagerCoverageRow, ManagerPreset, ManagerProjection, ManagerProjectionEntry } from './work-manager-types';
import type { WorkSearch } from './routing-state';

export interface WorkManagerPerson {
  readonly id: string;
  readonly name: string;
  readonly fullName?: string | null;
  readonly githubHandle?: string | null;
  readonly status?: string;
  readonly avatar?: string | null;
}

const PRESETS: readonly { value: ManagerPreset; label: string; description: string; icon: typeof Grid2X2 }[] = [
  { value: 'none', label: 'All work', description: 'All work in the current scope.', icon: Grid2X2 },
  { value: 'team', label: 'Team coverage', description: 'Full-scope work owned by your team.', icon: Users },
  { value: 'moving', label: 'Moving now', description: 'Work with recent qualifying activity.', icon: Play },
  { value: 'delivery', label: 'Delivery coverage', description: 'Work that contributes to delivery.', icon: CircleDot },
  { value: 'needs-me', label: 'Needs me', description: 'Work with a decision awaiting your review.', icon: UserRound },
];

function countLabel(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? '' : 's'}`;
}

function coverageLabel(row: ManagerCoverageRow): string {
  const counts = row.counts;
  return `${countLabel(counts.tasks, 'task')}; ${countLabel(counts.moving, 'moving')}; ${countLabel(counts.quiet, 'quiet')}; ${countLabel(counts.unknownCurrent, 'current with unknown activity')}; ${countLabel(counts.ready, 'ready')}; ${countLabel(counts.waiting, 'waiting')}; ${countLabel(counts.notAssessed, 'not assessed')}; ${countLabel(counts.unreviewed, 'unreviewed')}`;
}

function toggleValue(values: readonly string[], id: string): string[] {
  return values.includes(id)
    ? values.filter(value => value !== id)
    : [...values, id].sort((left, right) => left.localeCompare(right));
}

function CoverageTable({
  rows,
  personById,
}: {
  readonly rows: readonly ManagerCoverageRow[];
  readonly personById: ReadonlyMap<string, WorkManagerPerson>;
}) {
  return <div className="work-manager-coverage-table-wrap" role="region" aria-label="Full-scope workload coverage" tabIndex={0}>
    <table className="work-manager-coverage-table">
      <caption>Full-scope task coverage by active person and unassigned work</caption>
      <thead><tr>
        <th scope="col">Person</th><th scope="col">Tasks</th><th scope="col">Moving</th><th scope="col">Quiet</th>
        <th scope="col">Unknown current</th><th scope="col">Ready</th><th scope="col">Waiting</th>
        <th scope="col">Not assessed</th><th scope="col">Unreviewed</th>
      </tr></thead>
      <tbody>{rows.map(row => {
        const isUnassigned = row.personId === '__unassigned__';
        const person = personById.get(row.personId);
        const name = isUnassigned ? 'Unassigned' : person?.fullName ?? person?.name ?? row.personName;
        return <tr key={row.personId}>
          <th scope="row">{name}</th>
          <td>{row.counts.tasks}</td><td>{row.counts.moving}</td><td>{row.counts.quiet}</td>
          <td>{row.counts.unknownCurrent}</td><td>{row.counts.ready}</td><td>{row.counts.waiting}</td>
          <td>{row.counts.notAssessed}</td><td>{row.counts.unreviewed}</td>
        </tr>;
      })}</tbody>
    </table>
  </div>;
}

export interface WorkManagerControlsProps {
  readonly projection: ManagerProjection;
  readonly people: readonly WorkManagerPerson[];
  readonly search: WorkSearch;
  readonly mode: string;
  readonly matchCount: number;
  readonly resultCount?: number;
  readonly scopeTaskCount: number;
  readonly modified: boolean;
  readonly onPresetChange: (preset: ManagerPreset) => void;
  readonly onPeopleChange: (people: string[]) => void;
}

export function WorkManagerControls({
  projection,
  people,
  search,
  mode,
  matchCount,
  resultCount = matchCount,
  scopeTaskCount,
  modified,
  onPresetChange,
  onPeopleChange,
}: WorkManagerControlsProps) {
  const [open, setOpen] = useState(false);
  const [savedViewOpen, setSavedViewOpen] = useState(false);
  const personById = useMemo(() => new Map(people.map(person => [person.id, person])), [people]);
  const selectedCount = search.people.length;
  const managerApplied = mode === 'tree' || mode === 'gantt';
  const activePreset = search.preset !== 'none';
  const showTeamCoverage = search.preset === 'team';
  const selectedPreset = PRESETS.find(preset => preset.value === search.preset) ?? PRESETS[0];
  const SelectedPresetIcon = selectedPreset.icon;

  return <section className="work-manager-controls" aria-label="Manager work presets">
    <div className="work-saved-view-row">
      <div className="work-saved-view" role="group" aria-label="Work manager presets">
        <span className="work-toolbar-label">Saved view</span>
        <Popover open={savedViewOpen} onOpenChange={setSavedViewOpen}>
          <PopoverTrigger asChild>
            <Button
              className="work-saved-view-trigger"
              variant="outline"
              type="button"
              aria-expanded={savedViewOpen}
            >
              <SelectedPresetIcon size={17} aria-hidden="true" />
              <span>{selectedPreset.label}</span>
              <ChevronDown size={15} aria-hidden="true" />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="work-saved-view-popover">
            {PRESETS.map(preset => {
              const PresetIcon = preset.icon;
              const selected = search.preset === preset.value;
              return <button
                key={preset.value}
                className={`work-saved-view-option${selected ? ' is-selected' : ''}`}
                type="button"
                aria-pressed={selected}
                onClick={() => {
                  onPresetChange(preset.value);
                  setSavedViewOpen(false);
                }}
              >
                <PresetIcon size={21} aria-hidden="true" />
                <span className="work-saved-view-option-copy">
                  <strong>{preset.label}</strong>
                  <small>{preset.description}</small>
                </span>
                {selected ? <Check size={17} aria-hidden="true" /> : null}
              </button>;
            })}
          </PopoverContent>
        </Popover>
      </div>
      <span className="work-saved-view-summary" aria-live="polite">{countLabel(resultCount, 'matching result')}</span>
    </div>
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button className="work-manager-coverage-trigger" variant="outline" size="sm" type="button" aria-label={`People and team coverage${selectedCount ? `, ${selectedCount} selected` : ''}`} aria-expanded={open}>
          <Users size={15} aria-hidden="true" />
          <span>People{selectedCount ? ` · ${selectedCount}` : ''}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="work-manager-coverage-popover">
        <div className="work-manager-popover-heading">
          <div>
            <strong>Team coverage</strong>
            <p>Full-scope task counts. They do not assume capacity or shrink with the current preset.</p>
          </div>
          <span>{countLabel(scopeTaskCount, 'task')}</span>
        </div>
        <div className="work-manager-people-list" role="group" aria-label="Filter by manager role">
          <div className="work-manager-people-heading">
            <strong>Match people</strong>
            <span>OR across selected people</span>
          </div>
          {projection.coverage.map(row => {
            const isUnassigned = row.personId === '__unassigned__';
            const person = personById.get(row.personId);
            const name = isUnassigned ? 'Unassigned' : person?.fullName ?? person?.name ?? row.personName;
            return <div className="work-manager-person-row" key={row.personId}>
              <Checkbox
                checked={search.people.includes(row.personId)}
                aria-label={`Match ${name}`}
                onCheckedChange={() => onPeopleChange(toggleValue(search.people, row.personId))}
              />
              <span className="work-manager-person-name">{name}</span>
              <span className="work-manager-person-task-count" aria-label={coverageLabel(row)}>{row.counts.tasks}</span>
            </div>;
          })}
          {selectedCount ? <Button className="work-manager-people-clear" variant="ghost" size="sm" type="button" onClick={() => onPeopleChange([])}>Clear people</Button> : null}
        </div>
        <CoverageTable rows={projection.coverage} personById={personById} />
        <div className="work-manager-controls-footer">
          {activePreset && !managerApplied ? <span className="work-manager-not-applied">Preset will apply in Tree and Gantt.</span> : null}
          {modified ? <span className="work-manager-modified" role="status">Modified · advanced filters also apply</span> : null}
          <span className="work-manager-match-count" aria-live="polite">{countLabel(matchCount, 'matching task')}</span>
        </div>
      </PopoverContent>
    </Popover>
    {modified ? <span className="work-manager-modified-badge" role="status"><BadgeCheck size={13} aria-hidden="true" />Modified</span> : null}
    {activePreset && !managerApplied ? <span className="work-manager-not-applied-inline"><CircleHelp size={13} aria-hidden="true" />Tree and Gantt only</span> : null}
    {showTeamCoverage ? <details className="work-manager-team-coverage" open>
      <summary>Full-scope team coverage · {countLabel(scopeTaskCount, 'open task')}</summary>
      <p>Current and queued work by every active person, including zero-task people. Counts stay at full scope while filters refine the rows below.</p>
      <CoverageTable rows={projection.coverage} personById={personById} />
    </details> : null}
  </section>;
}

function personName(personById: ReadonlyMap<string, WorkManagerPerson>, id: string): string {
  const person = personById.get(id);
  return person?.fullName ?? person?.name ?? id;
}

function roleLabel(role: string): string {
  switch (role) {
    case 'dri': return 'DRI';
    case 'executor': return 'Executor';
    case 'observed': return 'Observed';
    default: return role;
  }
}

function readinessLabel(entry: ManagerProjectionEntry): string {
  switch (entry.readiness) {
    case 'ready': return 'Ready';
    case 'waiting': return 'Waiting';
    default: return 'Not assessed';
  }
}

export function WorkManagerRowMetadata({
  entry,
  people,
  itemTitle,
  enabled,
  compact = false,
}: {
  readonly entry?: ManagerProjectionEntry | null;
  readonly people: readonly WorkManagerPerson[];
  readonly itemTitle: string;
  readonly enabled: boolean;
  readonly compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const personById = useMemo(() => new Map(people.map(person => [person.id, person])), [people]);
  if (!enabled || !entry) return null;

  const roles = entry.personRoles.map(role => ({
    label: roleLabel(role.role),
    name: personName(personById, role.personId),
  }));
  const needsMe = entry.decisions.some(decision => decision.state === 'proposed' && decision.owner === 'don');
  const isTask = entry.type === 'task';
  const summaryParts = [
    ...roles.map(role => `${role.label}: ${role.name}`),
    entry.executor ? `${entry.executorApproved ? 'Approved executor' : 'Proposed executor'}: ${entry.executor}` : null,
  ].filter((value): value is string => value !== null);
  const visibleLabels = [
    entry.current ? 'Current' : entry.upcoming ? 'Upcoming' : null,
    isTask ? readinessLabel(entry) : null,
    entry.unreviewed ? 'Unreviewed' : null,
    needsMe ? 'Needs me' : null,
  ].filter((value): value is string => value !== null);

  if (!summaryParts.length && !visibleLabels.length && entry.decisions.length === 0 && entry.gaps.length === 0) return null;

  return <span className={`work-manager-row-metadata${compact ? ' is-compact' : ''}`} data-manager-item-id={entry.id}>
    {summaryParts.length ? <span className="work-manager-row-roles" title={summaryParts.join(' · ')}>{summaryParts.join(' · ')}</span> : null}
    {visibleLabels.map(label => <span className={`work-manager-row-chip work-manager-row-chip-${label.toLowerCase().replace(/\s+/g, '-')}`} key={label}>{label}</span>)}
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className="work-manager-row-details-trigger"
          type="button"
          aria-label={`Manager details for ${itemTitle}`}
          aria-expanded={open}
          onClick={event => event.stopPropagation()}
          onKeyDown={event => event.stopPropagation()}
        ><CircleHelp size={14} aria-hidden="true" /><span className="sr-only">Manager details</span></button>
      </PopoverTrigger>
      <PopoverContent align="start" className="work-manager-row-details-popover" onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
        <div className="work-manager-row-details-heading">
          <strong>{itemTitle}</strong>
          {!isTask ? <span>Hierarchy context · excluded from workload counts</span> : null}
        </div>
        <section aria-label="Manager status">
          <h4>Current picture</h4>
          <p>{entry.current ? 'Current work' : entry.upcoming ? 'Upcoming work' : 'Not current or upcoming'}</p>
          {isTask ? <p>Delivery readiness · {readinessLabel(entry)}</p> : null}
          <p>Own activity · {entry.movement.state === 'recent' ? 'Recent' : entry.movement.state === 'quiet' ? 'Quiet' : 'Unknown'}{entry.movement.date ? ` · ${entry.movement.date}` : ''}</p>
          {entry.movement.summary ? <p className="work-manager-row-movement-summary">{entry.movement.summary}</p> : null}
        </section>
        <section aria-label="People and accountability">
          <h4>People and accountability</h4>
          {roles.length ? <ul>{roles.map((role, index) => <li key={`${role.label}-${role.name}-${index}`}>{role.label} · {role.name}</li>)}</ul> : <p>No approved human role is recorded.</p>}
          {entry.driUnassigned ? <p>No approved human DRI is recorded; accountability remains unassigned.</p> : null}
          {entry.executor ? <p>{entry.executorApproved ? 'Approved executor' : 'Proposed executor'} · {entry.executor}</p> : null}
        </section>
        {entry.reasons.length ? <section aria-label="Readiness reasons"><h4>Readiness reasons</h4><ul>{entry.reasons.map((reason, index) => <li key={`${reason}-${index}`}>{reason}</li>)}</ul></section> : null}
        {entry.gaps.length ? <section aria-label="Delivery gaps"><h4>Delivery gaps</h4><ul>{entry.gaps.map((gap, index) => <li key={`${gap}-${index}`}>{gap}</li>)}</ul></section> : null}
        {entry.unreviewed ? <p className="work-manager-unreviewed-detail">Unreviewed discovery evidence is attached to this task.</p> : null}
        {entry.decisions.length ? <section aria-label="Decision questions"><h4>Decision questions</h4><ul>{entry.decisions.map(decision => <li key={decision.id}>
          <strong>{decision.title}</strong>{decision.owner === 'don' && decision.state === 'proposed' ? <span> · Needs me</span> : null}
          <p>{decision.question}</p>
          {decision.recommendation ? <p>Recommendation · {decision.recommendation}</p> : null}
          {decision.source ? <p>Source · {decision.source}</p> : null}
          <Link className="work-manager-decision-link" to="/decisions/$decisionId" params={{ decisionId: decision.id }} onClick={event => event.stopPropagation()}>Open decision</Link>
        </li>)}</ul></section> : null}
      </PopoverContent>
    </Popover>
  </span>;
}
