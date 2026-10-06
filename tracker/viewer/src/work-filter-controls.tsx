import { useEffect, useMemo, useState } from 'react';
import { CalendarDays, Check, ChevronDown, SlidersHorizontal, X } from 'lucide-react';
import type { DateRange } from 'react-day-picker';
import {
  Tags,
  TagsContent,
  TagsEmpty,
  TagsGroup,
  TagsInput,
  TagsItem,
  TagsList,
  TagsTrigger,
  TagsValue,
} from './components/kibo-ui/tags/index.tsx';
import { Pill, PillButton } from './components/kibo-ui/pill';
import { Button } from './components/ui/button.tsx';
import { Calendar } from './components/ui/calendar.tsx';
import { Popover, PopoverContent, PopoverTrigger } from './components/ui/popover.tsx';
import { SearchField } from './search-field.tsx';
import { PersonLink } from './person-link';
import { ProjectSelector, VisibilityControls } from './shared.jsx';
import { workFilterOptions, type WorkFilterChoice } from './work-filters';
import type { TrackerSnapshot } from './snapshot';
import type { SearchInput, WorkSearch } from './routing-state';

interface WorkFilterControlsProps {
  data: TrackerSnapshot;
  search: WorkSearch;
  onChange: (changes: SearchInput) => void;
  matchCount: number;
}

interface MultiTagFilterProps {
  label: string;
  emptyLabel: string;
  choices: WorkFilterChoice[];
  values: string[];
  onChange: (values: string[]) => void;
  className?: string;
}

function updateValues(values: string[], value: string): string[] {
  return values.includes(value)
    ? values.filter(entry => entry !== value)
    : [...values, value].sort((left, right) => left.localeCompare(right));
}

function MultiTagFilter({ label, emptyLabel, choices, values, onChange, className }: MultiTagFilterProps) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const labelByValue = useMemo(() => new Map(choices.map(choice => [choice.value, choice.label])), [choices]);
  const selectedChoices = values.map(value => ({ value, label: labelByValue.get(value) ?? value }));

  return <Tags value={query} setValue={setQuery} open={open} onOpenChange={setOpen} className={`work-filter-tags ${className ?? ''}`.trim()}>
    <TagsTrigger
      aria-label={label}
      aria-expanded={open}
      className={`work-filter-tags-trigger${selectedChoices.length ? ' has-tags' : ''}`}
      type="button"
    >
      {selectedChoices.map(choice => <TagsValue key={choice.value} className="work-filter-tag-value">{choice.label}</TagsValue>)}
      {!selectedChoices.length ? <span className="work-filter-tags-placeholder">{emptyLabel}</span> : null}
    </TagsTrigger>
    <TagsContent align="start" className="work-filter-tags-content">
      <TagsInput value={query} onValueChange={setQuery} aria-label={`Search ${label.toLowerCase()} choices`} placeholder={`Search ${label.toLowerCase()}…`} />
      <TagsList>
        <TagsEmpty>No {label.toLowerCase()} match this search.</TagsEmpty>
        <TagsGroup>
          {choices.map(choice => {
            const checked = values.includes(choice.value);
            return <TagsItem
              key={choice.value}
              value={`${choice.label} ${choice.value}`}
              onSelect={() => {
                onChange(updateValues(values, choice.value));
                setQuery('');
              }}
              aria-label={`${choice.label}, ${checked ? 'selected' : 'not selected'}`}
            >
              <span>{choice.label}</span>
              <Check className={`work-filter-option-check${checked ? '' : ' is-hidden'}`} aria-hidden="true" />
            </TagsItem>;
          })}
        </TagsGroup>
      </TagsList>
    </TagsContent>
  </Tags>;
}

function dateKeyFromDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function dateFromKey(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day, 12);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
    ? date
    : undefined;
}

function dateLabel(value: string | undefined): string | undefined {
  const date = dateFromKey(value);
  if (!date) return undefined;
  return new Intl.DateTimeFormat('en-PH', { dateStyle: 'medium' }).format(date);
}

function manilaTodayKey(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function DateRangeFilter({
  from,
  to,
  onChange,
}: {
  from: string | undefined;
  to: string | undefined;
  onChange: (changes: SearchInput) => void;
}) {
  const [open, setOpen] = useState(false);
  const selected: DateRange | undefined = from || to
    ? { from: dateFromKey(from), to: dateFromKey(to) }
    : undefined;
  const fromLabel = dateLabel(from);
  const toLabel = dateLabel(to);
  const rangeLabel = fromLabel && toLabel
    ? `${fromLabel} – ${toLabel}`
    : fromLabel
      ? `From ${fromLabel}`
      : toLabel
        ? `Through ${toLabel}`
        : 'Any dates';

  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger asChild>
      <Button className="work-date-range-trigger" variant="outline" size="sm" type="button" aria-label="Schedule date range" aria-expanded={open}>
        <CalendarDays size={15} aria-hidden="true" />
        <span>{rangeLabel}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </Button>
    </PopoverTrigger>
    <PopoverContent align="start" className="work-date-range-popover">
      <div className="work-filter-popover-heading">
        <strong>Schedule date range</strong>
        <span>Filter work by its recorded schedule dates.</span>
      </div>
      <Calendar
        mode="range"
        selected={selected}
        defaultMonth={dateFromKey(from ?? to)}
        onSelect={range => onChange({
          from: range?.from ? dateKeyFromDate(range.from) : undefined,
          to: range?.to ? dateKeyFromDate(range.to) : undefined,
        })}
        numberOfMonths={1}
        className="work-filter-date-calendar"
      />
      {from || to ? <Button className="work-date-clear" variant="ghost" size="sm" type="button" onClick={() => onChange({ from: undefined, to: undefined })}>Clear date range</Button> : null}
    </PopoverContent>
  </Popover>;
}

export function NavigationDateControls({
  date,
  onChange,
}: {
  date: string | undefined;
  onChange: (changes: SearchInput) => void;
}) {
  const [open, setOpen] = useState(false);
  const selectedDate = dateFromKey(date);
  const [calendarMonth, setCalendarMonth] = useState(() => selectedDate ?? dateFromKey(manilaTodayKey()) ?? new Date());

  useEffect(() => {
    if (open) setCalendarMonth(selectedDate ?? dateFromKey(manilaTodayKey()) ?? new Date());
  }, [date, open]);

  return <div className="work-date-navigation">
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button className="work-date-jump-trigger" variant="outline" size="sm" type="button" aria-label="Jump to date" aria-expanded={open}>
          <CalendarDays size={15} aria-hidden="true" />
          <span>{selectedDate ? `Jump to ${dateLabel(date)}` : 'Jump to date'}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="work-date-jump-popover">
        <div className="work-filter-popover-heading">
          <strong>Jump to date</strong>
          <span>Calendar navigation does not change the schedule filter.</span>
        </div>
        <Calendar
          mode="single"
          selected={selectedDate}
          month={calendarMonth}
          onMonthChange={setCalendarMonth}
          onSelect={nextDate => {
            onChange({ date: nextDate ? dateKeyFromDate(nextDate) : undefined });
            setOpen(false);
          }}
          className="work-filter-date-calendar"
        />
      </PopoverContent>
    </Popover>
    <Button className="work-date-today" variant="ghost" size="sm" type="button" onClick={() => onChange({ date: manilaTodayKey() })}>Today</Button>
  </div>;
}

function FilterChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return <Pill className="work-filter-chip">
    <span className="work-filter-chip-label">{label}</span>
    <PillButton type="button" aria-label={`Remove ${label}`} onClick={onRemove}>
      <X size={13} aria-hidden="true" />
    </PillButton>
  </Pill>;
}

function OwnerFilterChip({ value, label, data, onRemove }: { value: string; label: string; data: TrackerSnapshot; onRemove: () => void }) {
  const unassigned = value === '__unassigned__';
  return <Pill className="work-filter-chip work-filter-owner-chip">
    {unassigned
      ? <span className="work-filter-chip-label">{label}</span>
      : <PersonLink className="work-filter-chip-person" data={data} value={value} name={label} avatar />}
    <PillButton type="button" aria-label={`Remove Owner: ${label}`} onClick={onRemove}>
      <X size={13} aria-hidden="true" />
    </PillButton>
  </Pill>;
}

export function WorkFilterControls({ data, search, onChange, matchCount }: WorkFilterControlsProps) {
  const [filtersOpen, setFiltersOpen] = useState(false);
  const choices = useMemo(() => workFilterOptions(data), [data]);
  const ownerLabels = new Map(choices.owners.map(choice => [choice.value, choice.label]));
  const statusLabels = new Map(choices.statuses.map(choice => [choice.value, choice.label]));
  const activeFilterCount = Number(Boolean(search.q.trim()))
    + search.owners.length
    + search.statuses.length
    + Number(Boolean(search.from || search.to))
    + Number(search.undated !== 'include')
    + Number(!search.planned)
    + Number(search.drafts)
    + Number(search.completed);
  const hasResetState = activeFilterCount > 0 || Boolean(search.date);
  const fromLabel = dateLabel(search.from);
  const toLabel = dateLabel(search.to);
  const rangeChip = fromLabel && toLabel ? `${fromLabel} – ${toLabel}` : fromLabel ? `From ${fromLabel}` : toLabel ? `Through ${toLabel}` : null;

  const reset = () => {
    onChange({
      q: '',
      owners: [],
      statuses: [],
      from: undefined,
      to: undefined,
      undated: 'include',
      date: undefined,
      completed: false,
      planned: true,
      drafts: false,
    });
    setFiltersOpen(false);
  };

  return <section className="work-filter-controls" aria-label="Work filters">
    <div className="work-filter-toolbar">
      <div className="work-filter-field work-filter-project">
        <span className="work-filter-field-label">Project</span>
        <ProjectSelector data={data} scopeId={search.scope} onChange={scope => onChange({ scope: scope ?? 'all' })} label="Project" compact />
      </div>
      <div className="work-filter-field work-filter-search">
        <span className="work-filter-field-label">Search work</span>
        <SearchField label="Search work" value={search.q} onChange={q => onChange({ q })} placeholder="Search work" />
      </div>
      <div className="work-filter-field work-filter-owner">
        <span className="work-filter-field-label">Owner</span>
        <MultiTagFilter
          label="Filter by owner"
          emptyLabel="All owners"
          choices={choices.owners}
          values={search.owners}
          onChange={owners => onChange({ owners })}
        />
      </div>
      <div className="work-filter-field work-filter-status">
        <span className="work-filter-field-label">Status</span>
        <MultiTagFilter
          label="Filter by status"
          emptyLabel="All statuses"
          choices={choices.statuses}
          values={search.statuses}
          onChange={statuses => onChange({ statuses })}
        />
      </div>
      <div className="work-filter-field work-filter-more">
        <span className="work-filter-field-label">More filters</span>
        <Popover open={filtersOpen} onOpenChange={setFiltersOpen}>
          <PopoverTrigger asChild>
            <Button className="work-filter-open" variant="outline" size="sm" type="button" aria-label="Filters" aria-expanded={filtersOpen}>
              <SlidersHorizontal size={15} aria-hidden="true" />
              <span>More filters</span>
              {activeFilterCount ? <span className="work-filter-count" aria-hidden="true">{activeFilterCount}</span> : null}
              <ChevronDown size={14} aria-hidden="true" />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="work-filter-popover">
            <div className="work-filter-popover-heading">
              <strong>Work filters</strong>
              <span>{matchCount} matching item{matchCount === 1 ? '' : 's'}</span>
            </div>
            <section className="work-filter-popover-section" aria-labelledby="work-filter-visibility-heading">
              <h3 id="work-filter-visibility-heading">Commitment and completion</h3>
              <VisibilityControls
                showPlanned={search.planned}
                setShowPlanned={value => onChange({ planned: value === true })}
                showDrafts={search.drafts}
                setShowDrafts={value => onChange({ drafts: value === true })}
                showPlannedControl
                showCompleted={search.completed}
                setShowCompleted={value => onChange({ completed: value === true })}
                visibleItemCount={matchCount}
              />
            </section>
            <section className="work-filter-popover-section" aria-labelledby="work-filter-dates-heading">
              <h3 id="work-filter-dates-heading">Schedule dates</h3>
              <DateRangeFilter from={search.from} to={search.to} onChange={onChange} />
              <div className="work-undated-control">
                <span className="work-undated-label">Undated work</span>
                <div role="group" aria-label="Undated work" className="work-undated-options">
                  {([
                    ['include', 'Include'],
                    ['exclude', 'Exclude'],
                    ['only', 'Only'],
                  ] as const).map(([value, label]) => <Button
                    key={value}
                    variant={search.undated === value ? 'secondary' : 'ghost'}
                    size="sm"
                    type="button"
                    aria-pressed={search.undated === value}
                    onClick={() => onChange({ undated: value })}
                  >{label}</Button>)}
                </div>
              </div>
            </section>
            <div className="work-filter-popover-footer">
              <span aria-live="polite" className="work-filter-match-count">{matchCount} matching item{matchCount === 1 ? '' : 's'}</span>
              <Button variant="ghost" size="sm" type="button" onClick={reset} disabled={!hasResetState}>Reset filters</Button>
            </div>
          </PopoverContent>
        </Popover>
      </div>
    </div>
    <div className="work-filter-active" aria-label="Active Work filters">
      {search.q.trim() ? <FilterChip label={`Search: ${search.q.trim()}`} onRemove={() => onChange({ q: '' })} /> : null}
      {search.owners.map(value => <OwnerFilterChip
        key={`owner-${value}`}
        value={value}
        label={ownerLabels.get(value) ?? value}
        data={data}
        onRemove={() => onChange({ owners: search.owners.filter(owner => owner !== value) })}
      />)}
      {search.statuses.map(value => <FilterChip key={`status-${value}`} label={`Status: ${statusLabels.get(value) ?? value}`} onRemove={() => onChange({ statuses: search.statuses.filter(status => status !== value) })} />)}
      {rangeChip ? <FilterChip label={`Dates: ${rangeChip}`} onRemove={() => onChange({ from: undefined, to: undefined })} /> : null}
      {search.undated !== 'include' ? <FilterChip label={`Undated: ${search.undated}`} onRemove={() => onChange({ undated: 'include' })} /> : null}
      {!search.planned ? <FilterChip label="Planned hidden" onRemove={() => onChange({ planned: true })} /> : null}
      {search.drafts ? <FilterChip label="Drafts shown" onRemove={() => onChange({ drafts: false })} /> : null}
      {search.completed ? <FilterChip label="Completed shown" onRemove={() => onChange({ completed: false })} /> : null}
      {search.date ? <FilterChip label={`Jump date: ${dateLabel(search.date) ?? search.date}`} onRemove={() => onChange({ date: undefined })} /> : null}
    </div>
  </section>;
}
