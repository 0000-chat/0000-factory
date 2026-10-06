import type { WorkActivityFilter } from './work-activity-types';

export const WORK_MODES = ['tree', 'table', 'calendar', 'kanban', 'gantt'] as const;

export type WorkMode = (typeof WORK_MODES)[number];
export type BrowseFamily = 'today' | 'work' | 'plans' | 'team';
export type SearchInput = Readonly<Record<string, unknown>>;
export type ProjectScope = string;
export type OrganizationFilter = 'all' | '__unrecorded__' | string;
export type ActivityFilter = WorkActivityFilter;
export type UndatedFilter = 'include' | 'exclude' | 'only';
export const WORK_MANAGER_PRESETS = ['none', 'team', 'moving', 'delivery', 'needs-me'] as const;
export type WorkManagerPreset = (typeof WORK_MANAGER_PRESETS)[number];

export const UNASSIGNED_OWNER = '__unassigned__';

export interface ProjectFilterOptions {
  readonly projectIds?: ReadonlySet<string>;
}

export interface TeamFilterOptions {
  readonly organizationLabels?: ReadonlySet<string>;
}

export interface WorkFilterOptions {
  readonly ownerValues?: ReadonlySet<string>;
  readonly statusValues?: ReadonlySet<string>;
  readonly managerPersonValues?: ReadonlySet<string>;
}

export interface WorkFilters {
  readonly scope: ProjectScope;
  readonly mode: WorkMode;
  readonly preset: WorkManagerPreset;
  readonly people: string[];
  readonly activity: ActivityFilter;
  readonly completed: boolean;
  readonly planned: boolean;
  readonly drafts: boolean;
  readonly q: string;
  readonly owners: string[];
  readonly statuses: string[];
  readonly from?: string;
  readonly to?: string;
  readonly undated: UndatedFilter;
  readonly date?: string;
}

export interface WorkSearch extends WorkFilters {
  readonly item?: string;
}

export interface TodayFilters {
  readonly scope: ProjectScope;
  readonly completed: boolean;
  readonly planned: boolean;
  readonly drafts: boolean;
}

export interface TodaySearch extends TodayFilters {
  readonly item?: string;
}

export interface PlansFilters {
  readonly q: string;
}

export interface PlansSearch extends PlansFilters {
  readonly item?: string;
}

export interface TeamFilters {
  readonly q: string;
  readonly organization: OrganizationFilter;
}

export interface TeamSearch extends TeamFilters {
  readonly item?: string;
}

export function defaultProjectScope(_options: ProjectFilterOptions = {}): ProjectScope {
  return 'all';
}

function isSearchInput(input: unknown): input is SearchInput {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return false;
  const prototype = Object.getPrototypeOf(input);
  return prototype === Object.prototype || prototype === null;
}

function searchRecord(input: unknown): SearchInput {
  return isSearchInput(input) ? input : {};
}

function parseBoolean(value: unknown, fallback: boolean): boolean {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return fallback;
}

function parseItem(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function parseScope(value: unknown, options: ProjectFilterOptions): ProjectScope {
  const fallback = defaultProjectScope(options);
  if (typeof value !== 'string' || value.length === 0) return fallback;
  if (value === 'all') return value;
  if (options.projectIds === undefined || options.projectIds.has(value)) return value;
  return fallback;
}

function parseMode(value: unknown): WorkMode {
  if (typeof value !== 'string') return 'gantt';
  switch (value) {
    case 'tree': return value;
    case 'table': return value;
    case 'calendar': return value;
    case 'kanban': return value;
    case 'gantt': return value;
    default: return 'gantt';
  }
}

function parseActivityFilter(value: unknown): ActivityFilter {
  switch (value) {
    case 'recent': return value;
    case 'quiet': return value;
    case 'attention': return value;
    default: return 'all';
  }
}

function parseManagerPreset(value: unknown): WorkManagerPreset {
  return typeof value === 'string' && (WORK_MANAGER_PRESETS as readonly string[]).includes(value)
    ? value as WorkManagerPreset
    : 'none';
}

function parseDate(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const candidate = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(candidate)) return undefined;
  const date = new Date(`${candidate}T00:00:00.000Z`);
  return Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== candidate
    ? undefined
    : candidate;
}

function parseUndated(value: unknown): UndatedFilter {
  return value === 'exclude' || value === 'only' ? value : 'include';
}

function parseStringArray(value: unknown): string[] {
  let candidate: unknown = value;
  if (typeof candidate === 'string') {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(candidate)) return [];
  return candidate
    .filter((entry): entry is string => typeof entry === 'string')
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0 && entry !== '-')
    .filter((entry, index, entries) => entries.indexOf(entry) === index)
    .sort((left, right) => left.localeCompare(right));
}

function parseWorkOwners(value: unknown, options: WorkFilterOptions): string[] {
  const known = options.ownerValues;
  return [...new Set(parseStringArray(value)
    .map(owner => owner.toLowerCase() === 'unassigned' ? UNASSIGNED_OWNER : owner))]
    .filter(owner => known === undefined || known.has(owner))
    .sort((left, right) => left.localeCompare(right));
}

function parseWorkStatuses(value: unknown, options: WorkFilterOptions): string[] {
  const known = options.statusValues;
  return parseStringArray(value)
    .filter(status => known === undefined || known.has(status));
}

function parseManagerPeople(value: unknown, options: WorkFilterOptions): string[] {
  const known = options.managerPersonValues;
  return [...new Set(parseStringArray(value)
    .map(personId => personId.toLowerCase() === 'unassigned' ? UNASSIGNED_OWNER : personId)
    .filter(personId => known === undefined || known.has(personId)))]
    .sort((left, right) => left.localeCompare(right));
}

export function parseWorkSearch(
  input: unknown,
  options: ProjectFilterOptions & WorkFilterOptions = {},
): WorkSearch {
  const raw = searchRecord(input);
  const item = parseItem(raw.item);
  let from = parseDate(raw.from);
  let to = parseDate(raw.to);
  if (from !== undefined && to !== undefined && from > to) [from, to] = [to, from];
  const q = typeof raw.q === 'string' ? raw.q : '';
  const date = parseDate(raw.date);
  return {
    scope: parseScope(raw.scope, options),
    mode: parseMode(raw.mode),
    preset: parseManagerPreset(raw.preset),
    people: parseManagerPeople(raw.people, options),
    activity: parseActivityFilter(raw.activity),
    completed: parseBoolean(raw.completed, false),
    planned: parseBoolean(raw.planned, true),
    drafts: parseBoolean(raw.drafts, false),
    q,
    owners: parseWorkOwners(raw.owners, options),
    statuses: parseWorkStatuses(raw.statuses, options),
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
    undated: parseUndated(raw.undated),
    ...(date === undefined ? {} : { date }),
    ...(item === undefined ? {} : { item }),
  };
}

export function parseTodaySearch(input: unknown, options: ProjectFilterOptions = {}): TodaySearch {
  const raw = searchRecord(input);
  const item = parseItem(raw.item);
  return {
    scope: parseScope(raw.scope, options),
    completed: parseBoolean(raw.completed, false),
    planned: parseBoolean(raw.planned, true),
    drafts: parseBoolean(raw.drafts, false),
    ...(item === undefined ? {} : { item }),
  };
}

export function parsePlansSearch(input: unknown): PlansSearch {
  const raw = searchRecord(input);
  const q = typeof raw.q === 'string' ? raw.q : '';
  const item = parseItem(raw.item);
  return {
    q,
    ...(item === undefined ? {} : { item }),
  };
}

export function parseTeamSearch(input: unknown, options: TeamFilterOptions = {}): TeamSearch {
  const raw = searchRecord(input);
  const candidate = typeof raw.organization === 'string' ? raw.organization : 'all';
  const known = options.organizationLabels;
  const item = parseItem(raw.item);
  const org = candidate === 'all' || candidate === '__unrecorded__'
    ? candidate
    : known === undefined || known.has(candidate) ? candidate : 'all';
  return {
    q: typeof raw.q === 'string' ? raw.q : '',
    organization: org,
    ...(item === undefined ? {} : { item }),
  };
}

function compactBoolean(value: boolean, defaultValue: boolean): string | undefined {
  return value === defaultValue ? undefined : String(value);
}

export function compactWorkSearch(
  search: WorkSearch,
  options: ProjectFilterOptions & WorkFilterOptions = {},
): Record<string, string> {
  const normalized = parseWorkSearch(search, options);
  const scope = normalized.scope === defaultProjectScope(options) ? undefined : normalized.scope;
  const mode = normalized.mode === 'gantt' ? undefined : normalized.mode;
  const preset = normalized.preset === 'none' ? undefined : normalized.preset;
  const people = normalized.people.length === 0 ? undefined : JSON.stringify(normalized.people);
  const activity = normalized.activity === 'all' ? undefined : normalized.activity;
  const completed = compactBoolean(normalized.completed, false);
  const planned = compactBoolean(normalized.planned, true);
  const drafts = compactBoolean(normalized.drafts, false);
  return {
    ...(scope === undefined ? {} : { scope }),
    ...(mode === undefined ? {} : { mode }),
    ...(preset === undefined ? {} : { preset }),
    ...(people === undefined ? {} : { people }),
    ...(activity === undefined ? {} : { activity }),
    ...(completed === undefined ? {} : { completed }),
    ...(planned === undefined ? {} : { planned }),
    ...(drafts === undefined ? {} : { drafts }),
    ...(normalized.q.trim().length === 0 ? {} : { q: normalized.q }),
    ...(normalized.owners.length === 0 ? {} : { owners: JSON.stringify(normalized.owners) }),
    ...(normalized.statuses.length === 0 ? {} : { statuses: JSON.stringify(normalized.statuses) }),
    ...(normalized.from === undefined ? {} : { from: normalized.from }),
    ...(normalized.to === undefined ? {} : { to: normalized.to }),
    ...(normalized.undated === 'include' ? {} : { undated: normalized.undated }),
    ...(normalized.date === undefined ? {} : { date: normalized.date }),
    ...(normalized.item === undefined ? {} : { item: normalized.item }),
  };
}

export function compactTodaySearch(search: TodaySearch, options: ProjectFilterOptions = {}): Record<string, string> {
  const normalized = parseTodaySearch(search, options);
  const scope = normalized.scope === defaultProjectScope(options) ? undefined : normalized.scope;
  const completed = compactBoolean(normalized.completed, false);
  const planned = compactBoolean(normalized.planned, true);
  const drafts = compactBoolean(normalized.drafts, false);
  return {
    ...(scope === undefined ? {} : { scope }),
    ...(completed === undefined ? {} : { completed }),
    ...(planned === undefined ? {} : { planned }),
    ...(drafts === undefined ? {} : { drafts }),
    ...(normalized.item === undefined ? {} : { item: normalized.item }),
  };
}

export function compactPlansSearch(search: PlansSearch): Record<string, string> {
  const normalized = parsePlansSearch(search);
  return {
    ...(normalized.q.length === 0 ? {} : { q: normalized.q }),
    ...(normalized.item === undefined ? {} : { item: normalized.item }),
  };
}

export function compactTeamSearch(search: TeamSearch, options: TeamFilterOptions = {}): Record<string, string> {
  const normalized = parseTeamSearch(search, options);
  return {
    ...(normalized.q.length === 0 ? {} : { q: normalized.q }),
    ...(normalized.organization === 'all' ? {} : { organization: normalized.organization }),
    ...(normalized.item === undefined ? {} : { item: normalized.item }),
  };
}

export class BrowseFilterMemory {
  #work: WorkFilters | undefined;
  #today: TodayFilters | undefined;
  #plans: PlansFilters | undefined;
  #team: TeamFilters | undefined;

  rememberWork(input: unknown, options: ProjectFilterOptions & WorkFilterOptions = {}): void {
    const { item: _item, ...filters } = parseWorkSearch(input, options);
    this.#work = filters;
  }

  rememberToday(input: unknown, options: ProjectFilterOptions = {}): void {
    const { item: _item, ...filters } = parseTodaySearch(input, options);
    this.#today = filters;
  }

  rememberPlans(input: unknown): void {
    const { item: _item, ...filters } = parsePlansSearch(input);
    this.#plans = filters;
  }

  rememberTeam(input: unknown, options: TeamFilterOptions = {}): void {
    const { item: _item, ...filters } = parseTeamSearch(input, options);
    this.#team = filters;
  }

  restoreWork(options: ProjectFilterOptions & WorkFilterOptions = {}): WorkFilters {
    return parseWorkSearch(this.#work ?? {}, options);
  }

  restoreToday(options: ProjectFilterOptions = {}): TodayFilters {
    return parseTodaySearch(this.#today ?? {}, options);
  }

  restorePlans(): PlansFilters {
    return parsePlansSearch(this.#plans ?? {});
  }

  restoreTeam(options: TeamFilterOptions = {}): TeamFilters {
    return parseTeamSearch(this.#team ?? {}, options);
  }

  restore(
    family: BrowseFamily,
    options: ProjectFilterOptions & TeamFilterOptions & WorkFilterOptions = {},
  ): WorkFilters | TodayFilters | PlansFilters | TeamFilters {
    switch (family) {
      case 'work': return this.restoreWork(options);
      case 'today': return this.restoreToday(options);
      case 'plans': return this.restorePlans();
      case 'team': return this.restoreTeam(options);
      default: {
        const exhaustive: never = family;
        return exhaustive;
      }
    }
  }
}

export const sessionBrowseFilters = new BrowseFilterMemory();
