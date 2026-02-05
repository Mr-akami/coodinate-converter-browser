import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { chromium } from 'playwright';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const serverPort = 8765;
const serverUrl = `http://127.0.0.1:${serverPort}/tests/comparison.html`;

async function waitForServerReady() {
  const maxAttempts = 20;
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, 500));
    try {
      const res = await fetch(`http://127.0.0.1:${serverPort}/`, { method: 'HEAD' });
      if (res.ok || res.status === 200 || res.status === 404) {
        console.log(`Server listening on port ${serverPort}`);
        return;
      }
    } catch {
      // Server not ready yet
    }
  }
  throw new Error('Timed out waiting for http.server');
}

async function run() {
  const server = spawn('python3', ['-m', 'http.server', String(serverPort)], {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await waitForServerReady();

    const userDataDir = resolve(repoRoot, '.playwright');
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: true,
      args: ['--no-sandbox'],
    });

    const page = await context.newPage();
    await page.goto(serverUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => {
      const status = document.getElementById('status');
      const text = status?.textContent || '';
      return text.startsWith('Done.') && text.includes('passed');
    }, { timeout: 180000 });

    const statusText = (await page.textContent('#status') || '').trim();
    console.log(`Summary: ${statusText}`);

    const match = statusText.match(/Done\.\s+(\d+)\/(\d+)\s+passed/);
    if (!match) {
      throw new Error(`Unexpected summary: ${statusText}`);
    }

    const passed = Number(match[1]);
    const total = Number(match[2]);
    if (Number.isNaN(passed) || Number.isNaN(total)) {
      throw new Error(`Unable to parse summary: ${statusText}`);
    }

    if (passed !== total) {
      const failures = await page.$$eval('tr.fail, tr.error', (rows) =>
        rows.map((row) => row.textContent.replace(/\s+/g, ' ').trim())
      );
      console.error('Failures:');
      failures.forEach((line) => console.error(`- ${line}`));
      throw new Error(`Browser comparison failed: ${statusText}`);
    }

    await context.close();
  } finally {
    server.kill('SIGTERM');
    try {
      await once(server, 'exit');
    } catch {
      // Ignore shutdown errors.
    }
  }
}

run().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exit(1);
});
