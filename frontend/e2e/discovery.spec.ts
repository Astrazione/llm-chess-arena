import { openSettings } from './ui-helpers';
import { expect, test } from '@playwright/test';

test('Ollama and vLLM selections persist independently through refresh, apply, archive and preflight', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('connection')).toHaveText('SSE подключён');
  for (const [side, path, api] of [['белые', 'white', 'ollama'], ['чёрные', 'black', 'vllm']] as const) {
    await openSettings(page, side);
    await page.getByLabel(`Провайдер · ${side}`, { exact: true }).selectOption('openai-compatible');
    await openSettings(page, side);
    await page.getByLabel(`Base URL · ${side}`, { exact: true }).fill(`http://mock-api:8080/${path}/v1`);
    await openSettings(page, side);
    await page.getByLabel(`API списка моделей · ${side}`, { exact: true }).selectOption(api);
    await expect(page.getByLabel(`Модель · ${side}`, { exact: true }).getByRole('option', { name: /legal/ })).toBeAttached();
    await openSettings(page, side);
    await page.getByLabel(`Модель · ${side}`, { exact: true }).selectOption('legal');
  }
  await openSettings(page, 'Белые');
  await expect(page.getByRole('status', { name: 'Список моделей · белые', exact: true })).toContainText('В памяти · 7B · Q4_K_M');
  await openSettings(page, 'Белые');
  await page.getByLabel('Модель · белые', { exact: true }).selectOption('downloaded');
  await expect(page.getByLabel('Модель · чёрные', { exact: true })).toHaveValue('legal');
  await page.getByRole('button', { name: 'Refresh · белые', exact: true }).click();
  await openSettings(page, 'Белые');
  await expect(page.getByRole('status', { name: 'Список моделей · белые', exact: true })).toContainText('Скачана · не загружена');
  await expect(page.getByLabel('Модель · белые', { exact: true })).toHaveValue('downloaded');
  await openSettings(page, 'Белые');
  await page.getByLabel('Модель · белые', { exact: true }).selectOption('legal');
  await openSettings(page, 'Белые');
  await page.getByLabel('Ручной ввод Model ID · белые', { exact: true }).check();
  await expect(page.getByLabel('Модель · белые', { exact: true })).toHaveValue('legal');
  await openSettings(page, 'Белые');
  await page.getByLabel('Ручной ввод Model ID · белые', { exact: true }).uncheck();
  await page.getByRole('button', { name: 'Применить настройки', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Next Move', exact: true })).toBeEnabled();
  const id = await page.evaluate(() => sessionStorage.getItem('arena-match'));
  const saved = await (await page.request.get(`/api/matches/${id}`)).json();
  expect(saved.config.players.white.modelId).toBe('legal');
  expect(saved.config.players.black.modelId).toBe('legal');
  expect(saved.config.players.white.discoveryApi).toBe('ollama');
  await page.getByRole('button', { name: 'Next Move', exact: true }).click();
  await expect(page.getByTestId('ply-count')).toHaveText('1');
  const played = await (await page.request.get(`/api/matches/${id}`)).json();
  expect(played.providerChecks).toHaveLength(2);
  const archive = await (await page.request.get(`/api/experiments/${saved.gameId}/export.json`)).json();
  expect(archive.snapshot.config.players).toEqual(saved.config.players);
  await page.screenshot({ path: '/artifacts/e2e/model-discovery.png', fullPage: true });
});

test('empty lists, malformed API responses and connection errors preserve manual IDs', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('connection')).toHaveText('SSE подключён');
  await openSettings(page, 'Белые');
  await page.getByLabel('Провайдер · белые', { exact: true }).selectOption('openai-compatible');
  await openSettings(page, 'Белые');
  await page.getByLabel('API списка моделей · белые', { exact: true }).selectOption('vllm');
  await openSettings(page, 'Белые');
  await page.getByLabel('Ручной ввод Model ID · белые', { exact: true }).check();
  await openSettings(page, 'Белые');
  await page.getByLabel('Модель · белые', { exact: true }).fill('keep:exact');
  const status = page.getByRole('status', { name: 'Список моделей · белые', exact: true });
  for (const [url, message] of [
    ['http://mock-api:8080/empty/v1', 'Модели не найдены'],
    ['http://mock-api:8080/broken/v1', 'некорректный список'],
    ['http://mock-api:8081/v1', 'Не удалось подключиться'],
  ]) {
    await openSettings(page, 'Белые');
    await page.getByLabel('Base URL · белые', { exact: true }).fill(url!);
    await expect(status).toContainText(message!, { timeout: 12000 });
    await expect(page.getByLabel('Модель · белые', { exact: true })).toHaveValue('keep:exact');
  }
  await openSettings(page, 'Белые');
  await page.getByLabel('Ручной ввод Model ID · белые', { exact: true }).uncheck();
  await expect(page.getByLabel('Модель · белые', { exact: true })).toHaveValue('keep:exact');
  expect((await page.request.get('/api/health')).ok()).toBe(true);
});
