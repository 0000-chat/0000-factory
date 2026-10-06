import { describe, expect, test } from 'bun:test';
import {
  createThemeStore,
  THEME_STORAGE_KEY,
  type ThemeMediaQuery,
  type ThemePreference,
  type ThemeStoreOptions,
} from '../src/theme';

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
  };
}

function mediaQuery(initial = false) {
  let matches = initial;
  const listeners = new Set<(event: { matches: boolean }) => void>();
  const query: ThemeMediaQuery = {
    get matches() {
      return matches;
    },
    addEventListener(_type, listener) {
      listeners.add(listener);
    },
    removeEventListener(_type, listener) {
      listeners.delete(listener);
    },
  };

  return {
    query,
    listenerCount: () => listeners.size,
    change(next: boolean) {
      matches = next;
      for (const listener of listeners) listener({ matches });
    },
  };
}

function createStoreOptions(options: ThemeStoreOptions = {}) {
  const applied: Array<{ theme: 'light' | 'dark'; preference: ThemePreference }> = [];
  return {
    ...options,
    applied,
    apply(theme: 'light' | 'dark', preference: ThemePreference) {
      applied.push({ theme, preference });
    },
  };
}

describe('theme preference state', () => {
  test('defaults to system and resolves the current device preference', () => {
    const media = mediaQuery(true);
    const options = createStoreOptions({
      storage: memoryStorage(),
      matchMedia: () => media.query,
    });
    const store = createThemeStore(options);

    expect(store.getPreference()).toBe('system');
    expect(store.getResolvedTheme()).toBe('dark');
    expect(options.applied.at(-1)).toEqual({ theme: 'dark', preference: 'system' });
  });

  test('follows system changes only while system mode is selected', () => {
    const media = mediaQuery(false);
    const store = createThemeStore({
      storage: memoryStorage(),
      matchMedia: () => media.query,
      apply: () => {},
    });
    const unsubscribe = store.subscribe(() => {});

    expect(media.listenerCount()).toBe(1);
    media.change(true);
    expect(store.getResolvedTheme()).toBe('dark');

    store.setPreference('light');
    expect(media.listenerCount()).toBe(0);
    media.change(false);
    expect(store.getResolvedTheme()).toBe('light');

    store.setPreference('system');
    expect(media.listenerCount()).toBe(1);
    expect(store.getResolvedTheme()).toBe('light');
    unsubscribe();
    expect(media.listenerCount()).toBe(0);
  });

  test('uses valid saved preferences and ignores corrupt storage values', () => {
    const explicitStorage = memoryStorage({ [THEME_STORAGE_KEY]: 'dark' });
    let mediaReads = 0;
    const explicit = createThemeStore({
      storage: explicitStorage,
      matchMedia: () => {
        mediaReads += 1;
        return mediaQuery(true).query;
      },
      apply: () => {},
    });

    expect(explicit.getPreference()).toBe('dark');
    expect(explicit.getResolvedTheme()).toBe('dark');
    expect(mediaReads).toBe(0);

    const corrupt = createThemeStore({
      storage: memoryStorage({ [THEME_STORAGE_KEY]: 'sepia' }),
      matchMedia: () => mediaQuery(false).query,
      apply: () => {},
    });
    expect(corrupt.getPreference()).toBe('system');
    expect(corrupt.getResolvedTheme()).toBe('light');
  });

  test('keeps in-memory selection when storage reads or writes fail', () => {
    const failingStorage = {
      getItem() {
        throw new Error('storage blocked');
      },
      setItem() {
        throw new Error('storage blocked');
      },
    };
    const store = createThemeStore({
      storage: failingStorage,
      matchMedia: () => mediaQuery(false).query,
      apply: () => {},
    });

    expect(store.getPreference()).toBe('system');
    expect(() => store.setPreference('dark')).not.toThrow();
    expect(store.getPreference()).toBe('dark');
    expect(store.getResolvedTheme()).toBe('dark');
  });

  test('persists an explicit selection for the next store instance', () => {
    const storage = memoryStorage();
    const first = createThemeStore({
      storage,
      matchMedia: () => mediaQuery(false).query,
      apply: () => {},
    });

    first.setPreference('dark');
    const afterReload = createThemeStore({
      storage,
      matchMedia: () => mediaQuery(false).query,
      apply: () => {},
    });

    expect(storage.values.get(THEME_STORAGE_KEY)).toBe('dark');
    expect(afterReload.getPreference()).toBe('dark');
    expect(afterReload.getResolvedTheme()).toBe('dark');
  });
});
