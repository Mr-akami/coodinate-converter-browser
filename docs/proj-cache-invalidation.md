# PROJ cache invalidation when adding grids to MEMFS at runtime

## Question

When a wasm app writes a new grid file to MEMFS *after* `pw_init` has already
run, will subsequent `proj_create_operations` / `proj_coordoperation_is_instantiable`
calls actually see the new file? Or is grid availability cached somewhere?

## Findings (PROJ 9.x)

`proj_grid_cache_clear(ctx)` is **not sufficient on its own**. It only clears the
network grid-chunk cache (`gNetworkChunkCache.clearDiskChunkCache(ctx)` in
`networkfilemanager.cpp:2482`). Grid *availability* is cached separately in
`DatabaseContext::Private::cacheGridInfo_` (`factory.cpp:3436,3552`) — when
PROJ has decided once that grid `X` is unavailable, that decision is reused
until the database context is recreated.

The two extra layers of state we need to drop:

1. The wrapper's own `g_op` (cached coordinate operation). If a transform
   already failed because of the missing grid, the cached pipeline reflects
   that and won't be re-resolved. Fixed by *always* destroying the cached op
   in `pw_refresh_after_grid_write`.
2. The PROJ `PJ_CONTEXT` itself — including the database context attached to
   it. Fixed by recreating the context with the same search path and database
   path.

## Conclusion

`pw_refresh_after_grid_write(strategy=1)` recreates the entire `PJ_CONTEXT`,
which is the only reliable way to make newly-mounted grids visible. The cost
is minor (sub-millisecond plus reopening the SQLite DB handle); we eat it
once per batch of grid writes, not per transform.

`strategy=0` is left in place as a debug knob (network chunk cache clear
only). It's not used by the runtime because empirical testing confirmed it
is insufficient on its own.

## Verification

Reproduced end-to-end with Belgium 31370→4326:

1. Start the wasm runtime with `proj.db` only — Belgium grid not on disk.
2. `pw_strict_check` returns 0 (best non-ballpark op not instantiable).
3. Fetch and write `be_ign_bd72lb72_etrs89lb08.tif` to MEMFS.
4. Call `pw_refresh_after_grid_write(1)`.
5. `pw_strict_check` returns 1.
6. `pw_transform` produces NTv2-precision result (0 m roundtrip error).

If step 4 is skipped or replaced with `proj_grid_cache_clear` only, step 5
still returns 0.
