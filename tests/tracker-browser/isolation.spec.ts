import { expect, test } from '@playwright/test';

const itemId = 'fixture-foundation-task';

async function waitForShell(page: import('@playwright/test').Page) {
  await expect(page.getByRole('complementary', { name: 'Tracker navigation' })).toBeVisible({ timeout: 30_000 });
}

test('each synthetic project consumes its configured theme, store namespace, and legacy-free keys', async ({ page }) => {
  const id = test.info().project.name;
  const storeId = `${id}-fixture-store`;
  const themeKey = `${id}-fixture-theme`;
  await page.addInitScript(({ key }) => {
    localStorage.setItem(key, 'dark');
  }, { key: themeKey });
  await page.goto('/work');
  await waitForShell(page);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  const storageKeys = await page.evaluate(() => Object.keys(localStorage));
  expect(storageKeys).toContain(themeKey);
  expect(storageKeys).not.toContain('0000-tracker-theme');
  expect(storageKeys).not.toContain('0000-tracker-viewer');
  expect(storageKeys).not.toContain('0000-tracker-task-edit');
  expect(storageKeys).not.toContain('0000-tracker-task-publish-transaction');

  const opfsNames = await page.evaluate(async () => {
    if (typeof navigator.storage?.getDirectory !== 'function') return [];
    const names: string[] = [];
    const visit = async (directory: FileSystemDirectoryHandle, prefix = ''): Promise<void> => {
      for await (const [name, handle] of directory.entries()) {
        const current = `${prefix}${name}`;
        names.push(current);
        if (handle.kind === 'directory') await visit(handle, `${current}/`);
      }
    };
    await visit(await navigator.storage.getDirectory());
    return names;
  });
  expect(opfsNames.some(name => name.includes(storeId))).toBe(true);
});

test('enabled synthetic publishing holds the configured publish lock while checking', async ({ page }) => {
  test.skip(test.info().project.name !== 'populated-root', 'only the root fixture enables synthetic publishing');
  const id = test.info().project.name;
  await page.goto(`/work/${itemId}`);
  await waitForShell(page);
  await page.getByRole('button', { name: 'Edit title', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Edit title', exact: true });
  await expect(input).toBeVisible();
  await input.fill('Fixture publish lock draft');
  await input.press('Control+Enter');
  await expect(page.getByRole('button', { name: 'Review changes', exact: true })).toBeVisible({ timeout: 20_000 });

  let releasePrepare: () => void = () => {};
  const prepareGate = new Promise<void>(resolve => { releasePrepare = resolve; });
  let finishPrepareRoute: () => void = () => {};
  const prepareRouteFinished = new Promise<void>(resolve => { finishPrepareRoute = resolve; });
  let routeHandled = false;
  await page.route('**/api/publish/prepare', async route => {
    try {
      await prepareGate;
      if (!routeHandled) {
        routeHandled = true;
        await route.abort();
      }
    } catch {
      // The browser can close an intercepted request while the test is ending.
    } finally {
      finishPrepareRoute();
    }
  });
  const requestPromise = page.waitForRequest(request => new URL(request.url()).pathname === '/api/publish/prepare');
  await page.getByRole('button', { name: 'Review changes', exact: true }).click();
  await requestPromise;
  await expect.poll(async () => page.evaluate(async () => {
    const locks = (navigator as Navigator & { locks?: LockManager }).locks;
    const snapshot = locks ? await locks.query() : null;
    return snapshot?.held?.map(lock => lock.name) ?? [];
  })).toContain(`${id}-fixture-publish-lock`);
  releasePrepare();
  await prepareRouteFinished;
  await page.unroute('**/api/publish/prepare');
});
