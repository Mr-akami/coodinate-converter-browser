// proj-data installer (OPFS).
//
// Manifest-driven: fetches /api/proj-data/manifest, then proj.db only.
// Grid files are NOT installed eagerly here — main thread fetches them on
// demand via the proj-api transform path.
//
// Hash verification: proj.db is downloaded to `proj.db.part`, sha256-verified
// against the manifest, then renamed to `proj.db`. If a partial file is left
// over from a previous failed attempt, it is removed at the start.

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

async function installProjData({ manifestUrl, projDbUrlPattern, dirName }) {
  if (!manifestUrl) throw new Error('manifestUrl is required');
  if (!projDbUrlPattern) throw new Error('projDbUrlPattern is required');

  const root = await navigator.storage.getDirectory();
  const dataDir = await root.getDirectoryHandle(dirName || 'proj-data', { create: true });

  // Fetch manifest fresh every install — small (<100KB), short-cache.
  const manifestRes = await fetch(manifestUrl, { redirect: 'follow' });
  if (!manifestRes.ok) {
    throw new Error(`manifest fetch failed: ${manifestRes.status}`);
  }
  const manifest = await manifestRes.json();
  if (!manifest.version || !manifest.projDb || !manifest.grids) {
    throw new Error('manifest missing fields');
  }

  const currentVersion = await readVersion(dataDir);
  if (currentVersion !== manifest.version) {
    // Version drift: drop everything (proj.db + cached grids) so we don't mix
    // old/new grid binaries.
    await clearDirectory(dataDir);
  }

  const projDbVersionedUrl = projDbUrlPattern.replace('{version}', encodeURIComponent(manifest.version));
  await ensureProjDb(dataDir, projDbVersionedUrl, manifest.projDb);

  await writeVersion(dataDir, manifest.version);
  await writeManifestCache(dataDir, manifest);

  postMessage({ type: 'ready', status: 'installed', version: manifest.version, manifest });
}

async function ensureProjDb(dir, url, expected) {
  // Already installed and valid?
  const existing = await readFileBytes(dir, 'proj.db');
  if (existing && existing.length === expected.size) {
    const hex = await sha256Hex(existing);
    if (hex === expected.sha256) return existing;
  }

  // Drop any stale partials so we don't append.
  await removeIfPresent(dir, 'proj.db.part');

  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) {
    throw new Error(`proj.db fetch failed: ${res.status}`);
  }
  const total = Number(res.headers.get('Content-Length') || 0);

  const handle = await dir.getFileHandle('proj.db.part', { create: true });
  const writable = await handle.createWritable();

  let received = 0;
  const reader = res.body.getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value || value.length === 0) continue;
    await writable.write(value);
    received += value.length;
    postMessage({ type: 'progress', stage: 'proj-db', bytes: received, total });
  }
  await writable.close();

  // Verify size + sha256 before moving into place.
  const partFile = await (await dir.getFileHandle('proj.db.part')).getFile();
  if (partFile.size !== expected.size) {
    await dir.removeEntry('proj.db.part');
    throw new Error(`proj.db size mismatch: got ${partFile.size}, expected ${expected.size}`);
  }
  const bytes = new Uint8Array(await partFile.arrayBuffer());
  const hex = await sha256Hex(bytes);
  if (hex !== expected.sha256) {
    await dir.removeEntry('proj.db.part');
    throw new Error(`proj.db sha256 mismatch`);
  }

  // Atomic rename (OPFS lacks `move`, so write the canonical file then drop part).
  await removeIfPresent(dir, 'proj.db');
  const finalHandle = await dir.getFileHandle('proj.db', { create: true });
  const finalWritable = await finalHandle.createWritable();
  await finalWritable.write(bytes);
  await finalWritable.close();
  await dir.removeEntry('proj.db.part');
  return bytes;
}

async function readVersion(dir) {
  return readFileText(dir, 'proj-data.version');
}
async function writeVersion(dir, version) {
  await writeFileText(dir, 'proj-data.version', version);
}
async function writeManifestCache(dir, manifest) {
  await writeFileText(dir, 'proj-data.manifest.json', JSON.stringify(manifest));
}

async function readFileText(dir, name) {
  try {
    const handle = await dir.getFileHandle(name, { create: false });
    const file = await handle.getFile();
    return (await file.text()).trim();
  } catch {
    return null;
  }
}
async function readFileBytes(dir, name) {
  try {
    const handle = await dir.getFileHandle(name, { create: false });
    const file = await handle.getFile();
    return new Uint8Array(await file.arrayBuffer());
  } catch {
    return null;
  }
}
async function writeFileText(dir, name, text) {
  const handle = await dir.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(text);
  await writable.close();
}
async function removeIfPresent(dir, name) {
  try {
    await dir.removeEntry(name);
  } catch {
    // missing is fine
  }
}
async function clearDirectory(dir) {
  for await (const [name] of dir.entries()) {
    try { await dir.removeEntry(name, { recursive: true }); } catch { /* race */ }
  }
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
