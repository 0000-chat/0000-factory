import type { WorkSearch, WorkWorkflow } from './routing-state';

const MANILA_ZONE = 'Asia/Manila';
const DAY_MS = 24 * 60 * 60 * 1000;

export interface WorkWeek {
  readonly start: string;
  readonly end: string;
}

function dateParts(value: Date): Record<string, string> {
  return Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: MANILA_ZONE,
    calendar: 'gregory',
    numberingSystem: 'latn',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(value).map(part => [part.type, part.value]));
}

function dayOrdinal(day: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(day);
  if (!match) return null;
  const value = new Date(0);
  value.setUTCHours(0, 0, 0, 0);
  value.setUTCFullYear(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return value.getUTCFullYear() === Number(match[1])
    && value.getUTCMonth() === Number(match[2]) - 1
    && value.getUTCDate() === Number(match[3])
    ? Math.floor(value.valueOf() / DAY_MS)
    : null;
}

function dayAtOrdinal(ordinal: number): string {
  return new Date(ordinal * DAY_MS).toISOString().slice(0, 10);
}

/** Return the current calendar day in Asia/Manila. */
export function manilaTodayKey(now: Date = new Date()): string {
  const parts = dateParts(now);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** Return the Monday for the Manila week containing the supplied day. */
export function mondayForManilaDay(day: string): string {
  const ordinal = dayOrdinal(day);
  if (ordinal === null) return mondayForManilaDay(manilaTodayKey());
  const weekday = ((ordinal + 4) % 7 + 7) % 7;
  return dayAtOrdinal(ordinal - (weekday === 0 ? 6 : weekday - 1));
}

/** Build a Monday–Friday work week from any valid Manila day. */
export function workWeekForManilaDay(day: string): WorkWeek {
  const start = mondayForManilaDay(day);
  const ordinal = dayOrdinal(start) ?? dayOrdinal(mondayForManilaDay(manilaTodayKey())) ?? 0;
  return { start, end: dayAtOrdinal(ordinal + 4) };
}

export function shiftWorkWeek(week: WorkWeek, amount: number): WorkWeek {
  const start = dayOrdinal(week.start) ?? dayOrdinal(workWeekForManilaDay(manilaTodayKey()).start) ?? 0;
  return workWeekForManilaDay(dayAtOrdinal(start + amount * 7));
}

/** Use a recorded range when available, otherwise the current Manila week. */
export function workWeekFromSearch(search: Pick<WorkSearch, 'from' | 'to'>, now: Date = new Date()): WorkWeek {
  return workWeekForManilaDay(search.from ?? search.to ?? manilaTodayKey(now));
}

export function isManilaWeekday(day: string): boolean {
  const ordinal = dayOrdinal(day);
  if (ordinal === null) return false;
  const weekday = ((ordinal + 4) % 7 + 7) % 7;
  return weekday >= 1 && weekday <= 5;
}

export function workWeekLabel(week: WorkWeek): string {
  const format = (day: string) => new Intl.DateTimeFormat('en-PH', {
    timeZone: MANILA_ZONE,
    month: 'short',
    day: 'numeric',
  }).format(new Date(`${day}T12:00:00+08:00`));
  return `${format(week.start)}–${format(week.end)}`;
}

/** Apply the documented defaults for one of the read-only work workflows. */
export type WorkWorkflowSelection = WorkWorkflow | 'standard';

export function workflowSearch(search: WorkSearch, workflow: WorkWorkflowSelection, week: WorkWeek): WorkSearch {
  const base: WorkSearch = {
    ...search,
    from: week.start,
    to: week.end,
    ...(workflow === 'standard' ? {} : { workflow }),
  };
  switch (workflow) {
    case 'this-week':
      return { ...base, mode: 'gantt', activity: 'all', completed: false, planned: false, drafts: false, statuses: [], undated: 'exclude' };
    case 'daily-review':
      return { ...base, mode: 'tree', activity: 'all', completed: false, planned: true, drafts: false, undated: 'include' };
    case 'next-week':
      return { ...base, mode: 'tree', activity: 'all', completed: false, planned: true, drafts: true, undated: 'include' };
    default:
      return { ...search, workflow: undefined };
  }
}
