import { defineConfig } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const configuredPort = Number(process.env.TRACKER_BROWSER_PORT ?? 4187);
const port = Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort < 65532 ? configuredPort : 4187;
const repositoryRoot = resolve('.');
const fixtureServer = resolve('tests/tracker-browser/fixture-server.mjs');
const outputDir = resolve(process.env.TRACKER_PLAYWRIGHT_OUTPUT ?? 'test-results');
const fixtureParent = resolve(process.env.TRACKER_BROWSER_FIXTURE_ROOT ?? process.env.TMPDIR ?? tmpdir());
const projectsFile = resolve(process.env.TRACKER_BROWSER_PROJECTS_FILE ?? join(fixtureParent, `tracker-browser-projects-${process.pid}-${randomUUID()}.json`));
process.env.TRACKER_BROWSER_PROJECTS_FILE = projectsFile;

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export default defineConfig({
  testDir: resolve('tests/tracker-browser'),
  outputDir,
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: 'list',
  use: {
    browserName: 'chromium',
    viewport: { width: 1100, height: 900 },
    trace: 'retain-on-failure',
    serviceWorkers: 'allow',
  },
  projects: [
    {
      name: 'empty-0000',
      testMatch: /empty-state\.spec\.ts/,
      use: { baseURL: `http://127.0.0.1:${port + 1}` },
    },
    {
      name: 'populated-root',
      testMatch: /(?:populated-state|isolation)\.spec\.ts/,
      use: { baseURL: `http://127.0.0.1:${port + 2}` },
    },
    {
      name: 'populated-nested',
      testMatch: /(?:populated-state|isolation)\.spec\.ts/,
      use: { baseURL: `http://127.0.0.1:${port + 3}` },
    },
  ],
  webServer: {
    command: `exec bun ${shellQuote(fixtureServer)} --base-port ${port} --projects-file ${shellQuote(projectsFile)}`,
    cwd: repositoryRoot,
    url: `http://127.0.0.1:${port}/__health`,
    reuseExistingServer: false,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 },
    timeout: 180_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
