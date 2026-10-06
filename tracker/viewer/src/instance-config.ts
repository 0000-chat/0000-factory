/**
 * The browser-safe site settings projection.
 *
 * Build output replaces `__TRACKER_PUBLIC_INSTANCE__` with the generated
 * projection. Unbundled tests provide the same value on globalThis through
 * their preload. Keeping the parse at this boundary means browser modules do
 * not need to know about the private settings shape or runtime policy.
 */

declare const __TRACKER_PUBLIC_INSTANCE__: unknown;

export interface PublicInstanceBranding {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly markText: string;
  readonly homeLabel: string;
  readonly loadingLabel: string;
  readonly faviconPath: string;
}

export interface PublicInstanceSource {
  readonly owner: string;
  readonly repo: string;
  readonly branch: string;
  readonly folderPath: string;
}

export interface PublicInstanceBrowser {
  readonly namespace: string;
  readonly storeId: string;
  readonly themeKey: string;
  readonly editLockPrefix: string;
  readonly publishLockName: string;
  readonly unscheduledCollapsedKey: string;
  readonly activityPausedKey: string;
}

export interface PublicInstanceConfig {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly branding: PublicInstanceBranding;
  readonly source: PublicInstanceSource;
  readonly browser: PublicInstanceBrowser;
  readonly publishing: { readonly kind: 'enabled' | 'disabled' };
}

export class PublicInstanceConfigError extends TypeError {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = 'PublicInstanceConfigError';
    this.path = path;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new PublicInstanceConfigError(path, 'must be an object');
  return value;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], path: string): void {
  const allowed = new Set(expected);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new PublicInstanceConfigError(`${path}.${key}`, 'unknown field');
  }
}

function text(value: unknown, path: string, max: number): string {
  if (typeof value !== 'string') throw new PublicInstanceConfigError(path, 'must be a string');
  if (value.length < 1 || value.length > max) {
    throw new PublicInstanceConfigError(path, `must contain between 1 and ${max} characters`);
  }
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    throw new PublicInstanceConfigError(path, 'contains a control character');
  }
  return value;
}

function identifier(value: unknown, path: string): string {
  const result = text(value, path, 63);
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(result)) {
    throw new PublicInstanceConfigError(path, 'has an invalid instance identifier');
  }
  return result;
}

function repositoryName(value: unknown, path: string): string {
  const result = text(value, path, 100);
  if (!/^[A-Za-z0-9_.-]+$/u.test(result) || result === '.' || result === '..') {
    throw new PublicInstanceConfigError(path, 'has an invalid repository name');
  }
  return result;
}

function gitRef(value: unknown, path: string): string {
  const result = text(value, path, 255);
  const segments = result.split('/');
  if (
    result.startsWith('-') || result.startsWith('/') || result.endsWith('/') || result.endsWith('.')
    || result.includes('//') || result.includes('..') || result.includes('@{')
    || /[\u0000-\u0020~^:?*[\\]/u.test(result)
    || segments.some(segment => (
      segment.length === 0 || segment === '.' || segment === '..'
      || segment.startsWith('.') || segment.endsWith('.lock')
    ))
  ) throw new PublicInstanceConfigError(path, 'is not a valid Git ref');
  return result;
}

function repositoryPath(value: unknown, path: string, allowEmpty = false, assets = false): string {
  if (typeof value !== 'string') throw new PublicInstanceConfigError(path, 'must be a string');
  if (value.length === 0 && allowEmpty) return '';
  if (value.length === 0) throw new PublicInstanceConfigError(path, 'must not be empty');
  if (
    value !== value.trim()
    || value.includes('\\')
    || value.includes('%')
  ) {
    throw new PublicInstanceConfigError(path, 'must use unencoded POSIX path segments');
  }
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    throw new PublicInstanceConfigError(path, 'contains a control character');
  }
  if (value.startsWith('/') || /^[A-Za-z]:/u.test(value)) {
    throw new PublicInstanceConfigError(path, 'must be repository-relative');
  }
  const segments = value.split('/');
  if (segments.some(segment => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new PublicInstanceConfigError(path, 'contains an empty, current, or parent segment');
  }
  if (assets && (segments[0] !== 'assets' || segments.length < 2)) {
    throw new PublicInstanceConfigError(path, 'must be inside the assets directory');
  }
  return segments.join('/');
}

function browserKey(value: unknown, path: string, namespace: string, separator: string): string {
  const result = text(value, path, 160);
  if (result.includes('/') || result.includes('\\') || result.includes('%')) {
    throw new PublicInstanceConfigError(path, 'must be a browser storage or lock key');
  }
  if (!result.startsWith(`${namespace}${separator}`)) {
    throw new PublicInstanceConfigError(path, `must use the ${namespace} namespace`);
  }
  return result;
}

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

/** Validate a browser-safe projection at the application boundary. */
export function parsePublicInstanceConfig(value: unknown): PublicInstanceConfig {
  const input = object(value, 'publicInstance');
  exactKeys(input, ['schemaVersion', 'id', 'branding', 'source', 'browser', 'publishing'], 'publicInstance');
  if (input.schemaVersion !== 1) {
    throw new PublicInstanceConfigError('publicInstance.schemaVersion', 'must be 1');
  }

  const id = identifier(input.id, 'publicInstance.id');
  const brandingInput = object(input.branding, 'publicInstance.branding');
  exactKeys(brandingInput, ['name', 'title', 'description', 'markText', 'homeLabel', 'loadingLabel', 'faviconPath'], 'publicInstance.branding');
  const sourceInput = object(input.source, 'publicInstance.source');
  exactKeys(sourceInput, ['owner', 'repo', 'branch', 'folderPath'], 'publicInstance.source');
  const browserInput = object(input.browser, 'publicInstance.browser');
  exactKeys(browserInput, ['namespace', 'storeId', 'themeKey', 'editLockPrefix', 'publishLockName', 'unscheduledCollapsedKey', 'activityPausedKey'], 'publicInstance.browser');
  const publishingInput = object(input.publishing, 'publicInstance.publishing');
  exactKeys(publishingInput, ['kind'], 'publicInstance.publishing');
  if (publishingInput.kind !== 'enabled' && publishingInput.kind !== 'disabled') {
    throw new PublicInstanceConfigError('publicInstance.publishing.kind', 'must be enabled or disabled');
  }

  const namespace = identifier(browserInput.namespace, 'publicInstance.browser.namespace');
  if (namespace !== id) {
    throw new PublicInstanceConfigError('publicInstance.browser.namespace', 'must match publicInstance.id');
  }

  return freezeDeep({
    schemaVersion: 1,
    id,
    branding: {
      name: text(brandingInput.name, 'publicInstance.branding.name', 96),
      title: text(brandingInput.title, 'publicInstance.branding.title', 160),
      description: text(brandingInput.description, 'publicInstance.branding.description', 512),
      markText: text(brandingInput.markText, 'publicInstance.branding.markText', 32),
      homeLabel: text(brandingInput.homeLabel, 'publicInstance.branding.homeLabel', 96),
      loadingLabel: text(brandingInput.loadingLabel, 'publicInstance.branding.loadingLabel', 160),
      faviconPath: repositoryPath(brandingInput.faviconPath, 'publicInstance.branding.faviconPath', false, true),
    },
    source: {
      owner: repositoryName(sourceInput.owner, 'publicInstance.source.owner'),
      repo: repositoryName(sourceInput.repo, 'publicInstance.source.repo'),
      branch: gitRef(sourceInput.branch, 'publicInstance.source.branch'),
      folderPath: repositoryPath(sourceInput.folderPath, 'publicInstance.source.folderPath', true),
    },
    browser: {
      namespace,
      storeId: browserKey(browserInput.storeId, 'publicInstance.browser.storeId', namespace, '-'),
      themeKey: browserKey(browserInput.themeKey, 'publicInstance.browser.themeKey', namespace, '-'),
      editLockPrefix: browserKey(browserInput.editLockPrefix, 'publicInstance.browser.editLockPrefix', namespace, '-'),
      publishLockName: browserKey(browserInput.publishLockName, 'publicInstance.browser.publishLockName', namespace, '-'),
      unscheduledCollapsedKey: browserKey(browserInput.unscheduledCollapsedKey, 'publicInstance.browser.unscheduledCollapsedKey', namespace, '.'),
      activityPausedKey: browserKey(browserInput.activityPausedKey, 'publicInstance.browser.activityPausedKey', namespace, '.'),
    },
    publishing: { kind: publishingInput.kind },
  });
}

function injectedProjection(): unknown {
  // `typeof` remains safe in unbundled tests where the build-time identifier
  // does not exist. A generated bundle replaces the identifier expression.
  if (typeof __TRACKER_PUBLIC_INSTANCE__ !== 'undefined') return __TRACKER_PUBLIC_INSTANCE__;
  return Reflect.get(globalThis, '__TRACKER_PUBLIC_INSTANCE__');
}

function loadPublicInstanceConfig(): PublicInstanceConfig {
  const candidate = injectedProjection();
  if (candidate === undefined) {
    throw new Error('Tracker public instance configuration is missing. Build or preload __TRACKER_PUBLIC_INSTANCE__ before importing the viewer.');
  }
  try {
    return parsePublicInstanceConfig(candidate);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Tracker public instance configuration is invalid: ${message}`);
  }
}

export const trackerInstanceConfig = loadPublicInstanceConfig();
export const publicInstanceConfig = trackerInstanceConfig;

/** Return the projection used by browser consumers. */
export function getPublicInstanceConfig(): PublicInstanceConfig {
  return trackerInstanceConfig;
}
