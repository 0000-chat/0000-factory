import { expect, test, type Page } from '@playwright/test';

const fixtureId = 'empty-0000';
const browserKeys = {
  theme: `${fixtureId}-fixture-theme`,
  store: `${fixtureId}-fixture-store`,
  edit: `${fixtureId}-fixture-edit-lock`,
  publish: `${fixtureId}-fixture-publish-lock`,
};

async function waitForShell(page: Page) {
  await expect(page.getByRole('complementary', { name: 'Tracker navigation' })).toBeVisible({ timeout: 30_000 });
}

function watchPageErrors(page: Page) {
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  return pageErrors;
}

test('empty synthetic snapshot hydrates the configured shell and data keys', async ({ page }, testInfo) => {
  const pageErrors = watchPageErrors(page);
  await page.addInitScript(({ themeKey }) => {
    localStorage.setItem(themeKey, 'dark');
  }, { themeKey: browserKeys.theme });

  const snapshotResponsePromise = page.waitForResponse(response => {
    try {
      return new URL(response.url()).pathname === '/data.json';
    } catch {
      return false;
    }
  });
  await page.goto('/work');
  const snapshotResponse = await snapshotResponsePromise;
  expect(snapshotResponse.ok()).toBe(true);
  const snapshot = await snapshotResponse.json() as { schemaVersion?: unknown; items?: unknown[]; source?: { commit?: unknown } };
  expect(snapshot.schemaVersion).toBe(4);
  expect(snapshot.items).toEqual([]);
  expect(snapshot.source?.commit).toMatch(/^[0-9a-f]{40}$/);

  await waitForShell(page);
  await expect(page.getByRole('heading', { name: 'Work', exact: true, level: 1 })).toBeVisible();
  await expect(page.getByText('No work matches these filters.', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Synthetic empty-0000 tracker home', exact: true })).toBeVisible();
  await expect(page.locator('.brand-name')).toHaveText('Synthetic empty-0000');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  const storageKeys = await page.evaluate(() => Object.keys(localStorage));
  expect(storageKeys).toContain(browserKeys.theme);
  expect(storageKeys).not.toContain('0000-tracker-theme');
  expect(storageKeys).not.toContain('0000-tracker-viewer');
  expect(storageKeys).not.toContain('0000-tracker-task-edit');
  expect(storageKeys).not.toContain('0000-tracker-task-publish-transaction');
  expect(browserKeys.store).toContain(fixtureId);
  expect(browserKeys.edit).toContain(fixtureId);
  expect(browserKeys.publish).toContain(fixtureId);
  await page.screenshot({ path: testInfo.outputPath('empty-0000.png'), fullPage: true });
  expect(pageErrors).toEqual([]);
});

const emptyTopLevelRoutes = [
  {
    name: 'Today',
    path: '/today',
    check: (page: Page) => page.getByText('Attention first', { exact: true }),
  },
  {
    name: 'Plans',
    path: '/plans',
    check: (page: Page) => page.getByRole('heading', { name: 'No draft plans yet', exact: true }),
  },
  {
    name: 'Team',
    path: '/team',
    check: (page: Page) => page.locator('.team-page-header').getByText('Team', { exact: true }),
  },
  {
    name: 'Reports',
    path: '/reports',
    check: (page: Page) => page.getByRole('heading', { name: 'Reports', exact: true, level: 1 }),
  },
] as const;

for (const route of emptyTopLevelRoutes) {
  test(`empty ${route.name} route hydrates without page errors`, async ({ page }) => {
    const pageErrors = watchPageErrors(page);
    await page.goto(route.path);
    await waitForShell(page);
    await expect(route.check(page)).toBeVisible();
    expect(pageErrors).toEqual([]);
  });
}

test('disabled weekly planning hides navigation, skips the archive request, and redirects direct routes', async ({ page }) => {
  const planningRequests: string[] = [];
  page.on('request', request => {
    const pathname = new URL(request.url()).pathname;
    if (pathname === '/planning/archive.json') planningRequests.push(pathname);
  });

  await page.goto('/work');
  await waitForShell(page);
  await expect(page.getByRole('link', { name: 'Weekly planning', exact: true })).toHaveCount(0);

  await page.goto('/weekly-planning');
  await waitForShell(page);
  await expect(page).toHaveURL(/\/work$/u);
  await expect(page.getByRole('heading', { name: 'Work', exact: true, level: 1 })).toBeVisible();

  await page.goto('/planning/episodes/2026-W42/r1');
  await waitForShell(page);
  await expect(page.getByRole('heading', { name: 'Page not found', exact: true, level: 1 })).toBeVisible();
  expect(planningRequests).toEqual([]);
});
