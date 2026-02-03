const textDecoder = new TextDecoder();

self.onmessage = (event) => {
  const msg = event.data;
  if (!msg || msg.type !== 'install') return;
  installProjData(msg).catch((err) => {
    postMessage({
      type: 'error',
      error: err && err.message ? err.message : String(err),
    });
  });
};

async function installProjData({ url, version, dirName }) {
  if (!url) {
    throw new Error('url is required');
  }
  if (!version) {
    throw new Error('version is required');
  }

  const root = await navigator.storage.getDirectory();
  const dataDir = await root.getDirectoryHandle(dirName || 'proj-data', {
    create: true,
  });

  const currentVersion = await readVersion(dataDir);
  if (currentVersion === version) {
    postMessage({ type: 'ready', status: 'cached', version });
    return;
  }

  await clearDirectory(dataDir);

  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`failed to fetch proj-data: ${response.status}`);
  }

  const total = Number(response.headers.get('Content-Length') || 0);
  const decompressed = response.body.pipeThrough(
    new DecompressionStream('gzip')
  );

  await extractTarToOPFS(decompressed, dataDir, (progress) => {
    postMessage({
      type: 'progress',
      stage: 'extract',
      ...progress,
    });
  }, total);

  await writeVersion(dataDir, version);

  postMessage({ type: 'ready', status: 'installed', version });
}

async function readVersion(dir) {
  try {
    const handle = await dir.getFileHandle('proj-data.version', {
      create: false,
    });
    const file = await handle.getFile();
    return (await file.text()).trim();
  } catch (err) {
    return null;
  }
}

async function writeVersion(dir, version) {
  const handle = await dir.getFileHandle('proj-data.version', {
    create: true,
  });
  const writable = await handle.createWritable();
  await writable.write(version);
  await writable.close();
}

async function clearDirectory(dir) {
  for await (const [name] of dir.entries()) {
    await dir.removeEntry(name, { recursive: true });
  }
}

function readString(buf, start, length) {
  const slice = buf.subarray(start, start + length);
  const str = textDecoder.decode(slice);
  const nul = str.indexOf('\0');
  return (nul >= 0 ? str.slice(0, nul) : str).trim();
}

function isZeroBlock(buf) {
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] !== 0) return false;
  }
  return true;
}

function sanitizePath(path) {
  if (!path) return null;
  const cleaned = path.replace(/^\/+/, '');
  const parts = cleaned.split('/').filter(Boolean);
  if (parts.some((p) => p === '..')) return null;
  return parts.join('/');
}

async function ensureDir(root, path) {
  const parts = path.split('/');
  let dir = root;
  for (const part of parts) {
    dir = await dir.getDirectoryHandle(part, { create: true });
  }
  return dir;
}

async function extractTarToOPFS(stream, dataDir, onProgress, totalCompressed) {
  const reader = stream.getReader();
  let buffer = new Uint8Array(0);
  let done = false;
  let processed = 0;
  let entries = 0;

  async function readChunk() {
    const { value, done: streamDone } = await reader.read();
    if (streamDone) {
      done = true;
      return;
    }
    if (value && value.length) {
      buffer = concat(buffer, value);
      processed += value.length;
      onProgress({ bytes: processed, total: totalCompressed, entries });
    }
  }

  async function ensure(n) {
    while (buffer.length < n && !done) {
      await readChunk();
    }
    return buffer.length >= n;
  }

  async function take(n) {
    if (!(await ensure(n))) {
      throw new Error('unexpected end of tar stream');
    }
    const out = buffer.subarray(0, n);
    buffer = buffer.subarray(n);
    return out;
  }

  async function discard(n) {
    while (n > 0) {
      const chunk = await take(Math.min(n, 64 * 1024));
      n -= chunk.length;
    }
  }

  while (true) {
    if (!(await ensure(512))) {
      break;
    }
    const header = await take(512);
    if (isZeroBlock(header)) {
      break;
    }

    const name = readString(header, 0, 100);
    const prefix = readString(header, 345, 155);
    const sizeStr = readString(header, 124, 12);
    const typeflag = readString(header, 156, 1) || '0';

    const size = parseInt(sizeStr.trim() || '0', 8) || 0;
    const fullName = sanitizePath(prefix ? `${prefix}/${name}` : name);
    if (!fullName) {
      await discard(size + padding(size));
      continue;
    }

    if (typeflag === '5' || fullName.endsWith('/')) {
      await ensureDir(dataDir, fullName.replace(/\/+$/, ''));
      await discard(size + padding(size));
      entries++;
      continue;
    }

    const dirPath = fullName.split('/').slice(0, -1).join('/');
    const baseName = fullName.split('/').pop();
    const parent = dirPath ? await ensureDir(dataDir, dirPath) : dataDir;
    const fileHandle = await parent.getFileHandle(baseName, { create: true });
    const writable = await fileHandle.createWritable();

    let remaining = size;
    while (remaining > 0) {
      const chunk = await take(Math.min(remaining, 64 * 1024));
      await writable.write(chunk);
      remaining -= chunk.length;
    }
    await writable.close();

    await discard(padding(size));
    entries++;
  }
}

function padding(size) {
  const mod = size % 512;
  return mod === 0 ? 0 : 512 - mod;
}

function concat(a, b) {
  if (!a.length) return b;
  if (!b.length) return a;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
