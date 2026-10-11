import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { chromium } from '@playwright/test';

const populatedURL = process.env.TEAM_POPULATED_URL ?? 'http://127.0.0.1:4311';
const emptyURL = process.env.TEAM_EMPTY_URL ?? 'http://127.0.0.1:4312';
const screenshotDir = process.env.TEAM_SCREENSHOT_DIR ?? '/tmp/team-ui-browser-run/screenshots';
mkdirSync(screenshotDir, { recursive: true });

async function shell(page) {
  await page.getByRole('complementary', { name: 'Tracker navigation' }).waitFor({ state: 'visible', timeout: 30_000 });
}

async function preparePage(page) {
  if (process.env.TEAM_BROWSER_FALLBACK !== '1') return;
  await page.addInitScript(() => {
    Object.defineProperty(globalThis, 'SharedWorker', { configurable: true, value: undefined });
    if (globalThis.navigator?.storage) Object.defineProperty(globalThis.navigator.storage, 'getDirectory', { configurable: true, value: undefined });
  });
}

async function checkNoErrors(page, errors, label) {
  assert.deepEqual(errors, [], `${label} page errors: ${errors.join('; ')}`);
}

async function populated(browser) {
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  await preparePage(page);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));

  await page.goto(`${populatedURL}/work?mode=table`);
  await shell(page);
  await page.getByRole('heading', { name: 'Work', exact: true, level: 1 }).waitFor();
  await page.getByText('Public alpha task', { exact: true }).waitFor();
  for (const name of ['Today', 'Plans', 'Reports']) assert.equal(await page.getByRole('link', { name, exact: true }).count(), 0, `${name} should be hidden`);
  assert.equal(await page.getByRole('button', { name: 'Manager work presets', exact: true }).count(), 0, 'manager controls should be hidden');
  assert.equal(await page.getByRole('button', { name: 'Global search', exact: true }).count(), 0, 'private command search should be hidden');
  await page.screenshot({ path: `${screenshotDir}/team-work.png`, fullPage: true });

  const personFilter = page.getByRole('combobox', { name: 'Person-scoped My Work', exact: true });
  await personFilter.click();
  await page.getByRole('listbox', { name: 'Suggestions' }).getByText('person-alpha', { exact: true }).click();
  await page.getByText('Public alpha task', { exact: true }).waitFor();
  assert.equal(await page.getByText('Public beta task', { exact: true }).count(), 0, 'person filter should scope visible work');
  await page.screenshot({ path: `${screenshotDir}/team-my-work-person-id.png`, fullPage: true });

  await page.goto(`${populatedURL}/work/public-task-alpha`);
  await shell(page);
  await page.getByRole('heading', { name: 'Public alpha task', exact: true, level: 1 }).waitFor();
  await page.getByText('reviewer-id', { exact: true }).waitFor();
  await page.getByText('Oct 5, 2026', { exact: true }).waitFor();
  await page.getByText('Oct 1, 2026', { exact: true }).waitFor();
  await page.getByText('Public dependency summary.', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Edit title', exact: true }).count(), 0, 'edit title should be absent');
  assert.equal(await page.locator('[data-editable-field]').count(), 0, 'editable detail sections should be absent');
  assert.equal(await page.getByText('Review changes', { exact: true }).count(), 0, 'publish review should be absent');
  await page.screenshot({ path: `${screenshotDir}/team-task-readonly.png`, fullPage: true });

  for (const path of ['/plans', '/reports', '/today', '/decisions/private-decision', '/work?preset=needs-me']) {
    await page.goto(`${populatedURL}${path}`);
    await shell(page);
    await page.getByRole('heading', { name: 'Work', exact: true, level: 1 }).waitFor();
    assert.match(page.url(), /\/work(?:\?|$)/, `${path} should redirect to Work`);
  }

  await page.goto(`${populatedURL}/weekly-planning`);
  await shell(page);
  await page.getByRole('heading', { name: 'Weekly planning', exact: true, level: 1 }).waitFor();
  await page.getByText('Archive only', { exact: true }).waitFor();
  await page.getByRole('heading', { name: 'Team work for 2026-W41', exact: true, level: 2 }).waitFor();
  await page.getByText('Shared snapshot', { exact: true }).first().waitFor();
  await page.frameLocator('iframe[title="Weekly planning presentation for 2026-W41 r1"]').getByRole('heading', { name: 'Team work for 2026-W41 · r1', exact: true, level: 1 }).waitFor();
  await page.screenshot({ path: `${screenshotDir}/team-weekly-planning.png`, fullPage: true });
  await checkNoErrors(page, errors, 'populated');
  await page.close();
}

async function empty(browser) {
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  await preparePage(page);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${emptyURL}/work`);
  await shell(page);
  await page.getByRole('heading', { name: 'No shared work is available yet.', exact: true }).waitFor();
  await page.goto(`${emptyURL}/team`);
  await shell(page);
  await page.getByText('No team members are shared yet.', { exact: true }).waitFor();
  await page.screenshot({ path: `${screenshotDir}/team-empty.png`, fullPage: true });
  await checkNoErrors(page, errors, 'empty');
  await page.close();
}

const browserOptions = {
  headless: true,
  ...(process.env.TEAM_BROWSER_EXECUTABLE ? { executablePath: process.env.TEAM_BROWSER_EXECUTABLE } : {}),
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-background-networking', '--disable-component-update', '--disable-default-apps', '--disable-sync', '--disk-cache-size=1', '--media-cache-size=1'],
};
const browser = process.env.TEAM_BROWSER_PROFILE
  ? await chromium.launchPersistentContext(process.env.TEAM_BROWSER_PROFILE, browserOptions)
  : await chromium.launch(browserOptions);
try {
  await populated(browser);
  await empty(browser);
  console.log(JSON.stringify({ ok: true, screenshots: screenshotDir }));
} finally {
  await browser.close();
}
