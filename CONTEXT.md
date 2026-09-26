# PROJ in the Browser

Coordinate transformation library that runs PROJ as WebAssembly inside the browser, fetching only the grid files a transformation needs and keeping them locally for offline reuse.

## Language

**Grid**:
A binary correction file (GeoTIFF, NTv2, GTX) that a transformation reads to reach its stated accuracy.
_Avoid_: grid file, resource, asset

**Manifest**:
The list of grids a data origin can serve, with each grid's byte size and SHA-256, keyed by a data version.
_Avoid_: index, catalog

**Data Version**:
The identifier of one published proj.db plus its manifest. Grids from different data versions are never mixed.
_Avoid_: bundle version, release

**Data Origin**:
The static location a host application serves proj.db and grids from. The library only knows its base URL.
_Avoid_: server, CDN, backend

**Operation**:
A concrete transformation path PROJ selects between a source and target CRS for a given point.
_Avoid_: pipeline, transform (as a noun)

**Ballpark Operation**:
An operation PROJ offers when no accurate datum shift exists or its grid is missing; accuracy is unknown and typically metres or worse.
_Avoid_: fallback, Helmert (Helmert is one accurate kind, not a synonym)

**Strict Transform**:
The default transform behaviour: fetch what the best non-ballpark operation needs, and fail with `MissingGridError` rather than return a ballpark result.
_Avoid_: safe mode

**Missing Grid**:
A grid the best operation needs that is neither stored locally nor obtainable from the data origin.
