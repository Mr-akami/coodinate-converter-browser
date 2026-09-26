# 2. Mount grids through WORKERFS rather than copying them into the wasm heap

Date: 2026-09-11

## Status

Accepted

## Context

Grids were fetched on the main thread, written to OPFS, transferred into the
worker and written into MEMFS, which is wasm linear memory. Every grid ever
used stayed there for the life of the page.

The largest single grid in our set is 77 MB. wasm32 addresses at most 4 GB and
Chrome allows rather less in practice, and growing the heap copies it, so
resident memory briefly doubles. A session that transforms across several
countries could reach that ceiling. The bytes were also copied at least three
times before PROJ ever read them.

PROJ opens a grid and reads headers and tiles; a single transform touches a few
kilobytes of a file that may be tens of megabytes.

## Decision

The worker owns OPFS and mounts each grid's `File` through WORKERFS, which
reads only the blocks PROJ asks for. Grid bytes never enter the wasm heap and
never cross a thread boundary. `proj.db` stays in MEMFS: it is 9 MB and SQLite
reads it constantly.

## Consequences

Resident memory no longer grows with the size of the grids used, so a 77 MB
grid costs approximately nothing in wasm memory. A grid is fetched, hashed and
stored in one pass in the worker, removing two copies.

Startup no longer mounts everything already cached, so it no longer costs time
proportional to the total size of grids ever used.

WORKERFS is read-only and synchronous, which suits PROJ and rules out writing
through the same path; anything that writes goes to OPFS directly.
