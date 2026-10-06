/**
 * Authored projection for unbundled browser unit tests.
 *
 * This is deliberately synthetic: it carries no Access policy, audience,
 * credential, or production repository identity. Each test process gets one
 * stable namespace so LiveStore, preferences, and browser locks cannot use a
 * production fallback.
 */

const projection = Object.freeze({
  schemaVersion: 1,
  id: 'synthetic',
  branding: Object.freeze({
    name: 'Synthetic Tracker',
    title: 'Synthetic tracker',
    description: 'Synthetic tracker browser test',
    markText: 'SYN',
    homeLabel: 'Synthetic tracker home',
    loadingLabel: 'Loading synthetic tracker data…',
    faviconPath: 'assets/favicon.svg',
  }),
  source: Object.freeze({
    owner: 'synthetic-org',
    repo: 'synthetic-tracker',
    branch: 'main',
    folderPath: 'tracker-data',
  }),
  browser: Object.freeze({
    namespace: 'synthetic',
    storeId: 'synthetic-tracker-viewer',
    themeKey: 'synthetic-tracker-theme',
    editLockPrefix: 'synthetic-tracker-task-edit',
    publishLockName: 'synthetic-tracker-task-publish-transaction',
    unscheduledCollapsedKey: 'synthetic.viewer.unscheduledCollapsed',
    activityPausedKey: 'synthetic.workActivity.animationsPaused',
  }),
  publishing: Object.freeze({ kind: 'disabled' }),
});

globalThis.__TRACKER_PUBLIC_INSTANCE__ = projection;

export { projection as browserInstanceProjection };
