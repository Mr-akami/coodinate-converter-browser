# @mr-akami/proj-wasm-proj-data

PROJ, compiled to WebAssembly, for coordinate transformation in the browser and
on Node. It fetches only the grid files a transformation actually needs, keeps
them locally, and works offline after the first load.

It refuses to guess. When the accurate transformation between two coordinate
reference systems needs a grid that cannot be obtained, you get an error rather
than a number that may be tens of metres out.

## What you provide

The package ships code. It does not ship data: PROJ's grid collection is close
to a gigabyte, some of it under licences that are not ours to redistribute, and
which parts you need depends entirely on where you work.

You serve `proj.db` and the grids yourself, as plain static files. There is no
server component.

```bash
node scripts/build-data-dist.mjs --data /path/to/proj-data --out data-dist
```

That writes a directory to upload as-is:

```
data-dist/manifest.json                  the current version
data-dist/v/<version>/manifest.json
data-dist/v/<version>/proj.db
data-dist/v/<version>/grids/<name>
```

The version is derived from the hash of `proj.db`, so a given version's files
can never change. Serve everything under `v/<version>/` immutable and
long-lived, and the top-level `manifest.json` with `no-cache`.

The PROJ community CDN at cdn.proj.org cannot stand in for this. It has no
`proj.db`, and it replaces files in place, which pinned hashes cannot tolerate.

## Use

```js
import { createProj, MissingGridError } from '@mr-akami/proj-wasm-proj-data';

const proj = await createProj({ dataBaseUrl: 'https://example.com/proj-data' });

const point = await proj.transform('EPSG:4326', 'EPSG:6677', 139.7671, 35.6812);
// { x: -5995.185, y: -35367.230, z: 0 }
```

Coordinates are always longitude, latitude or easting, northing, in both
directions, whatever axis order the EPSG registry declares for the CRS.

| Call | Purpose |
| --- | --- |
| `transform(src, dst, x, y, z?, opts?)` | One point. |
| `transformMany(src, dst, xyz, opts?)` | A `Float64Array` of interleaved x,y,z in one round trip. The array you pass is transferred and detached. |
| `prepare(src, dst, point?, opts?)` | Fetch the grids a later transform will need. |
| `describe(src, dst, point?, opts?)` | The operation PROJ would use, its stated accuracy, whether it is a ballpark, and the grids it needs. |
| `listCrs(lon, lat, opts?)` | The coordinate systems usable at that point, most local first. |
| `dispose()` | Shut the worker down. |
| `dataVersion` | The Data Version in use. |

`opts` is `{ allowBallpark?: boolean, signal?: AbortSignal }`.

The package is TypeScript, built with Vite and published with declarations.

### Letting a user choose a coordinate system

`listCrs` answers what applies where the user is working, which is the hard
part of presenting a choice: the database holds ten thousand projected systems
and perhaps a dozen are relevant.

```js
const options = await proj.listCrs(139.7671, 35.6812, { authorities: ['EPSG'] });
// [{ id: 'EPSG:6677', name: 'JGD2011 / Japan Plane Rectangular CS IX',
//    type: 'projected', areaName: 'Japan - onshore - Honshu ...',
//    areaSquareDegrees: 10.46 }, ...]
```

Only systems whose declared area of use contains the point are returned,
deprecated ones never are, and the order is smallest area first, because at any
populated point both a world-wide system and a local one apply and the local
one is nearly always what was meant. `kinds` selects the families — horizontal
unless switched off, `vertical` and `threeDimensional` on request — and
`authorities` narrows by authority.

### Refusing versus approximating

By default a transform that cannot be done accurately throws
`MissingGridError`, carrying `reason` and the grids that were missing.

```js
try {
  await proj.transform('EPSG:4301', 'EPSG:6668', 139.7671, 35.6812);
} catch (err) {
  if (err instanceof MissingGridError) {
    // err.reason is 'missing_grid', 'ballpark_only', 'fetch_failed' or 'hash_mismatch'
  }
}
```

Passing `allowBallpark: true` gives you what `cs2cs` does instead: PROJ falls
back to a datum-shift-free approximation. That is a reasonable choice when you
know the error is tolerable, and a bad one by default, because nothing in the
returned coordinate tells you it happened. Ask `describe()` first if you want to
decide per CRS pair.

## Node

```js
import { createProjNode } from '@mr-akami/proj-wasm-proj-data/node';

const proj = await createProjNode();          // reads PROJ_DATA, else PROJ_LIB
const proj = await createProjNode({ dataDir: '/srv/proj-data' });
```

The same wasm module, the same `proj.db`, the same grids, so a server and a
browser return the same numbers. Nothing is downloaded: the directory is
mounted and PROJ reads it in place. It runs in a worker thread so a server's
event loop is not blocked; pass `inProcess: true` for scripts.

Use `transformMany` for bulk work. Measured on 200,000 points between
EPSG:4326 and EPSG:6677 on one machine:

| Path | Time |
| --- | --- |
| `transformMany`, one call | 40 ms |
| `cs2cs` 9.7.1, same points piped through one process | 224 ms |
| `transform`, one call per point | about 7.6 s |

The per-point cost inside the module is a fraction of a microsecond; what a
caller pays for is the message round trip, so make few of them.

## Browser support

Chrome, Firefox and Safari. The library needs the Origin Private File System
with synchronous access handles, WebAssembly exception handling, and Web Locks,
all of which those three have had for some years.

The end-to-end suite runs on Chromium and Firefox here and passes identically
on both. WebKit is not exercised in this repository's environment, which lacks
a system library Playwright's WebKit build needs; nothing in the code is
Chromium-specific, and `FileSystemFileHandle.move()` in particular is avoided
because only Chrome has it, but Safari support is reasoned rather than
measured.

Grids are mounted from OPFS rather than read into memory, so resident memory
does not grow with the size of the grids you use.

## Development

Requires Nix for the WebAssembly toolchain.

```bash
nix develop                       # emscripten, cmake, ninja, node
git submodule update --init --recursive

./scripts/build-proj-wasm.sh      # build the wasm module
npm run build:data                # build a Data Origin from third_party/sc-proj-data
npm run dev                       # dev server on :3000, serving the demo
```

```bash
npm run test:native               # C++ wrapper under AddressSanitizer
npm run test:unit                 # TypeScript units
npm run test:browser              # end-to-end, Chromium by default
BROWSER=firefox npm run test:browser
npm run test:browser:all          # every engine the machine can launch
npm run typecheck
```

The PROJ submodule is pinned to the tag that generated the database in use, and
that pin is not free to move; `docs/refactor-plan.md` explains why.

## Licence

MIT for this package. PROJ and the grid data carry their own licences, and the
grids in particular are a mix — check the ones you redistribute.
