# 1. Serve proj-data as static files, not from an application server

Date: 2026-09-11

## Status

Accepted

## Context

The prototype served `proj.db` and the grids from a Hono server that read them
off disk, checked each request against a manifest, and returned 410 for a
retired version. Everything it served was immutable and addressed by a hash.

Hosting a process has a cost that never goes away: something has to run it,
watch it, patch it and scale it, for every application that embeds this
library. The alternative is that the host application uploads a directory
somewhere and tells us the URL.

We also looked at the PROJ community CDN at cdn.proj.org, which would remove
the hosting question entirely.

## Decision

The library fetches from a plain static location. `scripts/build-data-dist.mjs`
produces the directory to upload. Hono survives only as a development server
for the demo and the test suite, including the fault injection the suite needs.

The CDN cannot be used. It carries no `proj.db`, and ours is customised — a
`CZM` authority with 27 vertical CRS and JPGEO2024 grids that upstream does not
have. It also replaces files in place, which is incompatible with pinning a
hash per version.

## Consequences

There is no server component in production, and nothing to operate.

Versioning has to be carried by the paths instead of by server logic. The Data
Version is the first 16 characters of sha256(proj.db), so a version's files can
never change and can be served immutable and cached forever; only the pointer
at the current version needs `no-cache`. A retired version is simply a path
that no longer exists, and the client falls back to its local copy rather than
seeing a 410.

The host application takes on deciding which grids to ship and under what
licence terms, which was always theirs to decide and is now explicit.
