#ifndef PROJ_WASM_H
#define PROJ_WASM_H

#ifdef __cplusplus
extern "C" {
#endif

/*
 * pw_init: create the PROJ context and point it at data_dir (search paths and
 * data_dir/proj.db). Returns 0 on success, 1 if the context cannot be created.
 * Calling it again once a context exists is a no-op.
 */
int pw_init(const char* data_dir);

/*
 * pw_grids_needed: enumerate the grid files required between src and dst CRS
 * as a JSON array of {shortName, fullName, packageName, url, available}.
 *
 * x, y: input in JS axis order (lon,lat). Pass NaN to skip coordinate-based
 *       suggestion.
 * discard_missing: 0 enumerates the grids of the operation strict mode wants
 *       at the point (unmounted grids carry their file name as fullName);
 *       1 enumerates the union over the top non-ballpark candidates.
 *
 * Returns a heap string the caller frees with free(), or NULL on failure.
 * *out_status is 0 on success, or:
 *   -1  null argument or allocation failure
 *   -2  CRS resolution failed
 *   -3  no non-ballpark operation exists
 */
char* pw_grids_needed(const char* src, const char* dst, double x, double y,
                      int discard_missing, int* out_status);

/*
 * pw_strict_check: 1 when the operation strict mode wants for (src,dst) at
 * the given coordinate can run with the mounted grids, 0 when it cannot (see
 * pw_last_missing), negative on error.
 *
 * x, y: JS axis order (lon,lat). Pass NaN to skip coordinate-based selection.
 */
int pw_strict_check(const char* src, const char* dst, double x, double y);

/*
 * pw_set_grid_catalog: tell strict mode which grids can be fetched. names is a
 * newline-separated list of grid file names (Manifest keys); an empty
 * placeholder for each is created in dir, which must lie outside data_dir.
 * Strict mode then wants the operation PROJ would pick with all of them on
 * disk, and reports the ones not mounted yet. Without a catalog every grid in
 * the database counts. Returns 0 on success, negative on error.
 */
int pw_set_grid_catalog(const char* dir, const char* names);

/*
 * pw_last_missing: JSON {x, y, grids: [file names]} for the last strict
 * refusal with code 5: the point (JS axis order, null without one) and the
 * grids its operation needs that are not mounted. Owned by the library.
 */
const char* pw_last_missing(void);

/*
 * pw_refresh_after_grid_write: drop the cached operation and recreate the PROJ
 * context so grid files written since pw_init become visible. Call once after
 * each batch of writes. Returns 0 on success, negative on error.
 */
int pw_refresh_after_grid_write(void);

/*
 * pw_transform: transform (x,y,z) from src CRS to dst CRS in place.
 * x, y are in JS axis order (lon,lat) on both sides.
 *
 * allow_ballpark: 1 picks the best operation that can run with the grids
 *   currently on disk, including a ballpark operation. 0 (strict) requires the
 *   best non-ballpark operation and refuses to substitute another one.
 *
 * Return codes (kept stable for JS error mapping):
 *   0  success
 *   2  null pointer arg
 *   3  CRS resolution / op create failed
 *   4  proj_trans error
 *   5  missing_grid (best non-ballpark op not instantiable; strict only)
 *   6  ballpark_only (no non-ballpark op exists at all; strict only)
 */
int pw_transform(const char* src, const char* dst, int allow_ballpark,
                 double* x, double* y, double* z);

/*
 * pw_transform_many: transform count points of interleaved xyz doubles in
 * place, resolving the operation per point exactly like pw_transform.
 * Stops at the first point that fails; earlier points keep their transformed
 * values and that point and every later one keep their input values.
 *
 * Returns -1 when every point succeeded, the index of the first point whose
 * coordinate could not be transformed, or the negated pw_transform code for a
 * failure that belongs to the CRS pair rather than to the point (-2, -3, -5,
 * -6).
 */
/*
 * pw_describe: JSON describing the operation that a transform between src and
 * dst would use at (x,y): its name, its PROJ accuracy in metres (-1 when PROJ
 * declares none), whether it is a ballpark, and the grids it needs with their
 * availability. Pass NaN for x or y to describe the pair without a point.
 *
 * Returns a malloc'd NUL-terminated string the caller frees, or NULL. Sets
 * *out_status to 0 on success, -1 for a bad argument, -2 when the CRS cannot
 * be resolved.
 */
char* pw_describe(const char* src, const char* dst, double x, double y,
                  int allow_ballpark, int* out_status);

/*
 * pw_list_crs: the coordinate reference systems usable at a point, as JSON.
 *
 * Each entry carries its authority, code, name, PROJ type, the name of its
 * area of use and that area's size in square degrees. The caller decides how
 * to present them; the area is included because the useful order is smallest
 * first, a local plane system being a better answer than a world-wide one.
 *
 * Entries whose area of use does not contain the point are excluded, as are
 * deprecated ones. `kinds` selects what to list: 1 horizontal (geographic 2D
 * and projected), 2 vertical, 4 geographic 3D and compound; OR them together.
 *
 * Returns a malloc'd NUL-terminated string the caller frees, or NULL. Sets
 * *out_status to 0 on success, -1 for a bad argument, -2 on a database error.
 */
char* pw_list_crs(double lon, double lat, int kinds, const char* authorities,
                  int* out_status);

int pw_transform_many(const char* src, const char* dst, int allow_ballpark,
                      double* xyz, int count);

#ifdef __cplusplus
}
#endif

#endif /* PROJ_WASM_H */
