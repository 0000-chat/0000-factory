import {
  compactPlansSearch,
  compactTeamSearch,
  compactTodaySearch,
  compactWorkSearch,
  parsePlansSearch,
  parseTeamSearch,
  parseTodaySearch,
  parseWorkSearch,
  type ProjectFilterOptions,
  type SearchInput,
  type TeamFilterOptions,
  type WorkFilterOptions,
} from './routing-state.ts';
import { compactReportsSearch, parseReportsSearch } from './reports-state';

export type SupportedPath =
  | { readonly kind: 'root' }
  | { readonly kind: 'today' }
  | { readonly kind: 'work'; readonly itemId?: string }
  | { readonly kind: 'plans'; readonly planId?: string }
  | { readonly kind: 'weekly-planning' }
  | { readonly kind: 'team'; readonly memberSlug?: string }
  | { readonly kind: 'reports' }
  | { readonly kind: 'decision'; readonly decisionId: string }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'unknown' };

export interface NavigationLocation {
  readonly pathname: string;
  readonly search: SearchInput;
}

export type NavigationMutation =
  | { readonly kind: 'push' | 'replace'; readonly pathname: string; readonly search: SearchInput }
  | { readonly kind: 'none' };

export interface InternalLinkTarget {
  readonly pathname: string;
  readonly search: Record<string, string>;
  readonly hash: string;
}

const INTERNAL_ORIGIN = 'https://tracker.invalid';
const INVALID_PATH = '/__invalid_link__';

function safeDecodeSegment(raw: string): string | null {
  try {
    const value = decodeURIComponent(raw);
    if (value.length === 0 || value === '.' || value === '..') return null;
    if (/[\/\\\u0000-\u001f\u007f]/u.test(value)) return null;
    return value;
  } catch {
    return null;
  }
}

export function classifySupportedPath(pathname: string): SupportedPath {
  const path = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  if (path === '/') return { kind: 'root' };
  if (path === '/today') return { kind: 'today' };
  if (path === '/work') return { kind: 'work' };
  if (path === '/plans') return { kind: 'plans' };
  if (path === '/weekly-planning') return { kind: 'weekly-planning' };
  if (path === '/team') return { kind: 'team' };
  if (path === '/reports') return { kind: 'reports' };

  const match = /^\/(work|plans|team|decisions)\/([^/]+)$/u.exec(path);
  if (!match) return { kind: 'unknown' };
  const [, section, rawId] = match;
  const id = safeDecodeSegment(rawId);
  if (id === null) return { kind: 'invalid' };
  switch (section) {
    case 'work': return { kind: 'work', itemId: id };
    case 'plans': return { kind: 'plans', planId: id };
    case 'team': return { kind: 'team', memberSlug: id };
    case 'decisions': return { kind: 'decision', decisionId: id };
    default: return { kind: 'unknown' };
  }
}

export function encodePathSegment(value: string): string {
  return encodeURIComponent(value);
}

export function teamPath(memberSlug?: string): string {
  return memberSlug === undefined ? '/team' : `/team/${encodePathSegment(memberSlug)}`;
}

export function workItemPath(itemId: string): string {
  return `/work/${encodePathSegment(itemId)}`;
}

export function decisionPath(decisionId: string): string {
  return `/decisions/${encodePathSegment(decisionId)}`;
}

export function parseUrlSearch(search: string): Record<string, string> {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const result: Record<string, string> = {};
  for (const [key, value] of params) result[key] = value;
  return result;
}

export function formatUrl(pathname: string, search: Readonly<Record<string, string>>, hash = ''): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(search)) params.set(key, value);
  const query = params.toString();
  return `${pathname}${query.length === 0 ? '' : `?${query}`}${hash}`;
}

function isBrowsingPath(pathname: string): boolean {
  const route = classifySupportedPath(pathname);
  return route.kind === 'today'
    || (route.kind === 'work' && route.itemId === undefined)
    || route.kind === 'plans'
    || route.kind === 'team';
}

export function selectedItemId(search: SearchInput): string | undefined {
  const item = search.item;
  return typeof item === 'string' && item.length > 0 ? item : undefined;
}

export function selectItemMutation(location: NavigationLocation, itemId: string): NavigationMutation {
  if (!isBrowsingPath(location.pathname) || itemId.length === 0) return { kind: 'none' };
  const current = selectedItemId(location.search);
  if (current === itemId) return { kind: 'none' };
  return {
    kind: current === undefined ? 'push' : 'replace',
    pathname: location.pathname,
    search: { ...location.search, item: itemId },
  };
}

export function closeItemMutation(location: NavigationLocation): NavigationMutation {
  if (!isBrowsingPath(location.pathname) || selectedItemId(location.search) === undefined) return { kind: 'none' };
  const { item: _item, ...search } = location.search;
  return { kind: 'replace', pathname: location.pathname, search };
}

export function replaceFiltersMutation(location: NavigationLocation, changes: SearchInput): NavigationMutation {
  if (!isBrowsingPath(location.pathname)) return { kind: 'none' };
  const currentItem = selectedItemId(location.search);
  const { item: _requestedItem, ...filters } = changes;
  const search = { ...location.search, ...filters };
  if (currentItem === undefined) delete search.item;
  else search.item = currentItem;
  return {
    kind: 'replace',
    pathname: location.pathname,
    search,
  };
}

export interface ReturnToOptions extends ProjectFilterOptions, TeamFilterOptions, WorkFilterOptions {}

export function validatedReturnTo(value: unknown, options: ReturnToOptions = {}): string | null {
  if (typeof value !== 'string' || value.length === 0 || !value.startsWith('/') || value.startsWith('//')) return null;
  if (/[\\\u0000-\u001f\u007f]/u.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value, INTERNAL_ORIGIN);
  } catch {
    return null;
  }
  if (url.origin !== INTERNAL_ORIGIN || url.hash.length > 0) return null;
  const route = classifySupportedPath(url.pathname);
  const query = parseUrlSearch(url.search);
  const { item: _item, ...filters } = query;
  switch (route.kind) {
    case 'work': {
      if (route.itemId !== undefined) return null;
      const compact = compactWorkSearch(parseWorkSearch(filters, options), options);
      return formatUrl('/work', compact);
    }
    case 'today': {
      const compact = compactTodaySearch(parseTodaySearch(filters, options), options);
      return formatUrl('/today', compact);
    }
    case 'plans': {
      const compact = compactPlansSearch(parsePlansSearch(filters));
      const pathname = route.planId === undefined ? '/plans' : `/plans/${encodePathSegment(route.planId)}`;
      return formatUrl(pathname, compact);
    }
    case 'team': {
      const compact = compactTeamSearch(parseTeamSearch(filters, options), options);
      const pathname = route.memberSlug === undefined ? '/team' : teamPath(route.memberSlug);
      return formatUrl(pathname, compact);
    }
    case 'reports':
      return formatUrl('/reports', compactReportsSearch(parseReportsSearch(filters, options), options));
    default:
      return null;
  }
}

export function internalLinkTarget(href: string, currentHref: string): InternalLinkTarget | null {
  let current: URL;
  let target: URL;
  try {
    current = new URL(currentHref);
    target = new URL(href, current);
  } catch {
    return null;
  }
  if (target.origin !== current.origin) return null;
  const route = classifySupportedPath(target.pathname);
  if (route.kind === 'invalid' || route.kind === 'unknown') return null;
  return {
    pathname: route.kind === 'root' ? '/work' : target.pathname,
    search: parseUrlSearch(target.search),
    hash: target.hash,
  };
}

export function shouldInterceptMarkdownClick(
  event: MouseEvent,
  anchor: HTMLAnchorElement,
): boolean {
  if (event.defaultPrevented || event.button !== 0) return false;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;
  if (anchor.hasAttribute('download')) return false;
  const target = anchor.getAttribute('target');
  if (target !== null && target.length > 0 && target.toLowerCase() !== '_self') return false;
  return anchor.closest('.markdown') !== null;
}

export function legacyHashPath(hash: string): string | null {
  if (!hash.startsWith('#/')) return null;
  const legacy = hash.slice(1);
  const fragmentAt = legacy.indexOf('#');
  const withoutFragment = fragmentAt < 0 ? legacy : legacy.slice(0, fragmentAt);
  const fragment = fragmentAt < 0 ? '' : legacy.slice(fragmentAt);
  const queryAt = withoutFragment.indexOf('?');
  const pathname = queryAt < 0 ? withoutFragment : withoutFragment.slice(0, queryAt);
  const search = queryAt < 0 ? '' : withoutFragment.slice(queryAt);
  if (pathname === '/') return `/work${search}${fragment}`;
  const route = classifySupportedPath(pathname);
  if (route.kind === 'invalid') return `${INVALID_PATH}${search}`;
  return `${pathname}${search}${fragment}`;
}

export interface BrowserLocationLike {
  readonly pathname: string;
  readonly search: string;
  readonly hash: string;
}

export function legacyLocationPath(location: BrowserLocationLike): string | null {
  const migrated = legacyHashPath(location.hash);
  return migrated === null ? null : migrated;
}

export function currentBrowseSearch(
  pathname: string,
  rawSearch: SearchInput,
  options: ReturnToOptions = {},
): Record<string, string> {
  const route = classifySupportedPath(pathname);
  switch (route.kind) {
    case 'work': return route.itemId === undefined ? compactWorkSearch(parseWorkSearch(rawSearch, options), options) : {};
    case 'today': return compactTodaySearch(parseTodaySearch(rawSearch, options), options);
    case 'plans': return compactPlansSearch(parsePlansSearch(rawSearch));
    case 'team': return compactTeamSearch(parseTeamSearch(rawSearch, options), options);
    case 'reports': return compactReportsSearch(parseReportsSearch(rawSearch, options), options);
    default: return {};
  }
}
