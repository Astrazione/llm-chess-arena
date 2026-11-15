import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  outputDir: '/tmp/llm-chess-e2e',
  workers: 1,
  reporter: 'list',
  use: { baseURL: process.env.E2E_BASE_URL ?? 'http://frontend:5173', headless: true },
});
