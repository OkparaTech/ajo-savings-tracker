const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({
  testDir: './test/browser',
  testMatch: '**/*.spec.js',
  timeout: 30000,
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:8089',
    viewport: { width: 1440, height: 1000 },
    trace: 'retain-on-failure',
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? {
          executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
          args: [
            '--no-sandbox',
            '--disable-dev-shm-usage',
            '--no-zygote',
            '--use-gl=angle',
            '--use-angle=swiftshader',
          ],
        }
      : {},
  },
  webServer: {
    command: 'node test/browser/server.js',
    url: 'http://localhost:8089',
    reuseExistingServer: !process.env.CI,
  },
});
