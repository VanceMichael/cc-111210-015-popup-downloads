import { chromium } from 'playwright';
export async function openBrowser(base) {
  const url = new URL(base);
  if (!['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error('仅允许本地门户');
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined, args: ['--no-sandbox'] });
  const context = await browser.newContext({ acceptDownloads: true, locale: 'zh-CN' });
  const page = await context.newPage();
  try {
    await page.goto(base);
    await page.locator('[data-ready="true"]').waitFor();
    return { browser, context, page, close: () => browser.close() };
  } catch (error) { await browser.close(); throw error; }
}
