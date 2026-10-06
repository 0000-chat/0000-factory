import { useMemo, useState } from 'react';
import { Link, useNavigate, useRouteContext, useRouterState } from '@tanstack/react-router';
import { Check, ChevronDown, ListFilter, RotateCcw } from 'lucide-react';
import { Bar, BarChart, CartesianGrid, Cell, XAxis, YAxis } from 'recharts';
import { Button } from './components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './components/ui/card';
import { Pill } from './components/kibo-ui/pill';
import { Checkbox } from './components/ui/checkbox';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from './components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from './components/ui/popover';
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from './components/ui/table';
import { ChartContainer, ChartTooltip, ChartTooltipContent } from './components/ui/chart';
import { ProjectSelector } from './shared.jsx';
import { PersonLink } from './person-link';
import { TrackerEmpty } from './tracker-empty';
import { buildReportsProjection, reportFilterOptions, type ReportCount, type ReportsProjection } from './reports-model';
import { compactReportsSearch, parseReportsSearch, type ReportsFilters } from './reports-state';
import { formatUrl } from './navigation';
import type { SearchInput } from './routing-state';
import type { TrackerSnapshot } from './snapshot';

interface CountDatum {
  readonly key: string;
  readonly label: string;
  readonly count: number;
  readonly color: string;
}

function humanize(value: string): string {
  return value
    .replaceAll('-', ' ')
    .replaceAll('_', ' ')
    .split(/\s+/u)
    .filter(Boolean)
    .map(part => `${part.slice(0, 1).toLocaleUpperCase()}${part.slice(1)}`)
    .join(' ');
}

function ownerLabel(key: string, value: string): string {
  return key === '__unassigned__' || key.toLowerCase() === 'unassigned' ? 'Unassigned' : value;
}

function statusColorKey(value: string): string {
  const normalized = value.toLowerCase();
  if (normalized === 'active' || normalized === 'in-progress' || normalized === 'in progress') return 'active';
  if (normalized === 'queued' || normalized === 'unknown') return 'queued';
  if (normalized === 'blocked') return 'blocked';
  if (normalized === 'done' || normalized === 'completed' || normalized === 'archived') return 'done';
  return 'other';
}

function statusRows(rows: ReportCount[]): CountDatum[] {
  return rows.map(row => ({
    key: row.key,
    label: humanize(row.key),
    count: row.count,
    color: `var(--report-status-${statusColorKey(row.key)})`,
  }));
}

function healthRows(counts: ReportsProjection['healthCounts']): CountDatum[] {
  const entries = [
    ['on-track', 'On track', counts['on-track'], 'on-track'],
    ['at-risk', 'At risk', counts['at-risk'], 'at-risk'],
    ['blocked', 'Blocked', counts.blocked, 'blocked'],
    ['unknown', 'Unknown', counts.unknown, 'unknown'],
  ] as const;
  return entries.map(([key, label, count, color]) => ({ key, label, count, color: `var(--report-health-${color})` }));
}

function scheduleRows(counts: ReportsProjection['scheduleCounts']): CountDatum[] {
  const entries = [
    ['approved-baseline-only', 'Approved baseline only', counts['approved-baseline-only'], 'baseline'],
    ['forecast-only', 'Forecast only', counts['forecast-only'], 'forecast'],
    ['both', 'Both', counts.both, 'both'],
    ['none', 'No recorded interval', counts.none, 'none'],
  ] as const;
  return entries.map(([key, label, count, color]) => ({ key, label, count, color: `var(--report-schedule-${color})` }));
}

function sumCounts(rows: readonly CountDatum[]): number {
  return rows.reduce((total, row) => total + row.count, 0);
}

function ReportChart({ title, rows, total, chartLabel }: { title: string; rows: CountDatum[]; total: number; chartLabel: string }) {
  const chartConfig = useMemo(() => ({
    count: { label: 'Records', color: 'var(--primary)' },
  }), []);
  return <Card className="reports-card">
    <CardHeader>
      <CardTitle>{title}</CardTitle>
      <CardDescription>Counts use the records in the current Reports cohort.</CardDescription>
    </CardHeader>
    <CardContent>
      {total > 0 ? <ChartContainer className="reports-chart" config={chartConfig} role="img" aria-label={chartLabel}>
        <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 8, bottom: 4, left: 2 }} accessibilityLayer>
          <CartesianGrid horizontal={false} stroke="var(--border)" />
          <XAxis type="number" allowDecimals={false} tickLine={false} axisLine={false} />
          <YAxis type="category" dataKey="label" width={142} tickLine={false} axisLine={false} />
          <ChartTooltip cursor={false} content={<ChartTooltipContent />} />
          <Bar dataKey="count" radius={4} maxBarSize={20} isAnimationActive={false}>
            {rows.map(row => <Cell key={row.key} fill={row.color} />)}
          </Bar>
        </BarChart>
      </ChartContainer> : <div className="reports-chart-empty" aria-hidden="true">No records in this cohort.</div>}
      <div className="reports-table-wrap reports-chart-table-wrap">
        <Table>
          <TableCaption className="sr-only">{title} exact record counts</TableCaption>
          <TableHeader><TableRow><TableHead scope="col">{title.replace('Delivery ', '')}</TableHead><TableHead scope="col" className="reports-number">Records</TableHead></TableRow></TableHeader>
          <TableBody>
            {rows.map(row => <TableRow key={row.key}>
              <TableCell><span className="reports-chart-key-name"><span className="reports-chart-swatch" style={{ '--swatch': row.color } as React.CSSProperties} aria-hidden="true" />{row.label}</span></TableCell>
              <TableCell className="reports-number">{row.count}</TableCell>
            </TableRow>)}
            <TableRow className="reports-chart-total-row"><TableCell><strong>Total</strong></TableCell><TableCell className="reports-number"><strong>{total}</strong></TableCell></TableRow>
          </TableBody>
        </Table>
      </div>
    </CardContent>
  </Card>;
}

function OwnerFilter({
  choices,
  selected,
  onChange,
}: {
  choices: readonly { value: string; label: string }[];
  selected: readonly string[];
  onChange: (owners: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const summary = selected.length === 0
    ? 'All owners'
    : selected.length === 1
      ? (choices.find(choice => choice.value === selected[0])?.label ?? selected[0])
      : `${selected.length} owners selected`;

  const toggle = (value: string) => {
    const next = selectedSet.has(value)
      ? selected.filter(owner => owner !== value)
      : [...selected, value];
    onChange(next.sort((left, right) => left.localeCompare(right)));
  };

  return <div className="reports-owner-filter">
    <span id="reports-owner-label">Owners</span>
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" role="combobox" aria-label="Filter by owner" aria-haspopup="dialog" aria-expanded={open} aria-labelledby="reports-owner-label" className="reports-owner-trigger">
          <span className="reports-owner-summary">{summary}</span><ChevronDown size={15} aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={4} className="reports-owner-popover">
        <Command className="reports-owner-command" loop>
          <CommandInput aria-label="Search owner choices" placeholder="Search owners…" />
          <CommandList>
            <CommandEmpty>No owners match your search.</CommandEmpty>
            <CommandGroup>
              {choices.map(choice => {
                const checked = selectedSet.has(choice.value);
                return <CommandItem
                  key={choice.value}
                  value={`${choice.label} ${choice.value}`}
                  aria-label={`${choice.label}, ${checked ? 'selected' : 'not selected'}`}
                  onSelect={() => toggle(choice.value)}
                  className="reports-owner-option"
                >
                  <span className="reports-owner-option-check" aria-hidden="true">{checked ? <Check size={15} /> : null}</span>
                  <span>{choice.label}</span>
                </CommandItem>;
              })}
            </CommandGroup>
          </CommandList>
        </Command>
        {selected.length > 0 ? <Button type="button" variant="ghost" size="sm" onClick={() => onChange([])}>Clear owner selection</Button> : null}
      </PopoverContent>
    </Popover>
  </div>;
}

function ReportsAssignments({ projection, data }: { projection: ReportsProjection; data: TrackerSnapshot }) {
  return <Card className="reports-assignments-card">
    <CardHeader>
      <CardTitle>Assignments</CardTitle>
      <CardDescription>Counts describe accepted terminal records in this scope. They do not establish availability, capacity, or productivity.</CardDescription>
    </CardHeader>
    <CardContent className="p-0">
      <div className="reports-table-wrap">
        <Table>
          <TableCaption className="sr-only">Accepted terminal records by assigned owner</TableCaption>
          <TableHeader><TableRow>
            <TableHead scope="col">Owner</TableHead>
            <TableHead scope="col" className="reports-number">Accepted records</TableHead>
            <TableHead scope="col" className="reports-number">Blocked</TableHead>
            <TableHead scope="col" className="reports-number">Unscheduled</TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {projection.assignments.map(assignment => <TableRow key={assignment.ownerKey}>
              <TableCell><span className="reports-owner-cell">
                {assignment.profileSlug && assignment.profileName
                  ? <PersonLink className="reports-owner-link" data={data} value={assignment.ownerKey} name={assignment.profileName} avatar />
                  : assignment.ownerKey === '__unassigned__'
                    ? <span className="reports-unassigned-handle">Unassigned</span>
                    : <span className="reports-unmatched-handle" aria-label={`Unmatched owner ${assignment.ownerKey}`}>{assignment.ownerKey}</span>}
              </span></TableCell>
              <TableCell className="reports-number">{assignment.recordCount}</TableCell>
              <TableCell className="reports-number">{assignment.blockedCount}</TableCell>
              <TableCell className="reports-number">{assignment.unscheduledCount}</TableCell>
            </TableRow>)}
            <TableRow className="reports-chart-total-row"><TableCell><strong>Total</strong></TableCell><TableCell className="reports-number"><strong>{projection.recordCount}</strong></TableCell><TableCell className="reports-number"><strong>{projection.blockedCount}</strong></TableCell><TableCell className="reports-number"><strong>{projection.scheduleCounts.none}</strong></TableCell></TableRow>
          </TableBody>
        </Table>
      </div>
    </CardContent>
  </Card>;
}

function SupportRecords({ projection, returnTo, data }: { projection: ReportsProjection; returnTo: string; data: TrackerSnapshot }) {
  return <Card className="reports-work-card">
    <CardHeader>
      <CardTitle>Supporting work records</CardTitle>
      <CardDescription>{projection.recordCount} accepted terminal record{projection.recordCount === 1 ? '' : 's'} support these counts. Each link opens the canonical work detail.</CardDescription>
    </CardHeader>
    <CardContent>
      <p className="reports-progress-note">Progress evidence: <strong>{projection.progressCounts.scoped}</strong> record{projection.progressCounts.scoped === 1 ? '' : 's'} have evidence-backed scoped progress; <strong>{projection.progressCounts.unknown}</strong> are Unscoped or unknown. No progress percentage is inferred for those records, and the report does not average item percentages.</p>
      <div className="reports-work-list">
        {projection.records.map(record => <article className="reports-work-row" key={record.id}>
          <div className="reports-work-primary">
            <Link className="reports-work-link reports-work-title" to="/work/$itemId" params={{ itemId: record.id }} state={{ returnTo }}>{record.title}</Link>
            <span className="reports-work-id">{record.id}</span>
          </div>
          <div className="reports-work-meta"><span>Status</span><strong>{humanize(record.status)}</strong></div>
          <div className="reports-work-meta"><span>Owner</span><strong>{record.profileSlug && record.profileName
            ? <PersonLink className="reports-owner-link" data={data} value={record.ownerKey} name={record.profileName} avatar />
            : ownerLabel(record.ownerKey, record.ownerKey)}</strong></div>
          <div className="reports-work-meta"><span>Schedule · progress</span><strong>{humanize(record.scheduleCoverage)} · {record.progressScoped && record.progressPercent !== null ? `${record.progressPercent}% verified` : 'Unscoped'}</strong></div>
        </article>)}
      </div>
    </CardContent>
  </Card>;
}

function ReportsEmpty({ reset, canReset }: { reset: () => void; canReset: boolean }) {
  return <section className="reports-empty surface-card">
    <TrackerEmpty
      icon={<ListFilter size={21} aria-hidden="true" />}
      title={<h2>No accepted terminal work matches these filters</h2>}
      description={canReset ? 'Try another owner, include completed work, or choose a broader project scope.' : 'Choose a broader project scope to see accepted terminal work.'}
      action={canReset ? <Button type="button" variant="outline" onClick={reset}><RotateCcw size={15} aria-hidden="true" />Reset filters</Button> : null}
    />
  </section>;
}

export function ReportsPage() {
  const data = useRouteContext({ from: '__root__' }).data as TrackerSnapshot;
  const location = useRouterState({ select: state => state.location });
  const navigate = useNavigate();
  const options = useMemo(() => reportFilterOptions(data), [data]);
  const search = parseReportsSearch(location.search as SearchInput, options);
  const projection = useMemo(() => buildReportsProjection(data, search), [data, search]);
  const returnTo = formatUrl('/reports', compactReportsSearch(search, options));

  const update = (changes: Partial<ReportsFilters>) => {
    const next = parseReportsSearch({ ...search, ...changes }, options);
    void navigate({ to: '/reports', search: next, replace: true });
  };

  const reset = () => update({ completed: false, owners: [] });
  const filterActive = search.completed || search.owners.length > 0;
  const projectName = search.scope === 'all'
    ? 'All projects'
    : data.itemById.get(search.scope)?.title ?? search.scope;
  const statuses = useMemo(() => statusRows(projection.statusCounts), [projection.statusCounts]);
  const health = useMemo(() => healthRows(projection.healthCounts), [projection.healthCounts]);
  const schedule = useMemo(() => scheduleRows(projection.scheduleCounts), [projection.scheduleCounts]);

  return <section className="reports-page" aria-labelledby="reports-heading">
    <header className="reports-header">
      <div><h1 id="reports-heading">Reports</h1><p>Delivery health and schedule coverage from the current tracker snapshot, with links back to the work records behind every count.</p></div>
    </header>

    <div className="reports-filter-bar" aria-label="Reports filters">
      <ProjectSelector data={data} scopeId={search.scope} onChange={scope => update({ scope: scope ?? 'all' })} />
      <label className="check-control"><Checkbox checked={search.completed} onCheckedChange={value => update({ completed: value === true })} />Show completed</label>
      <OwnerFilter choices={options.ownerChoices} selected={search.owners} onChange={owners => update({ owners })} />
      {filterActive ? <Button className="reports-reset" type="button" variant="ghost" onClick={reset}><RotateCcw size={14} aria-hidden="true" />Reset filters</Button> : null}
      <p className="reports-scope-note">{projectName} · Filters are independent from Today, Plans, Team, and Work.</p>
    </div>

    <div className="reports-cohort-note" role="status">
      <Pill className="reports-cohort-pill"><span>{projection.recordCount} accepted terminal record{projection.recordCount === 1 ? '' : 's'}</span></Pill>
      <Pill className="reports-cohort-pill reports-cohort-pill-muted"><span>{projection.excludedAcceptedParentCount} accepted parent record{projection.excludedAcceptedParentCount === 1 ? '' : 's'} excluded</span></Pill>
      <span className="reports-cohort-explanation">to avoid counting their accepted descendants twice.</span>
    </div>

    {projection.recordCount === 0 ? <ReportsEmpty reset={reset} canReset={filterActive} /> : <>
      <div className="reports-summary-grid" aria-label="Release health summary">
        <div className="reports-summary-card"><span>Accepted terminal records</span><strong>{projection.recordCount}</strong><small>Work items with no accepted descendants</small></div>
        <div className="reports-summary-card"><span>Blocked records</span><strong>{projection.blockedCount}</strong><small>Distinct records blocked by status or recorded blockers</small></div>
        <div className="reports-summary-card"><span>Unassigned records</span><strong>{projection.unassignedCount}</strong><small>No owner is recorded on the accepted item</small></div>
        <div className="reports-summary-card"><span>Approved baseline coverage</span><strong>{projection.scheduleCounts['approved-baseline-only'] + projection.scheduleCounts.both}</strong><small>Includes items with both baseline and forecast intervals</small></div>
      </div>

      <div className="reports-chart-grid">
        <ReportChart title="Status" chartLabel="Accepted terminal records by status" rows={statuses} total={sumCounts(statuses)} />
        <ReportChart title="Delivery health" chartLabel="Accepted terminal records by delivery health" rows={health} total={sumCounts(health)} />
        <ReportChart title="Schedule coverage" chartLabel="Accepted terminal records by approved baseline and forecast coverage" rows={schedule} total={sumCounts(schedule)} />
      </div>

      <ReportsAssignments projection={projection} data={data} />
      <SupportRecords projection={projection} returnTo={returnTo} data={data} />
    </>}
    <span className="sr-only" aria-live="polite">Showing {projection.recordCount} records for {projectName}.</span>
  </section>;
}
