#!/usr/bin/env node
// Build server/manifest.json from third_party/sc-proj-data/proj/.
//
// Allow-list source: union of grid names referenced by proj.db tables
//   - grid_alternatives.{proj_grid_name, original_grid_name, old_proj_grid_name}
//   - grid_transformation.grid_name
//   - other_transformation.grid_name
// Intersected with actual files on disk.
//
// Manifest version is sha256(proj.db) first 16 hex chars — reproducible.
// generatedAt is informational only (not used for cache keying).
//
// Run: node scripts/build-manifest.mjs

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, statSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '..');
const DATA_DIR = resolve(ROOT, 'third_party/sc-proj-data/proj');
const DB_PATH = join(DATA_DIR, 'proj.db');
const OUT_PATH = resolve(ROOT, 'server/manifest.json');

if (!existsSync(DB_PATH)) {
  console.error(`proj.db not found at ${DB_PATH}`);
  process.exit(1);
}

console.log(`[manifest] data dir: ${DATA_DIR}`);
console.log(`[manifest] db: ${DB_PATH}`);

const SQL_NAMES = `
SELECT name FROM (
  SELECT proj_grid_name AS name FROM grid_alternatives
  UNION SELECT original_grid_name FROM grid_alternatives
  UNION SELECT old_proj_grid_name FROM grid_alternatives WHERE old_proj_grid_name IS NOT NULL
  UNION SELECT grid_name FROM grid_transformation WHERE grid_name IS NOT NULL
  UNION SELECT grid_name FROM other_transformation WHERE grid_name IS NOT NULL
)
WHERE name IS NOT NULL AND name != ''
ORDER BY name
`;

// Extracts (legacy_name → modern_name) and (deprecated_name → modern_name)
// pairs so the client can resolve PROJ-reported grid identifiers (which are
// often the legacy NTv2/.gsb/.gtx names) back to the actual on-disk filename
// in our manifest.
const SQL_ALIASES = `
SELECT original_grid_name, proj_grid_name FROM grid_alternatives
WHERE original_grid_name != proj_grid_name
UNION
SELECT old_proj_grid_name, proj_grid_name FROM grid_alternatives
WHERE old_proj_grid_name IS NOT NULL AND old_proj_grid_name != proj_grid_name
`;

function querySqlite(db, sql, separator = '|') {
  const out = execFileSync('sqlite3', ['-readonly', `-separator`, separator, db, sql], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

const dbNames = querySqlite(DB_PATH, SQL_NAMES, '\n');
console.log(`[manifest] db references: ${dbNames.length} grid names`);

const aliasRows = querySqlite(DB_PATH, SQL_ALIASES, '|');
const legacyAliases = {};
for (const row of aliasRows) {
  const [legacy, modern] = row.split('|');
  if (!legacy || !modern || legacy === modern) continue;
  legacyAliases[legacy] = modern;
}
console.log(`[manifest] legacy aliases:  ${Object.keys(legacyAliases).length}`);

const onDisk = new Set(readdirSync(DATA_DIR).filter((n) => {
  const p = join(DATA_DIR, n);
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}));
console.log(`[manifest] files on disk: ${onDisk.size}`);

function sha256File(path) {
  const h = createHash('sha256');
  h.update(readFileSync(path));
  return h.digest('hex');
}

const projDbStat = statSync(DB_PATH);
const projDbHash = sha256File(DB_PATH);

const grids = {};
const missingFromDisk = [];
let totalGridBytes = 0;

for (const name of dbNames) {
  if (name === 'proj.db') continue;
  if (!onDisk.has(name)) {
    missingFromDisk.push(name);
    continue;
  }
  const p = join(DATA_DIR, name);
  const s = statSync(p);
  if (!s.isFile()) continue;
  grids[name] = {
    size: s.size,
    sha256: sha256File(p),
  };
  totalGridBytes += s.size;
}

const allowListedFiles = new Set(Object.keys(grids));
const onDiskNotInAllowList = [...onDisk].filter(
  (n) => n !== 'proj.db' && !allowListedFiles.has(n)
).sort();

// Filter aliases to only those whose modern target is actually in the
// manifest — clients only need the resolvable subset.
const filteredAliases = {};
for (const [legacy, modern] of Object.entries(legacyAliases)) {
  if (grids[modern]) filteredAliases[legacy] = modern;
}

const manifest = {
  version: projDbHash.slice(0, 16),
  generatedAt: new Date().toISOString(),
  projDb: {
    size: projDbStat.size,
    sha256: projDbHash,
  },
  grids,
  legacyAliases: filteredAliases,
};

mkdirSync(dirname(OUT_PATH), { recursive: true });
writeFileSync(OUT_PATH, JSON.stringify(manifest, null, 2) + '\n');

console.log(`[manifest] version: ${manifest.version}`);
console.log(`[manifest] proj.db: ${(projDbStat.size / 1024 / 1024).toFixed(1)} MB`);
console.log(`[manifest] grids:   ${Object.keys(grids).length} files, ${(totalGridBytes / 1024 / 1024).toFixed(1)} MB total`);
console.log(`[manifest] db refs missing on disk:    ${missingFromDisk.length}`);
console.log(`[manifest] files on disk not in allow: ${onDiskNotInAllowList.length}`);
if (process.env.VERBOSE) {
  if (missingFromDisk.length) {
    console.log('[manifest] missing:', missingFromDisk.slice(0, 20).join(', '),
      missingFromDisk.length > 20 ? `...(+${missingFromDisk.length - 20})` : '');
  }
  if (onDiskNotInAllowList.length) {
    console.log('[manifest] excluded:', onDiskNotInAllowList.slice(0, 20).join(', '),
      onDiskNotInAllowList.length > 20 ? `...(+${onDiskNotInAllowList.length - 20})` : '');
  }
}
console.log(`[manifest] wrote ${OUT_PATH}`);
