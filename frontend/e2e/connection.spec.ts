import { expect, test } from '@playwright/test';

test('the browser connects to the real backend through Vite', async ({ page }) => {
  const responsePromise = page.waitForResponse(response => response.url().endsWith('/api/health') && response.ok());
  await page.goto('/');
  const response = await responsePromise;
  expect(await response.json()).toEqual({ status: 'ok', service: 'backend' });
  await expect(page.getByRole('status')).toHaveText('Backend подключён');
  await page.getByRole('button', { name: 'Проверить снова' }).click();
  await expect(page.getByRole('status')).toHaveText('Backend подключён');
});

test('the browser can recover after an API error', async ({ page }) => {
  await page.route('**/api/health', route => route.fulfill({ status: 503, body: '' }));
  await page.goto('/');
  await expect(page.getByRole('status')).toHaveText('Backend недоступен');
  await page.unroute('**/api/health');
  await page.getByRole('button', { name: 'Проверить снова' }).click();
  await expect(page.getByRole('status')).toHaveText('Backend подключён');
});
