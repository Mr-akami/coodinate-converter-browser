# Production refactor plan

Agreed design for turning this PoC into a distributable library. Every phase
task refers to this document. Terms in **bold** are defined in `/CONTEXT.md`.

## Target shape

An npm package `@mr-akami/proj-wasm-proj-data` that a host application embeds,
in a browser or on Node. In the browser the host serves **proj.db** and
**grids** as plain static files (S3 or similar) and the library is told only a
base URL; there is no application server in production. On Node the data is
usually already on the machine, so the library reads it straight from the
filesystem.

```ts
const proj = await createProj({ dataBaseUrl, workerUrl?, wasmUrl?, storage? });

await proj.transform(src, dst, x, y, z?, opts?)        // -> { x, y, z }
await proj.transformMany(src, dst, xyz, opts?)         // Float64Array, interleaved
await proj.prepare(src, dst, point?)                   // pre-fetch grids
await proj.describe(src, dst, point?)                  // operation info
proj.dispose()
proj.dataVersion                                       // string
```

- `opts` is `{ allowBallpark?: boolean, signal?: AbortSignal }`.
- Coordinates are always lon,lat / easting,northing — never EPSG authority order.
- `transform` is a **Strict Transform** by default: a **Ballpark Operation** is
  refused with `MissingGridError` unless `allowBallpark: true`.
- `describe()` returns the chosen operation's name, its PROJ accuracy in metres,
  whether it is ballpark, and the grids it needs.
- `worker`, the raw **Manifest**, `_fetchGrid` and `clearPrepareCache` are not
  public. `preloadGrids('all')` moves to an internal testing entry point; it is
  used only by tests and the demo page.

On Node the same surface is reached through a separate entry point:

```ts
const proj = await createProjNode({ dataDir?, inProcess? });
```

## Key decisions

**Node runs the same wasm.** Not for speed — a native binding would win — but
so that a server and a browser agree. Both execute the same module built from
the same PROJ commit against the same **proj.db** and **grids**, so they select
the same operation and return the same numbers. `gdal-async` bundles its own
PROJ and can disagree silently; `proj4js` has no proj.db, no GeoTIFF grids and
no geoid support, so it cannot do the JGD2024, GSIGEO2011 or NTv2 cases at all.
On Node there is no manifest, no download and no OPFS: the data directory comes
from an explicit option, else `PROJ_DATA`, else `PROJ_LIB`, and is mounted with
NODEFS.

**Static Data Origin.** `scripts/build-data-dist.mjs` produces
`data-dist/v/<dataVersion>/{manifest.json,proj.db,grids/*}` plus a top-level
`data-dist/manifest.json` pointing at the current **Data Version**. Hono
survives only as a dev server for the demo and E2E, including the existing
fault-injection routes. The PROJ community CDN cannot be used: our proj.db is
customised (a `CZM` authority with 27 vertical CRS, JPGEO2024 grids) and the CDN
overwrites files in place, which is incompatible with pinned hashes.

**Grids never enter the wasm heap.** Mount them through WORKERFS from OPFS
`File` objects so PROJ reads only the bytes it needs. The previous MEMFS
approach made resident memory grow with every grid ever used, and the largest
single grid is 77 MB. `-lworkerfs.js` is already linked.

**Not Chrome-only.** Chrome, Firefox and Safari. In particular do not use
`FileSystemFileHandle.move()` (Chrome-only). To replace a file atomically, write
under the final name and publish a `<name>.ok` sidecar on success; treat a file
without its sidecar as absent.

**Per-Data-Version OPFS directories.** `proj-data/<dataVersion>/…`. A new
version is fully downloaded into its own directory before it becomes current;
only then is the old one deleted. If the manifest cannot be fetched, start from
the newest complete local version instead of failing. Serve the manifest with
`no-cache`. Guard the version switch with Web Locks so several tabs cannot
race.

**C++17 wrapper over PROJ's C API.** RAII wrappers replace manual
`proj_destroy` chains. Do not use `osgeo::proj` C++ headers: PROJ does not
guarantee their API or ABI.

**TypeScript** for everything shipped to the browser, emitted with type
declarations.

**Worker failure is terminal.** On `error`, `messageerror` or a malformed reply,
reject every pending request with `ProjWorkerError` and mark the instance
disposed; the host recreates it. No fixed timeout — a first grid fetch can
legitimately take a long time — but every call accepts an `AbortSignal`.

## Known defects to fix

- `pw_grids_needed` keeps `const char*` borrowed from a candidate operation in
  its `seen[]` array and compares them after `proj_destroy` — use after free.
- `pw_transform` can never return 5 or 6: it is called with
  `allow_ballpark=1, discard_missing=1`. The JS branches handling those codes
  are dead, and the documented strict behaviour does not exist.
- `preparedGridSets` grows without bound, one entry per 1° cell.
- Startup requires a manifest fetch and cannot run offline, contradicting the
  project's stated goal.
- The C-side operation cache is keyed on (src, dst) only, although operation
  choice depends on the point; a cached regional operation is reused for distant
  points until a transform actually errors.
- `crs_has_vertical()` re-parses CRS strings that the caller already holds.
- `rpc()` has no `error` handler and no way to fail, so a dead worker leaves
  every caller pending forever and the serialising queue stalls permanently.
- Nothing coordinates multiple tabs; two installers can race on the same
  directory.
- `sha256Hex` is defined three times and `rpc` twice.
- Unused surface to delete: `pw_clear_cache`, `pw_cleanup`, refresh strategy 0,
  `resetGridStore`, `clearGrids`, `totalBytes`, `_fetchGrid`,
  the `version_mismatch` reason, `cwrap`/`HEAPU8` exports, and
  `manifest.legacyAliases` (generated but never read).

## Testing

Three layers.

1. **Native wrapper tests.** Build the C++ wrapper for the host with the same
   PROJ submodule commit and run it under AddressSanitizer. Covers axis order,
   operation selection, grid enumeration and lifetime bugs without a browser.
2. **TypeScript unit tests** with vitest: manifest parsing, version generations,
   the RPC layer and error mapping, against an in-memory storage backend.
3. **End-to-end** with Playwright on Chromium, Firefox and WebKit. Regenerate
   `tests/reference.csv` from a `cs2cs` built from the same PROJ commit as the
   wasm build, and record that commit in the file header. The current CSV came
   from PROJ 9.7.0 while the wasm is 9.5.0-568.

## PROJ version is pinned by the data, not by preference

The submodule is pinned to the **9.8.1** tag. It cannot simply track upstream
master: PROJ raised its database layout from 6 to 7 on 2026-04-04 in commit
`36631398`, and every build after that refuses a layout-6 **proj.db** with

```
proj.db contains DATABASE.LAYOUT.VERSION.MINOR = 6 whereas a number >= 7 is expected
```

Our `third_party/sc-proj-data` database is layout 6, built by PROJ 9.7.1, and
is customised downstream by that repository's Python scripts. Moving to a
9.9-era PROJ therefore requires sc-proj-data to regenerate its database against
the newer schema first — it is not a change this repository can make. 9.8.1 is
the newest release that accepts layout 6.

## Build

Drop `-sASYNCIFY` — nothing calls back into JS asynchronously once
`ENABLE_CURL=OFF`, and it costs both speed and size. Use `-fwasm-exceptions`
consistently across PROJ, SQLite, libtiff, zlib and the wrapper. Add `-flto` if
it links cleanly. Trim `EXPORTED_FUNCTIONS` and `EXPORTED_RUNTIME_METHODS` to
what remains in use. Measure before and after with `tests/bench.html`. One
module serves both environments, so `-sENVIRONMENT` must include `node` and
`-lnodefs.js` must be linked alongside `-lworkerfs.js`.

## Cleanup

Delete `tests/.belgium-debug*`, `tests/.la-debug2.html`, `docs/swap.md`,
`docs/proj-cache-invalidation.md`, `docs/plans/selective-proj-data.md`,
`agent.md`, `Todo.md`, `TO_OSS.md` and `scripts/package-proj-data.sh`. Git
history keeps them. Rewrite `README.md`, update `CLAUDE.md`, and write ADRs for
the three decisions that are hard to reverse and surprising without their
rationale: static data origin, WORKERFS, and strict-by-default.
