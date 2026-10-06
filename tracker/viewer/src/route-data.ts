import type { SearchMiddleware } from '@tanstack/react-router';
import type { TrackerSnapshot } from './snapshot';
import { parsePlansSearch, parseTeamSearch, parseTodaySearch, parseWorkSearch, UNASSIGNED_OWNER, type PlansSearch, type ProjectFilterOptions, type TeamFilterOptions, type TeamSearch, type TodaySearch, type WorkFilterOptions, type WorkSearch } from './routing-state';
import { workFilterOptions } from './work-filters';
import { reportFilterOptions } from './reports-model';
import { parseReportsSearch, type ReportsFilterOptions, type ReportsSearch } from './reports-state';

let activeProjectOptions: ProjectFilterOptions & WorkFilterOptions = {};
let activeTeamOptions: TeamFilterOptions = {};
let activeReportsOptions: ReportsFilterOptions = {};

export function configureRouteFilters(data: TrackerSnapshot): void {
  activeProjectOptions = projectFilterOptions(data);
  activeTeamOptions = teamFilterOptions(data);
  activeReportsOptions = reportFilterOptions(data);
}

export function validateReportsRouteSearch(search: Record<string, unknown>): ReportsSearch {
  return parseReportsSearch(search, activeReportsOptions);
}

export function reportsRouteSearchDefaults(): ReportsSearch {
  return parseReportsSearch({}, activeReportsOptions);
}

export function validateWorkRouteSearch(search: Record<string, unknown>) {
  return parseWorkSearch(search, activeProjectOptions);
}

export function validateTodayRouteSearch(search: Record<string, unknown>) {
  return parseTodaySearch(search, activeProjectOptions);
}

export function validatePlansRouteSearch(search: Record<string, unknown>) {
  return parsePlansSearch(search);
}

export function validateTeamRouteSearch(search: Record<string, unknown>) {
  return parseTeamSearch(search, activeTeamOptions);
}

export function stripDynamicSearchDefaults<T extends object>(
  defaults: () => object,
): SearchMiddleware<T> {
  return ({ search, next }) => {
    const result = { ...next(search) };
    for (const [key, value] of Object.entries(defaults())) {
      if (Object.hasOwn(result, key) && sameSearchValue(Reflect.get(result, key), value)) Reflect.deleteProperty(result, key);
    }
    return result;
  };
}

function sameSearchValue(value: unknown, defaultValue: unknown): boolean {
  if (Object.is(value, defaultValue)) return true;
  return Array.isArray(value)
    && Array.isArray(defaultValue)
    && value.length === defaultValue.length
    && value.every((entry, index) => Object.is(entry, defaultValue[index]));
}

export function workRouteSearchDefaults(): WorkSearch {
  return parseWorkSearch({}, activeProjectOptions);
}

export function todayRouteSearchDefaults(): TodaySearch {
  return parseTodaySearch({}, activeProjectOptions);
}

export function plansRouteSearchDefaults(): PlansSearch {
  return parsePlansSearch({});
}

export function teamRouteSearchDefaults(): TeamSearch {
  return parseTeamSearch({}, activeTeamOptions);
}

export function projectFilterOptions(data: TrackerSnapshot): ProjectFilterOptions & WorkFilterOptions {
  const workChoices = workFilterOptions(data);
  const managerPersonValues = new Set<string>([UNASSIGNED_OWNER]);
  const people = Array.isArray(data.people) ? data.people : [];
  for (const person of people) {
    if (typeof person !== 'object' || person === null) continue;
    const record = person as Record<string, unknown>;
    if (record.status === 'active' && typeof record.id === 'string' && record.id.length > 0) {
      managerPersonValues.add(record.id);
    }
  }
  return {
    projectIds: new Set(data.items
      .filter(item => item.childIds.length > 0 || item.type === 'project' || !item.parent)
      .map(item => item.id)),
    ownerValues: new Set(workChoices.owners.map(choice => choice.value)),
    statusValues: new Set(workChoices.statuses.map(choice => choice.value)),
    managerPersonValues,
  };
}

export function teamFilterOptions(data: TrackerSnapshot): TeamFilterOptions {
  const labels = new Set<string>();
  for (const profile of data.team) {
    const organization = profile.organization;
    if (typeof organization === 'string' && organization.length > 0) labels.add(organization);
    const organizations = profile.organizations;
    if (Array.isArray(organizations)) {
      for (const value of organizations) if (typeof value === 'string' && value.length > 0) labels.add(value);
    }
  }
  return { organizationLabels: labels };
}
