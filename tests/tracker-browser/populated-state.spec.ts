import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const itemId = 'fixture-foundation-task';

function projectId() {
  return test.info().project.name;
}

function projectMeta(id: string) {
  const metadataPath = process.env.TRACKER_BROWSER_PROJECTS_FILE;
  if (!metadataPath) throw new Error('TRACKER_BROWSER_PROJECTS_FILE was not propagated by the fixture server');
  const projects = JSON.parse(readFileSync(resolve(metadataPath), 'utf8')) as Array<{ id: string; dataRepo: string; settingsPath: string; runRoot: string }>;
  const project = projects.find(candidate => candidate.id === id);
  if (!project) throw new Error(`fixture metadata missing for ${id}`);
  return { ...project, root: resolve(project.runRoot) };
}

function isolatedGitEnvironment() {
  const devNull = process.platform === 'win32' ? 'NUL' : '/dev/null';
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')),
  );
  return {
    ...environment,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_SYSTEM: devNull,
    GIT_CONFIG_GLOBAL: devNull,
    GIT_TERMINAL_PROMPT: '0',
  };
}

async function waitForShell(page: Page) {
  await expect(page.getByRole('complementary', { name: 'Tracker navigation' })).toBeVisible({ timeout: 30_000 });
}

function watchPageErrors(page: Page) {
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  return pageErrors;
}

async function openRoute(page: Page, path: string) {
  await page.goto(path);
  await waitForShell(page);
}

async function readSnapshot(page: Page) {
  const response = await page.request.get('/data.json');
  expect(response.ok()).toBe(true);
  return await response.json() as { items?: unknown[]; source?: { commit?: string } };
}

async function editTitle(page: Page, title: string) {
  await expect(page.getByRole('button', { name: 'Edit title', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Edit title', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Edit title', exact: true });
  await expect(input).toBeVisible();
  await input.fill(title);
  await input.press('Control+Enter');
  await expect(page.getByRole('heading', { name: title, exact: true, level: 1 })).toBeVisible();
}

test('populated synthetic routes show work, plans, reports, and team data', async ({ page }) => {
  const pageErrors = watchPageErrors(page);
  const id = projectId();
  await openRoute(page, '/work');
  const snapshot = await readSnapshot(page);
  expect(snapshot.items).toHaveLength(94);
  expect(snapshot.source?.commit).toMatch(/^[0-9a-f]{40}$/);
  const foundation = snapshot.items?.find((item) => (item as { id?: string }).id === itemId) as { referenceCode?: string } | undefined;
  expect(foundation?.referenceCode).toMatch(/^T-[A-Z0-9]{6}$/);

  await expect(page.getByRole('heading', { name: 'Work', exact: true, level: 1 })).toBeVisible();
  await expect(page.getByText('Synthetic foundation task', { exact: true })).toBeVisible();

  await openRoute(page, '/today');
  await expect(page.getByText('Attention first', { exact: true })).toBeVisible();

  await openRoute(page, '/plans');
  await expect(page.getByRole('heading', { name: 'Plans', exact: true, level: 2 })).toBeVisible();
  await expect(page.locator('#selected-plan-brief').getByText('Synthetic fixture plan', { exact: true })).toBeVisible();

  await openRoute(page, '/reports');
  await expect(page.getByRole('heading', { name: 'Reports', exact: true, level: 1 })).toBeVisible();

  await openRoute(page, '/team');
  await expect(page.locator('.team-page-header').getByText('Team', { exact: true })).toBeVisible();
  await expect(page.getByText('Fixture Don', { exact: true }).first()).toBeVisible();

  await page.getByTestId('team-row-fixture-don').click();
  await expect(page.getByRole('heading', { name: 'Fixture Don', exact: true, level: 1 })).toBeVisible();
  const sourceCommit = snapshot.source?.commit;
  if (!sourceCommit) throw new Error('fixture snapshot did not provide a source commit');
  const folderPrefix = id === 'populated-nested' ? 'tooling/project-tracker/' : '';
  const sourceHref = await page.locator('a.team-source-link').first().getAttribute('href');
  expect(sourceHref).toBe(`https://github.com/fixture-${id}/tracker-${id}/blob/${sourceCommit}/${folderPrefix}tracker/updates/fixture-foundation-task/initial-observation.md`);
  expect(pageErrors).toEqual([]);
});

test('Gantt keeps schedule controls compact and opens row investigation', async ({ page }) => {
  const pageErrors = watchPageErrors(page);
  await openRoute(page, '/work');

  await expect(page.getByText('Work activity timeline', { exact: true })).toBeVisible();
  const activityToggle = page.getByRole('button', { name: 'Hide recorded activity', exact: true });
  await expect(activityToggle).toBeVisible();
  await expect(activityToggle).toHaveAttribute('aria-pressed', 'true');
  await activityToggle.click();
  const showActivityToggle = page.getByRole('button', { name: 'Show recorded activity', exact: true });
  await expect(showActivityToggle).toHaveAttribute('aria-pressed', 'false');
  await showActivityToggle.click();
  await expect(page.getByRole('button', { name: 'Hide recorded activity', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Show forecast', exact: true })).toBeVisible();

  const row = page.getByRole('button', { name: /Open details for Synthetic foundation task/ }).first();
  await expect(row).toBeVisible();
  const snapshot = await readSnapshot(page);
  const referenceCode = (snapshot.items?.find((item) => (item as { id?: string }).id === itemId) as { referenceCode?: string } | undefined)?.referenceCode;
  expect(referenceCode).toMatch(/^T-[A-Z0-9]{6}$/);
  await expect(row).toContainText(referenceCode!);
  await row.click();

  const investigation = page.getByTestId('work-gantt-investigation');
  await expect(investigation).toBeVisible();
  await expect(investigation.getByRole('heading', { name: /Synthetic foundation task/, level: 2 })).toBeVisible();
  await expect(investigation).toContainText(referenceCode!);
  await expect(investigation.getByText('Approved schedule', { exact: true })).toBeVisible();
  await expect(investigation.getByRole('button', { name: 'Open full details', exact: true })).toBeVisible();
  await investigation.getByRole('button', { name: 'Close work item investigation', exact: true }).click();
  await expect(investigation).toBeHidden();
  await openRoute(page, '/work?mode=kanban');
  const kanbanTask = page.locator('.kanban-task').filter({ hasText: 'Synthetic foundation task' }).first();
  await expect(kanbanTask).toBeVisible();
  await expect(kanbanTask).toContainText(referenceCode!);
  expect(pageErrors).toEqual([]);
});

test('synthetic signed-in identity marks only its exact assigned owner', async ({ page }) => {
  await page.route('**/api/me', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ schemaVersion: 1, actor: { kind: 'human', personId: ' fixture-don ' } }),
  }));
  await openRoute(page, '/work?mode=table');

  await expect(page.getByTestId('viewer-identity')).toContainText('Fixture Don');
  const assignedRow = page.locator('.work-table-wrap tr').filter({ hasText: 'Synthetic foundation task' });
  await expect(assignedRow.getByTestId('assigned-to-you')).toHaveCount(1);
  await expect(assignedRow.getByRole('link')).toHaveAttribute('aria-label', /Assigned to you/);
});

test('local title drafts survive a reload and field locks coordinate two tabs', async ({ page }) => {
  const id = projectId();
  await openRoute(page, `/work/${itemId}`);
  const editedTitle = `Fixture browser edit ${id}`;
  await editTitle(page, editedTitle);
  await page.reload();
  await waitForShell(page);
  await expect(page.getByRole('heading', { name: editedTitle, exact: true, level: 1 })).toBeVisible();

  const secondPage = await page.context().newPage();
  try {
    await openRoute(secondPage, `/work/${itemId}`);
    await expect(secondPage.getByRole('button', { name: 'Edit title', exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Edit title', exact: true }).click();
    const firstInput = page.getByRole('textbox', { name: 'Edit title', exact: true });
    await expect(firstInput).toBeVisible();
    await expect.poll(async () => page.evaluate(async () => {
      const locks = (navigator as Navigator & { locks?: LockManager }).locks;
      const snapshot = locks ? await locks.query() : null;
      return snapshot?.held?.map(lock => lock.name) ?? [];
    })).toContain(`${id}-fixture-edit-lock:field:${itemId}:title`);

    await secondPage.getByRole('button', { name: 'Edit title', exact: true }).click();
    await expect(secondPage.locator('#task-title-edit-message')).toContainText('This field is being edited in another tab.');
    await expect.poll(async () => secondPage.evaluate(async () => {
      const locks = (navigator as Navigator & { locks?: LockManager }).locks;
      const snapshot = locks ? await locks.query() : null;
      return snapshot?.held?.map(lock => lock.name) ?? [];
    })).toContain(`${id}-fixture-edit-lock:field:${itemId}:title`);
    await firstInput.press('Escape');
  } finally {
    await secondPage.close();
  }
});

test('a synthetic data edit rebuilds and the browser converges on the new source commit', async ({ page }) => {
  const id = projectId();
  const meta = projectMeta(id);
  await openRoute(page, '/work');
  const before = await readSnapshot(page);
  const teamPath = join(meta.dataRepo, id === 'populated-nested' ? 'tooling/project-tracker/team.md' : 'team.md');
  appendFileSync(teamPath, `\n<!-- synthetic browser refresh ${Date.now()} -->\n`);
  execFileSync('git', ['-C', meta.dataRepo, 'add', '.'], { env: isolatedGitEnvironment(), stdio: 'ignore' });
  execFileSync('git', ['-C', meta.dataRepo, 'commit', '--quiet', '-m', 'synthetic browser refresh'], { env: isolatedGitEnvironment(), stdio: 'ignore' });
  await expect.poll(async () => (await readSnapshot(page)).source?.commit, { timeout: 60_000, intervals: [500, 1000, 2000] }).not.toBe(before.source?.commit);
  const after = await readSnapshot(page);
  expect(after.source?.commit).toMatch(/^[0-9a-f]{40}$/);
  await page.reload();
  await waitForShell(page);
  await expect(page.getByRole('heading', { name: 'Work', exact: true, level: 1 })).toBeVisible();
});

test('disabled publishing keeps the local draft and makes no API request', async ({ page }) => {
  test.skip(test.info().project.name !== 'populated-nested', 'the root fixture exercises the enabled publish lock');
  await openRoute(page, `/work/${itemId}`);
  const editedTitle = 'Fixture disabled publish draft';
  await editTitle(page, editedTitle);
  const apiRequests: string[] = [];
  page.on('request', request => {
    if (new URL(request.url()).pathname.startsWith('/api/')) apiRequests.push(new URL(request.url()).pathname);
  });
  await expect(page.getByRole('button', { name: 'Review changes', exact: true })).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Review changes', exact: true }).click();
  await expect(page.getByRole('status', { name: 'Task draft publishing' })).toContainText('Couldn’t prepare your review. Your changes are saved.');
  await page.getByRole('button', { name: 'Details', exact: true }).click();
  await expect(page.getByRole('status', { name: 'Task draft publishing' })).toContainText('Publishing is unavailable for this tracker. Local drafts remain saved on this device.');
  expect(apiRequests).toEqual([]);
  await page.reload();
  await waitForShell(page);
  await expect(page.getByRole('heading', { name: editedTitle, exact: true, level: 1 })).toBeVisible();
});
