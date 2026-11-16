import { expect, test, type Page } from '@playwright/test';

const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('connection')).toHaveText('SSE подключён');
});
async function endpoint(page: Page, side: 'белые' | 'чёрные', model = 'legal') {
  await page.getByLabel(`Провайдер · ${side}`, { exact: true }).selectOption('openai-compatible');
  await page.getByLabel(`Base URL · ${side}`, { exact: true }).fill(`http://mock-api:8080/${side === 'белые' ? 'white' : 'black'}/v1`);
  await page.getByLabel(`Ручной ввод Model ID · ${side}`, { exact: true }).check();
  await page.getByLabel(`Модель · ${side}`, { exact: true }).fill(model);
}
async function apply(page: Page) {
  const saved = page.waitForResponse(response => response.url().endsWith('/api/matches') && response.request().method() === 'POST' && response.ok());
  await button(page, 'Применить настройки').click();
  await saved;
  await expect(page.getByTestId('connection')).toHaveText('SSE подключён');
}

test('two independent compatible endpoints play through Vite, REST and SSE with metrics and player prompts', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await endpoint(page, 'белые', 'correct-on-retry');
  await endpoint(page, 'чёрные');
  await page.getByLabel('Temperature · белые', { exact: true }).fill('0');
  await page.getByLabel('Лимит токенов · белые', { exact: true }).fill('128');
  await page.getByLabel('Параметр лимита · белые', { exact: true }).selectOption('max_completion_tokens');
  await page.getByLabel('Формат API · белые', { exact: true }).selectOption('json_object');
  await button(page, 'Проверить модель · белые').click();
  await expect(page.getByRole('status', { name: 'Проверка · белые', exact: true })).toContainText('Модель доступна');
  await page.getByText('Промпт · белые', { exact: true }).click();
  await page.getByLabel('Системный промпт · белые', { exact: true }).fill('White private instruction: {{color}} {{fen}} {{history}}');
  await page.getByText('Промпт · чёрные', { exact: true }).click();
  await button(page, 'Стандартный промпт · чёрные').click();
  await page.getByLabel('Максимум полуходов', { exact: true }).fill('4');
  await page.getByLabel('Режим игры', { exact: true }).selectOption('step');
  await apply(page);
  await button(page, 'Start').click();
  await expect(page.getByTestId('ply-count')).toHaveText('1');
  await expect(page.getByRole('log')).toContainText('исправлено моделью после повтора');
  for (let ply = 2; ply <= 4; ply++) {
    await expect(button(page, 'Next Move')).toBeEnabled();
    await button(page, 'Next Move').click();
    await expect(page.getByTestId('ply-count')).toHaveText(String(ply));
  }
  const id = await page.evaluate(() => sessionStorage.getItem('arena-match'));
  const snapshot = await (await page.request.get(`/api/matches/${id}`)).json();
  expect(snapshot.result.kind).toBe('Limit');
  expect(snapshot.providerChecks).toHaveLength(2);
  expect(snapshot.attempts).toHaveLength(6);
  expect(snapshot.attempts.every((attempt: { metrics: { totalTokens: number } }) => attempt.metrics.totalTokens === 108)).toBe(true);
  const black = snapshot.attempts.find((attempt: { color: string }) => attempt.color === 'black');
  expect(JSON.stringify(black.request)).not.toContain('White private');
  expect(JSON.stringify(snapshot.attempts.map((attempt: { request: unknown }) => attempt.request))).not.toContain('legalMoves');
  await page.setViewportSize({ width: 360, height: 960 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(errors).toEqual([]);
  await page.screenshot({ path: '/artifacts/e2e/compatible-mobile.png', fullPage: true });
});

test('connection errors are shown and Mock can play against a compatible endpoint', async ({ page }) => {
  await endpoint(page, 'белые', 'rate-limit');
  await button(page, 'Проверить модель · белые').click();
  await expect(page.getByRole('status', { name: 'Проверка · белые', exact: true })).toContainText('HTTP 429');
  await page.getByLabel('Модель · белые', { exact: true }).fill('legal');
  await apply(page);
  await button(page, 'Next Move').click();
  await expect(page.getByTestId('ply-count')).toHaveText('1');
  await button(page, 'Next Move').click();
  await expect(page.getByTestId('ply-count')).toHaveText('2');
});

test('runtime templates keep model IDs editable and show reported context and OOM through the proxy', async ({ page }) => {
  await endpoint(page, 'белые');
  const presets = page.getByLabel('Подключение · белые', { exact: true });
  const baseUrl = page.getByLabel('Base URL · белые', { exact: true });
  for (const [id, address] of [
    ['nvidia', 'http://vllm:8000/v1'], ['metal', 'http://host.docker.internal:8000/v1'],
    ['dmr', 'http://model-runner.docker.internal/engines/v1'], ['ollama', 'http://host.docker.internal:11434/v1'],
    ['external', ''], ['cloud', ''],
  ] as const) {
    await presets.selectOption(id);
    await expect(baseUrl).toHaveValue(address);
    await expect(page.getByLabel('Модель · белые', { exact: true })).toHaveValue('legal');
  }
  await baseUrl.fill('http://mock-api:8080/white/v1');
  await button(page, 'Проверить модель · белые').click();
  const diagnostics = page.getByLabel('Диагностика · белые', { exact: true });
  await expect(diagnostics).toContainText('Контекст сервера: 4096');
  await expect(diagnostics).toContainText('Модель в ответе: legal');
  await page.getByLabel('Модель · белые', { exact: true }).fill('oom');
  await button(page, 'Проверить модель · белые').click();
  await expect(diagnostics).toContainText('Runtime сообщил о нехватке памяти');
  await expect(page.locator('body')).not.toContainText('PRIVATE runtime data');
  await page.getByLabel('Модель · белые', { exact: true }).fill('legal');
  await apply(page);
  await button(page, 'Next Move').click();
  await expect(page.getByTestId('ply-count')).toHaveText('1');
  const id = await page.evaluate(() => sessionStorage.getItem('arena-match'));
  const snapshot = await (await page.request.get(`/api/matches/${id}`)).json();
  expect(snapshot.providerChecks[0].result.diagnostics.reportedMaxContextTokens).toBe(4096);
});

test('Reset cancels a compatible HTTP request and discards its late reply', async ({ page }) => {
  await endpoint(page, 'белые', 'delay');
  await apply(page);
  await button(page, 'Next Move').click();
  await expect(page.getByRole('status', { name: 'Состояние партии' })).toContainText('Ожидание ответа');
  await button(page, 'Reset').click();
  await expect(page.getByTestId('ply-count')).toHaveText('0');
  await expect(button(page, 'Start')).toBeEnabled();
  await page.waitForTimeout(1700);
  await expect(page.getByTestId('ply-count')).toHaveText('0');
  await expect(page.getByRole('log')).not.toContainText('Ход выполнен');
});
