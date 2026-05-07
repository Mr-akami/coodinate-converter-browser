/*
 * OPFS grid store. Caches downloaded grid files in OPFS so repeat visits
 * don't re-fetch them from the server.
 *
 * Layout: navigator.storage.getDirectory() / <dirName>/grids/<filename>
 *
 * Hash verification is the caller's responsibility before write — these
 * helpers only do byte-level read/write/list.
 */

async function getGridsDir(dirName = 'proj-data') {
  // Re-resolve every call. The proj-data installer may recursively delete
  // the parent directory on a version drift, so any cached handle would
  // dangle and produce NotFoundError on subsequent writes.
  const root = await navigator.storage.getDirectory();
  const dataDir = await root.getDirectoryHandle(dirName, { create: true });
  return await dataDir.getDirectoryHandle('grids', { create: true });
}

export function resetGridStore() {
  /* no-op kept for API compatibility. */
}

export async function readGrid(name, dirName = 'proj-data') {
  try {
    const dir = await getGridsDir(dirName);
    const handle = await dir.getFileHandle(name, { create: false });
    const file = await handle.getFile();
    return new Uint8Array(await file.arrayBuffer());
  } catch {
    return null;
  }
}

export async function writeGrid(name, bytes, dirName = 'proj-data') {
  const dir = await getGridsDir(dirName);
  // Write to a `.part` sibling first so a crash mid-write can't leave a
  // half-truncated file masquerading as a verified grid.
  const partName = `${name}.part`;
  const partHandle = await dir.getFileHandle(partName, { create: true });
  const writable = await partHandle.createWritable();
  await writable.write(bytes);
  await writable.close();
  try {
    await dir.removeEntry(name);
  } catch {
    /* may not exist */
  }
  // OPFS doesn't have rename, so we re-create the canonical name and copy.
  const finalHandle = await dir.getFileHandle(name, { create: true });
  const finalWritable = await finalHandle.createWritable();
  await finalWritable.write(bytes);
  await finalWritable.close();
  try {
    await dir.removeEntry(partName);
  } catch {
    /* ignore */
  }
}

export async function listGrids(dirName = 'proj-data') {
  try {
    const dir = await getGridsDir(dirName);
    const names = [];
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind !== 'file') continue;
      if (name.endsWith('.part')) continue;
      names.push(name);
    }
    return names;
  } catch {
    return [];
  }
}

export async function clearGrids(dirName = 'proj-data') {
  try {
    const dir = await getGridsDir(dirName);
    for await (const [name] of dir.entries()) {
      try { await dir.removeEntry(name, { recursive: true }); } catch { /* race */ }
    }
  } catch {
    /* ignore */
  }
}

export async function totalBytes(dirName = 'proj-data') {
  try {
    const dir = await getGridsDir(dirName);
    let total = 0;
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind !== 'file') continue;
      if (name.endsWith('.part')) continue;
      const file = await handle.getFile();
      total += file.size;
    }
    return total;
  } catch {
    return 0;
  }
}
