// Optional read-only smoke check against the already running local vLLM.
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ baseURL: process.env.E2E_BASE_URL ?? 'http://frontend:5173' });
  await page.goto(process.env.E2E_BASE_URL ?? 'http://frontend:5173');
  await expect(page.getByTestId('connection')).toHaveText('SSE подключён');
  await page.getByLabel('Провайдер · белые', { exact: true }).selectOption('openai-compatible');
  await page.getByLabel('Подключение · белые', { exact: true }).selectOption('nvidia');
  const response = await page.request.post('/api/providers/models', { data: { baseUrl: 'http://vllm:8000/v1', discoveryApi: 'vllm' } });
  assert(response.ok(), `Discovery HTTP ${response.status()}`);
  const result = await response.json();
  assert(result.models.length > 0);
  const id = result.models[0].id;
  const picker = page.getByLabel('Модель · белые', { exact: true });
  await expect(picker.getByRole('option', { name: `${id} · Доступна через API`, exact: true })).toBeAttached();
  await picker.selectOption(id);
  await page.getByRole('button', { name: 'Refresh · белые', exact: true }).click();
  await expect(picker.getByRole('option', { name: `${id} · Доступна через API`, exact: true })).toBeAttached();
  await expect(picker).toHaveValue(id);
  await page.getByRole('button', { name: 'Применить настройки', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Next Move', exact: true })).toBeEnabled();
  const matchId = await page.evaluate(() => sessionStorage.getItem('arena-match'));
  const saved = await (await page.request.get(`/api/matches/${matchId}`)).json();
  assert.equal(saved.config.players.white.modelId, id);
  assert.equal(saved.providerChecks.length, 0, 'Listing/apply must not trigger completion');
  await expect(page.getByRole('status', { name: 'Список моделей · белые', exact: true })).toContainText('Доступна через API');
  await page.screenshot({ path: '/artifacts/e2e/real-vllm-model-discovery.png', fullPage: true });
  console.log(JSON.stringify({ realVllm: true, listedModels: result.models, selectedIdPersisted: true, completionRequests: 0 }));
} finally { await browser.close(); }
