import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { chromium } from 'playwright';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
// Must differ from run-browser-check.mjs so both runners can coexist.
const serverPort = 8766;
const serverUrl = `http://127.0.0.1:${serverPort}/tests/bench.html`;

async function waitForServerReady() {
  const maxAttempts = 30;
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, 500));
    try {
      const res = await fetch(`http://127.0.0.1:${serverPort}/api/proj-data/manifest`, { redirect: 'manual' });
      // 302 redirect or 200 both indicate the server is ready.
      if (res.status === 200 || res.status === 302) {
        console.log(`Hono server ready on port ${serverPort}`);
        return;
      }
    } catch {
      // Server not ready yet
    }
  }
  throw new Error('Timed out waiting for Hono server');
}

async function run() {
  // Start the Hono server. Manifest must already exist; the server bails if not.
  const server = spawn('node', ['--import', 'tsx', 'server/index.ts'], {
    cwd: repoRoot,
    env: { ...process.env, PORT: String(serverPort) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (b) => process.stdout.write(`[server] ${b}`));
  server.stderr.on('data', (b) => process.stderr.write(`[server] ${b}`));

  try {
    await waitForServerReady();

    const userDataDir = resolve(repoRoot, '.playwright');
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: true,
      args: ['--no-sandbox'],
    });

    const page = await context.newPage();
    await page.goto(serverUrl, { waitUntil: 'domcontentloaded' });
    // 5 cases x 2000 transforms after grid download, so allow a long run.
    // The second positional argument is the page-function argument, so the
    // options object must come third or the default 30s timeout applies.
    await page.waitForFunction(() => {
      const text = document.getElementById('out')?.textContent || '';
      return text.startsWith('BENCH_JSON=') || text.startsWith('BENCH_ERROR=');
    }, null, { timeout: 600000 });

    const outText = (await page.textContent('#out') || '').trim();

    if (outText.startsWith('BENCH_ERROR=')) {
      throw new Error(`Bench page failed: ${outText.slice('BENCH_ERROR='.length)}`);
    }

    const prefix = 'BENCH_JSON=';
    if (!outText.startsWith(prefix)) {
      throw new Error(`Unexpected bench output: ${outText}`);
    }

    const bench = JSON.parse(outText.slice(prefix.length));
    console.log(JSON.stringify(bench, null, 2));

    await context.close();
  } finally {
    server.kill('SIGTERM');
    try {
      await Promise.race([
        once(server, 'exit'),
        new Promise((r) => setTimeout(r, 5000)),
      ]);
    } catch {
      // Ignore shutdown errors.
    }
  }
}

run().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exit(1);
});
