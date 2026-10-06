import { trackerInstanceConfig } from './instance-config';

export const THEME_STORAGE_KEY = trackerInstanceConfig.browser.themeKey;

export type ThemePreference = 'light' | 'dark' | 'system';
export type ResolvedTheme = Exclude<ThemePreference, 'system'>;

type ThemeStorage = Pick<Storage, 'getItem' | 'setItem'>;
type ThemeMediaEvent = Pick<MediaQueryListEvent, 'matches'>;

export interface ThemeMediaQuery {
  readonly matches: boolean;
  addEventListener?: (type: 'change', listener: (event: ThemeMediaEvent) => void) => void;
  removeEventListener?: (type: 'change', listener: (event: ThemeMediaEvent) => void) => void;
  addListener?: (listener: (event: ThemeMediaEvent) => void) => void;
  removeListener?: (listener: (event: ThemeMediaEvent) => void) => void;
}

export interface ThemeStoreOptions {
  storage?: ThemeStorage | null;
  matchMedia?: (() => ThemeMediaQuery | null) | null;
  apply?: (theme: ResolvedTheme, preference: ThemePreference) => void;
}

export interface ThemeStore {
  getPreference: () => ThemePreference;
  getResolvedTheme: () => ResolvedTheme;
  setPreference: (preference: ThemePreference) => void;
  subscribe: (listener: () => void) => () => void;
}

function isThemePreference(value: string | null): value is ThemePreference {
  return value === 'light' || value === 'dark' || value === 'system';
}

function getBrowserStorage(): ThemeStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function getBrowserMediaQuery(): ThemeMediaQuery | null {
  try {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null;
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    return {
      get matches() {
        return query.matches;
      },
      addEventListener: (_type, listener) => query.addEventListener('change', listener),
      removeEventListener: (_type, listener) => query.removeEventListener('change', listener),
      addListener: listener => query.addListener(listener),
      removeListener: listener => query.removeListener(listener),
    };
  } catch {
    return null;
  }
}

function applyThemeToDocument(theme: ResolvedTheme, preference: ThemePreference): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.dataset.themePreference = preference;
  root.classList.toggle('dark', theme === 'dark');
}

export function readThemePreference(storage: ThemeStorage | null): ThemePreference {
  try {
    const stored = storage?.getItem(THEME_STORAGE_KEY) ?? null;
    return isThemePreference(stored) ? stored : 'system';
  } catch {
    return 'system';
  }
}

export function resolveTheme(preference: ThemePreference, systemTheme: ResolvedTheme): ResolvedTheme {
  return preference === 'system' ? systemTheme : preference;
}

export function createThemeStore(options: ThemeStoreOptions = {}): ThemeStore {
  const storage = options.storage === undefined ? getBrowserStorage() : options.storage;
  const createMediaQuery = options.matchMedia === undefined ? getBrowserMediaQuery : options.matchMedia;
  const apply = options.apply ?? applyThemeToDocument;
  const listeners = new Set<() => void>();
  let preference = readThemePreference(storage);
  let mediaQuery: ThemeMediaQuery | null = null;
  let mediaQueryRead = false;
  let removeMediaListener: (() => void) | null = null;
  let resolvedTheme: ResolvedTheme = preference === 'system' && readSystemTheme() === 'dark' ? 'dark' : preference === 'dark' ? 'dark' : 'light';

  function readSystemTheme(): ResolvedTheme {
    const query = getMediaQuery();
    return query?.matches ? 'dark' : 'light';
  }

  function getMediaQuery(): ThemeMediaQuery | null {
    if (mediaQueryRead) return mediaQuery;
    mediaQueryRead = true;
    try {
      mediaQuery = createMediaQuery?.() ?? null;
    } catch {
      mediaQuery = null;
    }
    return mediaQuery;
  }

  function notify(): void {
    for (const listener of listeners) listener();
  }

  function updateResolvedTheme(next: ResolvedTheme): boolean {
    if (next === resolvedTheme) return false;
    resolvedTheme = next;
    apply(resolvedTheme, preference);
    return true;
  }

  function onSystemThemeChange(event: ThemeMediaEvent): void {
    if (preference !== 'system') return;
    if (updateResolvedTheme(event.matches ? 'dark' : 'light')) notify();
  }

  function stopListeningToSystemTheme(): void {
    removeMediaListener?.();
    removeMediaListener = null;
  }

  function syncSystemThemeListener(): void {
    if (preference !== 'system' || listeners.size === 0) {
      stopListeningToSystemTheme();
      return;
    }

    const query = getMediaQuery();
    if (!query) return;
    if (updateResolvedTheme(query.matches ? 'dark' : 'light')) notify();
    if (removeMediaListener) return;

    try {
      if (query.addEventListener && query.removeEventListener) {
        query.addEventListener('change', onSystemThemeChange);
        removeMediaListener = () => query.removeEventListener?.('change', onSystemThemeChange);
      } else if (query.addListener && query.removeListener) {
        query.addListener(onSystemThemeChange);
        removeMediaListener = () => query.removeListener?.(onSystemThemeChange);
      }
    } catch {
      removeMediaListener = null;
    }
  }

  function setPreference(nextPreference: ThemePreference): void {
    try {
      storage?.setItem(THEME_STORAGE_KEY, nextPreference);
    } catch {
      // Keep the selected theme in memory when browser storage is unavailable.
    }

    const preferenceChanged = nextPreference !== preference;
    preference = nextPreference;
    const nextResolved = resolveTheme(preference, preference === 'system' ? readSystemTheme() : resolvedTheme);
    const resolvedChanged = updateResolvedTheme(nextResolved);
    apply(resolvedTheme, preference);
    syncSystemThemeListener();
    if (preferenceChanged || resolvedChanged) notify();
  }

  apply(resolvedTheme, preference);

  return {
    getPreference: () => preference,
    getResolvedTheme: () => resolvedTheme,
    setPreference,
    subscribe(listener) {
      listeners.add(listener);
      syncSystemThemeListener();
      return () => {
        listeners.delete(listener);
        syncSystemThemeListener();
      };
    },
  };
}

export const themeStore = createThemeStore();
