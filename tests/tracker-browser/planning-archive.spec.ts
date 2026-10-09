import { expect, test } from '@playwright/test';

test('weekly planning gallery marks draft and approved revisions and sandboxes saved HTML', async ({ page }) => {
  await page.goto('/weekly-planning');
  await expect(page.getByRole('heading', { name: 'Weekly planning', exact: true, level: 1 })).toBeVisible();
  await expect(page.getByText('Current draft', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Latest approved', { exact: true })).toBeVisible();
  const archive = await page.request.get('/planning/archive.json');
  expect(archive.ok()).toBe(true);
  const frame = page.locator('iframe.weekly-planning-frame');
  await expect(frame).toHaveAttribute('sandbox', '');
  await expect(frame).toHaveAttribute('referrerpolicy', 'no-referrer');
  await expect(frame).toHaveAttribute('srcdoc', /Content-Security-Policy/);
  await expect(frame.contentFrame().getByRole('heading', { name: 'Synthetic current draft presentation' })).toBeVisible();
  await expect(page.getByText(/Synthetic foundation outcome.*Review synthetic evidence/)).toBeVisible();
  await expect(page.getByText(/Confirm synthetic weekly priority/)).toBeVisible();
  await page.getByRole('button', { name: /2026-W42.*r1/ }).click();
  await expect(frame.contentFrame().getByRole('heading', { name: 'Synthetic approved presentation' })).toBeVisible();
});
