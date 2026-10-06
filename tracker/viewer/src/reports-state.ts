import { defaultProjectScope, UNASSIGNED_OWNER, type ProjectFilterOptions, type SearchInput } from './routing-state';

export interface ReportsFilterOptions extends ProjectFilterOptions {
  readonly ownerValues?: ReadonlySet<string>;
}

export interface ReportsFilters {
  readonly scope: string;
  readonly completed: boolean;
  readonly owners: string[];
}

export type ReportsSearch = ReportsFilters;

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

function parseScope(value: unknown, options: ReportsFilterOptions): string {
  const fallback = defaultProjectScope(options);
  if (typeof value !== 'string' || value.length === 0) return fallback;
  if (value === 'all') return value;
  return options.projectIds === undefined || options.projectIds.has(value) ? value : fallback;
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

function ownerFilterValues(value: unknown, options: ReportsFilterOptions): string[] {
  const known = options.ownerValues;
  return [...new Set(parseStringArray(value)
    .map(owner => owner.toLowerCase() === 'unassigned' ? UNASSIGNED_OWNER : owner))]
    .filter(owner => known === undefined || known.has(owner))
    .sort((left, right) => left.localeCompare(right));
}

export function reportsSearchDefaults(options: ReportsFilterOptions = {}): ReportsSearch {
  return {
    scope: defaultProjectScope(options),
    completed: false,
    owners: [],
  };
}

export function parseReportsSearch(
  input: unknown,
  options: ReportsFilterOptions = {},
): ReportsSearch {
  const raw = searchRecord(input);
  return {
    scope: parseScope(raw.scope, options),
    completed: parseBoolean(raw.completed, false),
    owners: ownerFilterValues(raw.owners, options),
  };
}

export function compactReportsSearch(
  filters: ReportsFilters,
  options: ReportsFilterOptions = {},
): Record<string, string> {
  const normalized = parseReportsSearch(filters, options);
  const scope = normalized.scope === defaultProjectScope(options) ? undefined : normalized.scope;
  return {
    ...(scope === undefined ? {} : { scope }),
    ...(normalized.completed ? { completed: 'true' } : {}),
    ...(normalized.owners.length === 0 ? {} : { owners: JSON.stringify(normalized.owners) }),
  };
}

export class ReportsFilterMemory {
  #filters: ReportsFilters | undefined;

  remember(input: unknown, options: ReportsFilterOptions = {}): void {
    this.#filters = parseReportsSearch(input, options);
  }

  restore(options: ReportsFilterOptions = {}): ReportsFilters {
    return parseReportsSearch(this.#filters ?? {}, options);
  }
}

export const sessionReportsFilters = new ReportsFilterMemory();
