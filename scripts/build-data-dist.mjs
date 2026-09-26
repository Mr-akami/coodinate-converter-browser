#!/usr/bin/env node
/*
 * Build the Data Origin: the directory a host application uploads to static
 * storage. There is no application server in production, so everything the
 * library fetches has to exist here as a plain file.
 *
 *   data-dist/manifest.json                     points at the current version
 *   data-dist/v/<version>/manifest.json
 *   data-dist/v/<version>/proj.db
 *   data-dist/v/<version>/grids/<name>
 *
 * The version is the first 16 hex characters of sha256(proj.db), so the same
 * input always produces the same paths and a changed database always produces
 * new ones. Everything under v/<version>/ can therefore be served immutable
 * and cached forever; only the top-level manifest.json needs no-cache.
 *
 * Which grids are included: the names proj.db itself references, intersected
 * with the files actually on disk. Shipping the whole proj-data tree would be
 * about a gigabyte of which most is unreachable from this database.
 *
 * Files are hard-linked when the filesystem allows it and copied otherwise,
 * because the grid set is close to a gigabyte and copying it on every build is
 * a waste.
 *
 * Usage: node scripts/build-data-dist.mjs [--out data-dist] [--data <dir>]
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync,
  rmSync, statSync, writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const args = { out: 'data-dist', data: 'third_party/sc-proj-data/proj' };
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--out') args.out = value;
    else if (flag === '--data') args.data = value;
    else {
      console.error(`unknown argument: ${flag}`);
      process.exit(2);
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const DATA_DIR = resolve(ROOT, args.data);
const OUT_DIR = resolve(ROOT, args.out);
const DB_PATH = join(DATA_DIR, 'proj.db');

if (!existsSync(DB_PATH)) {
  console.error(`proj.db not found at ${DB_PATH}`);
  console.error('Point --data at a proj-data directory, or see the README.');
  process.exit(1);
}

/*
 * A grid is reachable if any of the tables that name grids names it. The
 * alternatives table matters because PROJ often reports the legacy name of a
 * grid whose file on disk carries the modern one.
 */
const SQL_GRID_NAMES = `
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

function queryNames(db, sql) {
  const out = execFileSync('sqlite3', ['-readonly', '-separator', '\n', db, sql], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split('\n').map((line) => line.trim()).filter(Boolean);
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/* Hard links keep a rebuild cheap; a link across devices fails, so copy. */
function place(from, to) {
  rmSync(to, { force: true });
  try {
    linkSync(from, to);
  } catch {
    copyFileSync(from, to);
  }
}

const referenced = queryNames(DB_PATH, SQL_GRID_NAMES);
const onDisk = new Set(
  readdirSync(DATA_DIR).filter((name) => {
    try {
      return statSync(join(DATA_DIR, name)).isFile();
    } catch {
      return false;
    }
  }),
);

const projDbHash = sha256File(DB_PATH);
const version = projDbHash.slice(0, 16);
const versionDir = join(OUT_DIR, 'v', version);
const gridsDir = join(versionDir, 'grids');
mkdirSync(gridsDir, { recursive: true });

const grids = {};
let totalGridBytes = 0;
let missing = 0;

for (const name of referenced) {
  if (name === 'proj.db') continue;
  if (!onDisk.has(name)) {
    missing += 1;
    continue;
  }
  const source = join(DATA_DIR, name);
  const size = statSync(source).size;
  grids[name] = { size, sha256: sha256File(source) };
  totalGridBytes += size;
  place(source, join(gridsDir, name));
}

place(DB_PATH, join(versionDir, 'proj.db'));

const manifest = {
  version,
  generatedAt: new Date().toISOString(),
  projDb: { size: statSync(DB_PATH).size, sha256: projDbHash },
  grids,
};
const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
writeFileSync(join(versionDir, 'manifest.json'), manifestText);
writeFileSync(join(OUT_DIR, 'manifest.json'), manifestText);

const excluded = [...onDisk].filter((n) => n !== 'proj.db' && !grids[n]).length;

console.log(`[data-dist] out:      ${OUT_DIR}`);
console.log(`[data-dist] version:  ${version}`);
console.log(`[data-dist] proj.db:  ${(manifest.projDb.size / 1024 / 1024).toFixed(1)} MB`);
console.log(`[data-dist] grids:    ${Object.keys(grids).length} files, ${(totalGridBytes / 1024 / 1024).toFixed(1)} MB`);
console.log(`[data-dist] db names with no file on disk: ${missing}`);
console.log(`[data-dist] files on disk not referenced:  ${excluded}`);
console.log('');
console.log('Upload the whole directory. Serve v/<version>/ immutable and');
console.log('long-lived, and the top-level manifest.json with no-cache.');
