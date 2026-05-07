import { chromium } from 'playwright';
const ctx = await chromium.launchPersistentContext('/tmp/.playwright-be-debug', {
  headless: true, args: ['--no-sandbox'],
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
await page.goto('http://localhost:3000/tests/.belgium-debug.html', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => /DONE|FATAL/.test(document.getElementById('log').textContent), { timeout: 60000 });
console.log(await page.textContent('#log'));
console.log('errors:', errors.slice(0, 5));
await ctx.close();
