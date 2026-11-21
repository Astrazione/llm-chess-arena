import { chromium } from '@playwright/test';
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.goto(process.env.E2E_BASE_URL ?? 'http://frontend:5173');
  await page.getByTestId('connection').filter({ hasText: 'SSE подключён' }).waitFor();
  for (const [width, height] of [[1366, 768], [1920, 1080]]) {
    await page.setViewportSize({ width, height });
    await page.screenshot({ path: `/artifacts/e2e/ui-${process.argv[2] ?? 'current'}-${width}x${height}.png`, fullPage: true });
  }
} finally { await browser.close(); }
