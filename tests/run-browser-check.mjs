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

function waitForServerReady(server) {
  return new Promise((resolveReady, rejectReady) => {
    const timeout = setTimeout(() => {
      rejectReady(new Error('Timed out waiting for http.server'));
    }, 10000);

    server.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      if (text.includes('Serving HTTP on')) {
        clearTimeout(timeout);
        resolveReady();
      }
    });

    server.on('error', (err) => {
      clearTimeout(timeout);
      rejectReady(err);
    });

    server.on('exit', (code) => {
      if (code !== 0) {
        clearTimeout(timeout);
        rejectReady(new Error(`http.server exited with code ${code}`));
      }
    });
  });
}

async function run() {
  const server = spawn('python3', ['-m', 'http.server', String(serverPort)], {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await waitForServerReady(server);

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
