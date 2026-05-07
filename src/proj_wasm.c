#include <proj.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>

static PJ_CONTEXT* g_ctx = NULL;
static char g_data_dir[1024];

/* Cached op for pw_transform. The same (src, dst) reuses the op until a
   grid write or explicit cache clear invalidates it. */
static PJ* g_op = NULL;
static char g_src[256];
static char g_dst[256];
static int g_swap_in = 0;
static int g_swap_out = 0;
/* Coord set by pw_transform before calling proj_get_op so the inner op
   selection can use proj_get_suggested_operation. NaN means no hint. */
static double g_pending_x = 0.0 / 0.0;  /* NaN */
static double g_pending_y = 0.0 / 0.0;  /* NaN */

/* Forward declarations. */
static int resolve_crs_pair(const char* src, const char* dst,
                            PJ** out_src_crs, PJ** out_dst_crs,
                            int* out_swap_in, int* out_swap_out);
static PJ* select_best_op(PJ* src_crs, PJ* dst_crs,
                          double sx, double sy, int has_coord,
                          int allow_ballpark,
                          int discard_missing,
                          int* out_chose_ballpark);
static int crs_obj_is_north_east(PJ* crs);
static PJ* crs_get_horizontal_2d(PJ* crs);
static int crs_has_vertical(const char* crs_str);
static PJ* proj_get_op(const char* src, const char* dst);
static void clear_op_cache(void);

/* JSON helpers. Each returns bytes appended (clipped to remaining buf). */
static int json_append_raw(char* buf, int pos, int cap, const char* s) {
  if (pos >= cap || !s) return 0;
  int n = (int)strlen(s);
  int room = cap - pos - 1;
  if (n > room) n = room;
  memcpy(buf + pos, s, n);
  return n;
}
static int json_append_char(char* buf, int pos, int cap, char c) {
  if (pos >= cap - 1) return 0;
  buf[pos] = c;
  return 1;
}
static int json_append_quoted(char* buf, int pos, int cap, const char* s) {
  int wrote = 0;
  wrote += json_append_char(buf, pos + wrote, cap, '"');
  if (s) {
    for (const char* p = s; *p; p++) {
      char c = *p;
      if (c == '"' || c == '\\') {
        wrote += json_append_char(buf, pos + wrote, cap, '\\');
        wrote += json_append_char(buf, pos + wrote, cap, c);
      } else if ((unsigned char)c < 0x20) {
        char esc[8];
        snprintf(esc, sizeof(esc), "\\u%04x", (unsigned char)c);
        wrote += json_append_raw(buf, pos + wrote, cap, esc);
      } else {
        wrote += json_append_char(buf, pos + wrote, cap, c);
      }
    }
  }
  wrote += json_append_char(buf, pos + wrote, cap, '"');
  return wrote;
}

static int crs_has_vertical(const char* crs_str) {
  if (!crs_str || !g_ctx) return 0;
  PJ* crs = proj_create(g_ctx, crs_str);
  if (!crs) return 0;
  PJ_TYPE t = proj_get_type(crs);
  int vert = (t == PJ_TYPE_GEOGRAPHIC_3D_CRS || t == PJ_TYPE_COMPOUND_CRS ||
              t == PJ_TYPE_VERTICAL_CRS);
  proj_destroy(crs);
  return vert;
}

static void clear_op_cache(void) {
  if (g_op) {
    proj_destroy(g_op);
    g_op = NULL;
  }
  g_src[0] = '\0';
  g_dst[0] = '\0';
  g_swap_in = 0;
  g_swap_out = 0;
}

static PJ* crs_get_horizontal_2d(PJ* crs) {
  if (!crs) return NULL;
  PJ_TYPE t = proj_get_type(crs);
  switch (t) {
    case PJ_TYPE_COMPOUND_CRS:
      return proj_crs_get_sub_crs(g_ctx, crs, 0);
    case PJ_TYPE_GEOGRAPHIC_3D_CRS:
      return proj_crs_demote_to_2D(g_ctx, NULL, crs);
    case PJ_TYPE_VERTICAL_CRS:
      return NULL;
    default:
      return proj_clone(g_ctx, crs);
  }
}

/* Check if a CRS axis order is north,east (lat first). */
static int crs_obj_is_north_east(PJ* crs) {
  if (!crs) return 0;
  int swap = 0;
  PJ* target = crs;
  PJ* horiz = NULL;

  if (proj_get_type(crs) == PJ_TYPE_COMPOUND_CRS) {
    horiz = proj_crs_get_sub_crs(g_ctx, crs, 0);
    if (horiz) target = horiz;
  }

  PJ* cs = proj_crs_get_coordinate_system(g_ctx, target);
  if (cs) {
    const char* dir0 = NULL;
    const char* dir1 = NULL;
    if (proj_cs_get_axis_count(g_ctx, cs) >= 2 &&
        proj_cs_get_axis_info(g_ctx, cs, 0, NULL, NULL, &dir0, NULL, NULL, NULL, NULL) &&
        proj_cs_get_axis_info(g_ctx, cs, 1, NULL, NULL, &dir1, NULL, NULL, NULL, NULL) &&
        dir0 && dir1 &&
        strcmp(dir0, "north") == 0 &&
        strcmp(dir1, "east") == 0) {
      swap = 1;
    }
    proj_destroy(cs);
  }

  if (horiz) proj_destroy(horiz);
  return swap;
}

/*
 * resolve_crs_pair: parse src/dst CRS strings, compute axis-swap flags,
 * promote vertical-only to compound CRS so operation selection works.
 * out_src_crs and out_dst_crs are owned by caller (must proj_destroy).
 * Returns 0 on success, negative on error.
 */
static int resolve_crs_pair(const char* src, const char* dst,
                            PJ** out_src_crs, PJ** out_dst_crs,
                            int* out_swap_in, int* out_swap_out) {
  if (!src || !dst || !out_src_crs || !out_dst_crs ||
      !out_swap_in || !out_swap_out) return -1;
  *out_src_crs = NULL;
  *out_dst_crs = NULL;
  *out_swap_in = 0;
  *out_swap_out = 0;
  if (!g_ctx) return -1;

  PJ* src_crs = proj_create(g_ctx, src);
  PJ* dst_crs = proj_create(g_ctx, dst);
  if (!src_crs || !dst_crs) {
    if (src_crs) proj_destroy(src_crs);
    if (dst_crs) proj_destroy(dst_crs);
    return -2;
  }

  PJ_TYPE src_type = proj_get_type(src_crs);
  PJ_TYPE dst_type = proj_get_type(dst_crs);

  /* Vertical-only on src side: build compound (other_horiz + vertical). */
  if (src_type == PJ_TYPE_VERTICAL_CRS && dst_type != PJ_TYPE_VERTICAL_CRS) {
    PJ* horiz = crs_get_horizontal_2d(dst_crs);
    if (horiz) {
      PJ* compound = proj_create_compound_crs(g_ctx, "src+vert", horiz, src_crs);
      proj_destroy(horiz);
      if (compound) {
        proj_destroy(src_crs);
        src_crs = compound;
        src_type = proj_get_type(src_crs);
      }
    }
  }
  /* Vertical-only on dst side: build compound similarly. */
  if (dst_type == PJ_TYPE_VERTICAL_CRS && src_type != PJ_TYPE_VERTICAL_CRS) {
    PJ* horiz = crs_get_horizontal_2d(src_crs);
    if (horiz) {
      PJ* compound = proj_create_compound_crs(g_ctx, "dst+vert", horiz, dst_crs);
      proj_destroy(horiz);
      if (compound) {
        proj_destroy(dst_crs);
        dst_crs = compound;
        dst_type = proj_get_type(dst_crs);
      }
    }
  }

  *out_swap_in = crs_obj_is_north_east(src_crs);
  *out_swap_out = crs_obj_is_north_east(dst_crs);

  /* If one side is vertical-only (rare after compound promotion), inherit
     horizontal axis order from the other. */
  if (dst_type == PJ_TYPE_VERTICAL_CRS) *out_swap_out = *out_swap_in;
  if (src_type == PJ_TYPE_VERTICAL_CRS) *out_swap_in = *out_swap_out;

  *out_src_crs = src_crs;
  *out_dst_crs = dst_crs;
  return 0;
}

/*
 * select_best_op: returns the best non-ballpark coordinate operation,
 * choosing by coordinate when has_coord is non-zero (uses
 * proj_get_suggested_operation; sx,sy must be in source CRS axis order).
 *
 * Uses PROJ_GRID_AVAILABILITY_IGNORED to enumerate operations as if all
 * grids were available — this is what we want for grid pre-fetching.
 *
 * Caller owns the returned PJ* (proj_destroy when done).
 * Returns NULL if no non-ballpark op exists; out_chose_ballpark=1 indicates
 * "list was empty, only ballpark available", 0 indicates "factory error".
 */
static PJ* select_best_op(PJ* src_crs, PJ* dst_crs,
                          double sx, double sy, int has_coord,
                          int allow_ballpark,
                          int discard_missing,
                          int* out_chose_ballpark) {
  if (out_chose_ballpark) *out_chose_ballpark = 0;
  if (!src_crs || !dst_crs || !g_ctx) return NULL;

  PJ_OPERATION_FACTORY_CONTEXT* fctx =
      proj_create_operation_factory_context(g_ctx, NULL);
  if (!fctx) return NULL;

  /* discard_missing=1 mirrors proj_create_crs_to_crs's default behavior:
     ops requiring grids we don't have on disk are discarded, so the picked
     op (which might be ballpark) is always runnable. discard_missing=0
     surfaces every candidate including ones with missing grids — used by
     pw_grids_needed and pw_strict_check to enumerate / verify the
     theoretically-best op. */
  proj_operation_factory_context_set_grid_availability_use(
      g_ctx, fctx,
      discard_missing
        ? PROJ_GRID_AVAILABILITY_DISCARD_OPERATION_IF_MISSING_GRID
        : PROJ_GRID_AVAILABILITY_IGNORED);
  /* PARTIAL_INTERSECTION matches proj_create_crs_to_crs's internal default
     (crs_to_crs.cpp:568). It surfaces regionally-scoped grid ops (NADCON
     CONUS, NTv2 etc.) for points within their extent, which is the
     behavior we want for accurate transformations. */
  proj_operation_factory_context_set_spatial_criterion(
      g_ctx, fctx, PROJ_SPATIAL_CRITERION_PARTIAL_INTERSECTION);
  proj_operation_factory_context_set_allow_ballpark_transformations(
      g_ctx, fctx, allow_ballpark);

  PJ_OBJ_LIST* list = proj_create_operations(g_ctx, src_crs, dst_crs, fctx);
  proj_operation_factory_context_destroy(fctx);
  if (!list) return NULL;

  int n = proj_list_get_count(list);
  if (n <= 0) {
    proj_list_destroy(list);
    if (out_chose_ballpark) *out_chose_ballpark = 1;
    return NULL;
  }

  int idx = 0;
  if (has_coord) {
    PJ_COORD c = proj_coord(sx, sy, 0.0, HUGE_VAL);
    int suggested = proj_get_suggested_operation(g_ctx, list, PJ_FWD, c);
    if (suggested >= 0 && suggested < n) idx = suggested;
  }
  PJ* op = proj_list_get(g_ctx, list, idx);

  proj_list_destroy(list);

  /* When the caller forbade ballpark, double-check the chosen op too. */
  if (op && !allow_ballpark &&
      proj_coordoperation_has_ballpark_transformation(g_ctx, op) == 1) {
    proj_destroy(op);
    if (out_chose_ballpark) *out_chose_ballpark = 1;
    return NULL;
  }

  return op;
}

int pw_init(const char* data_dir) {
  if (g_ctx) return 0;

  g_ctx = proj_context_create();
  if (!g_ctx) return 1;

  g_data_dir[0] = '\0';
  if (data_dir && data_dir[0] != '\0') {
    strncpy(g_data_dir, data_dir, sizeof(g_data_dir) - 1);
    g_data_dir[sizeof(g_data_dir) - 1] = '\0';

    const char* paths[1] = {g_data_dir};
    proj_context_set_search_paths(g_ctx, 1, paths);

    char db_path[1280];
    snprintf(db_path, sizeof(db_path), "%s/proj.db", g_data_dir);
    proj_context_set_database_path(g_ctx, db_path, NULL, NULL);
  }

  return 0;
}

/*
 * pw_grids_needed: enumerate grid files required for the best non-ballpark
 * operation between src and dst CRS, optionally biased toward the input
 * coordinate. The output is JSON written to out_buf.
 *
 * x, y: input in JS axis order (lon,lat). Pass NaN to skip coord-based
 *       suggestion (returns the first candidate).
 *
 * Return values:
 *   >= 0  : bytes written to out_buf (excluding NUL terminator)
 *    -1   : null arg or buffer too small
 *    -2   : CRS resolution failed
 *    -3   : no non-ballpark op exists (only Helmert/ballpark available)
 *    -4   : output buffer overflow
 */
int pw_grids_needed(const char* src, const char* dst,
                    double x, double y,
                    int discard_missing,
                    char* out_buf, int buf_len) {
  if (!src || !dst || !out_buf || buf_len < 3) return -1;
  out_buf[0] = '\0';

  PJ* src_crs = NULL;
  PJ* dst_crs = NULL;
  int swap_in = 0, swap_out = 0;
  if (resolve_crs_pair(src, dst, &src_crs, &dst_crs, &swap_in, &swap_out) != 0) {
    if (src_crs) proj_destroy(src_crs);
    if (dst_crs) proj_destroy(dst_crs);
    return -2;
  }

  int has_coord = !isnan(x) && !isnan(y);
  /* Apply swap_in to put coord into source CRS axis order before passing
     to PROJ's suggested-operation API. */
  double sx = swap_in ? y : x;
  double sy = swap_in ? x : y;

  int chose_ballpark = 0;
  /* discard_missing=0: enumerate the IDEAL non-ballpark op's grids. Used
     to decide what to fetch initially (PROJ may report a grid that isn't
     in our bundle, in which case the caller should follow up with
     discard_missing=1).
     discard_missing=1: enumerate the union of grids referenced by the
     top-N IGNORED-mode candidates. PROJ's plain DISCARD_MISSING mode
     would only see currently-mounted grids, so it can't help us discover
     what to fetch. By collecting grid names across the top several
     non-ballpark candidates we surface fallback ops (e.g. 2.5x2.5 EGM2008
     when the 1x1 grid isn't in the bundle). */
  PJ* op = NULL;
  PJ_OBJ_LIST* multi_list = NULL;
  int multi_count = 0;
  if (discard_missing) {
    PJ_OPERATION_FACTORY_CONTEXT* fctx =
        proj_create_operation_factory_context(g_ctx, NULL);
    if (fctx) {
      proj_operation_factory_context_set_grid_availability_use(
          g_ctx, fctx, PROJ_GRID_AVAILABILITY_IGNORED);
      proj_operation_factory_context_set_spatial_criterion(
          g_ctx, fctx, PROJ_SPATIAL_CRITERION_PARTIAL_INTERSECTION);
      proj_operation_factory_context_set_allow_ballpark_transformations(
          g_ctx, fctx, 0);
      multi_list = proj_create_operations(g_ctx, src_crs, dst_crs, fctx);
      proj_operation_factory_context_destroy(fctx);
      if (multi_list) multi_count = proj_list_get_count(multi_list);
    }
  } else {
    op = select_best_op(src_crs, dst_crs, sx, sy, has_coord,
                        /*allow_ballpark=*/0, /*discard_missing=*/0,
                        &chose_ballpark);
  }
  proj_destroy(src_crs);
  proj_destroy(dst_crs);
  if (!op && !multi_list) return chose_ballpark ? -3 : -2;

  /* Up to N candidates' grids, deduped by shortName. */
  enum { MAX_CANDIDATES = 8 };
  if (multi_count > MAX_CANDIDATES) multi_count = MAX_CANDIDATES;
  int n = op ? proj_coordoperation_get_grid_used_count(g_ctx, op) : 0;
  int pos = 0;
  int written_grids = 0;
  pos += json_append_char(out_buf, pos, buf_len, '[');

  /* Helper macro avoids duplicating the JSON-emit code for both single-op
     and multi-op enumeration paths. We dedupe by short_name to keep the
     output compact. */
  #define APPEND_GRID(SN, FN, PN, URL, AVAIL) do { \
    if (written_grids > 0) pos += json_append_char(out_buf, pos, buf_len, ','); \
    pos += json_append_raw(out_buf, pos, buf_len, "{\"shortName\":"); \
    pos += json_append_quoted(out_buf, pos, buf_len, (SN) ? (SN) : ""); \
    pos += json_append_raw(out_buf, pos, buf_len, ",\"fullName\":"); \
    pos += json_append_quoted(out_buf, pos, buf_len, (FN) ? (FN) : ""); \
    pos += json_append_raw(out_buf, pos, buf_len, ",\"packageName\":"); \
    pos += json_append_quoted(out_buf, pos, buf_len, (PN) ? (PN) : ""); \
    pos += json_append_raw(out_buf, pos, buf_len, ",\"url\":"); \
    pos += json_append_quoted(out_buf, pos, buf_len, (URL) ? (URL) : ""); \
    pos += json_append_raw(out_buf, pos, buf_len, ",\"available\":"); \
    pos += json_append_raw(out_buf, pos, buf_len, (AVAIL) ? "1" : "0"); \
    pos += json_append_char(out_buf, pos, buf_len, '}'); \
    written_grids++; \
  } while(0)

  /* Track shortNames already emitted (linear scan is fine for small N). */
  const char* seen[256];
  int seen_count = 0;

  if (op) {
    for (int i = 0; i < n; i++) {
      const char *short_name = NULL, *full_name = NULL;
      const char *package_name = NULL, *url = NULL;
      int direct_download = 0, open_license = 0, available = 0;
      int ok = proj_coordoperation_get_grid_used(
          g_ctx, op, i,
          &short_name, &full_name, &package_name, &url,
          &direct_download, &open_license, &available);
      if (!ok) continue;
      APPEND_GRID(short_name, full_name, package_name, url, available);
      if (seen_count < 256 && short_name) seen[seen_count++] = short_name;
    }
  }

  if (multi_list) {
    for (int oi = 0; oi < multi_count; oi++) {
      PJ* candidate = proj_list_get(g_ctx, multi_list, oi);
      if (!candidate) continue;
      int gn = proj_coordoperation_get_grid_used_count(g_ctx, candidate);
      for (int i = 0; i < gn; i++) {
        const char *short_name = NULL, *full_name = NULL;
        const char *package_name = NULL, *url = NULL;
        int direct_download = 0, open_license = 0, available = 0;
        int ok = proj_coordoperation_get_grid_used(
            g_ctx, candidate, i,
            &short_name, &full_name, &package_name, &url,
            &direct_download, &open_license, &available);
        if (!ok || !short_name) continue;

        int dup = 0;
        for (int s = 0; s < seen_count; s++) {
          if (seen[s] && strcmp(seen[s], short_name) == 0) { dup = 1; break; }
        }
        if (dup) continue;
        APPEND_GRID(short_name, full_name, package_name, url, available);
        if (seen_count < 256) seen[seen_count++] = short_name;
      }
      proj_destroy(candidate);
    }
  }

  pos += json_append_char(out_buf, pos, buf_len, ']');

  if (op) proj_destroy(op);
  if (multi_list) proj_list_destroy(multi_list);

  #undef APPEND_GRID

  if (pos >= buf_len) return -4;
  out_buf[pos] = '\0';
  return pos;
}

/*
 * pw_strict_check: returns 1 if best non-ballpark op for (src,dst) at the
 * given coord is instantiable (all required grids available on disk), 0
 * otherwise. Negative on error.
 *
 * x,y: JS axis order (lon,lat). Pass NaN to skip coord-based selection.
 */
int pw_strict_check(const char* src, const char* dst, double x, double y) {
  if (!src || !dst) return -1;

  PJ* src_crs = NULL;
  PJ* dst_crs = NULL;
  int swap_in = 0, swap_out = 0;
  if (resolve_crs_pair(src, dst, &src_crs, &dst_crs, &swap_in, &swap_out) != 0) {
    if (src_crs) proj_destroy(src_crs);
    if (dst_crs) proj_destroy(dst_crs);
    return -2;
  }

  int has_coord = !isnan(x) && !isnan(y);
  double sx = swap_in ? y : x;
  double sy = swap_in ? x : y;

  int chose_ballpark = 0;
  /* strict_check verifies the best NON-ballpark op is instantiable;
     a 0 result means callers should treat the missing-grid condition as
     significant (silent ballpark fallback would otherwise hide it). */
  PJ* op = select_best_op(src_crs, dst_crs, sx, sy, has_coord,
                          /*allow_ballpark=*/0, /*discard_missing=*/0,
                          &chose_ballpark);
  proj_destroy(src_crs);
  proj_destroy(dst_crs);
  if (!op) return 0;

  int ok = proj_coordoperation_is_instantiable(g_ctx, op);
  proj_destroy(op);
  return ok ? 1 : 0;
}

/*
 * pw_refresh_after_grid_write: invalidate any internal PROJ caches so that
 * grid files newly written to MEMFS become visible. Call this once after
 * each batch of FS.writeFile() calls before issuing a transform that would
 * use the new grids.
 *
 * strategy:
 *   0  network grid-chunk cache only (proj_grid_cache_clear)
 *   1  ditto + recreate g_ctx (full database/grid availability cache reset)
 *   2  default (currently == 1, conservative)
 *
 * Returns 0 on success, negative on error.
 *
 * Phase 0 testing showed that proj_grid_cache_clear alone does NOT
 * invalidate DatabaseContext::Private::cacheGridInfo_ (per Codex review of
 * factory.cpp:3436,3552), so we recreate the context by default.
 */
int pw_refresh_after_grid_write(int strategy) {
  if (!g_ctx) return -1;

  /* Always drop the cached operation; even if PROJ's database cache were
     consulted again, the wrapper holds a PJ* pointer that pre-dates the
     mount and would silently keep using a missing-grid pipeline. */
  clear_op_cache();

  if (strategy == 0) {
    proj_grid_cache_clear(g_ctx);
    return 0;
  }

  /* Default / strategy >= 1: recreate the entire context so all PROJ-side
     caches (database grid info, network chunk cache, internal proj.db query
     cache) are dropped. Search paths and database path are restored from
     g_data_dir. */
  proj_context_destroy(g_ctx);
  g_ctx = proj_context_create();
  if (!g_ctx) return -2;

  if (g_data_dir[0] != '\0') {
    const char* paths[1] = {g_data_dir};
    proj_context_set_search_paths(g_ctx, 1, paths);

    char db_path[1280];
    snprintf(db_path, sizeof(db_path), "%s/proj.db", g_data_dir);
    proj_context_set_database_path(g_ctx, db_path, NULL, NULL);
  }
  return 0;
}

/*
 * pw_transform: strict-mode transform from src CRS to dst CRS at (x,y,z).
 * The selected coordinate operation is the highest-accuracy non-ballpark
 * candidate, chosen via proj_get_suggested_operation when input coord is
 * present.
 *
 * Errors silently fall back are NOT permitted: if any grid required by the
 * best op is missing on disk, we return code 5 and the caller must fetch
 * grids and call pw_refresh_after_grid_write before retrying.
 *
 * Return codes (kept stable for JS error mapping):
 *   0  success
 *   2  null pointer arg
 *   3  CRS resolution / op create failed
 *   4  proj_trans error
 *   5  missing_grid (best non-ballpark op not instantiable)
 *   6  ballpark_only (no non-ballpark op exists at all)
 */
/*
 * proj_get_op: returns the cached op for (src, dst). The cache key is
 * (src, dst) and the op is invalidated by clear_op_cache() (e.g. inside
 * pw_refresh_after_grid_write). The cache key intentionally omits the
 * input coordinate even though select_best_op uses proj_get_suggested_
 * operation: in practice we expect repeated transforms with the same pair
 * to fall in the same suggested-op region, and a 1-cell cache is
 * sufficient for the comparison/benchmark workloads.
 *
 * Pipeline differs based on whether either CRS is vertical/compound:
 *   - has vertical: keep the raw op, manual axis swap (this avoids
 *     proj_normalize_for_visualization perturbing vgridshift candidate
 *     selection in PROJ 9.6–9.8).
 *   - no vertical: wrap with proj_normalize_for_visualization so callers
 *     can always pass (lon, lat) regardless of source / target CRS axis
 *     order. This also handles polar CRS (e.g. UPS) where both axes
 *     direction strings are "north" and our crs_obj_is_north_east heuristic
 *     would otherwise misclassify them.
 */
static PJ* proj_get_op(const char* src, const char* dst) {
  if (!g_ctx || !src || !dst) return NULL;

  if (g_op && strcmp(src, g_src) == 0 && strcmp(dst, g_dst) == 0) {
    return g_op;
  }
  clear_op_cache();

  PJ* src_crs = NULL;
  PJ* dst_crs = NULL;
  int swap_in = 0, swap_out = 0;
  if (resolve_crs_pair(src, dst, &src_crs, &dst_crs, &swap_in, &swap_out) != 0) {
    if (src_crs) proj_destroy(src_crs);
    if (dst_crs) proj_destroy(dst_crs);
    return NULL;
  }

  /* Coord-aware selection: use the input coord (set by pw_transform via
     g_pending_*) so proj_get_suggested_operation picks the regional op
     that applies at this point. */
  int has_coord = !isnan(g_pending_x) && !isnan(g_pending_y);
  double sx = swap_in ? g_pending_y : g_pending_x;
  double sy = swap_in ? g_pending_x : g_pending_y;
  int chose_ballpark = 0;
  /* For pw_transform we mirror proj_create_crs_to_crs's default: allow
     ballpark fallback AND discard ops whose grids aren't on disk, so the
     selected op is always instantiable. Callers that want strict (no
     silent fallback) detection should call pw_strict_check first and
     surface MissingGridError. */
  PJ* raw = select_best_op(src_crs, dst_crs, sx, sy, has_coord,
                           /*allow_ballpark=*/1, /*discard_missing=*/1,
                           &chose_ballpark);
  if (!raw) {
    proj_destroy(src_crs);
    proj_destroy(dst_crs);
    return NULL;
  }

  int has_vert = crs_has_vertical(src) || crs_has_vertical(dst);
  PJ* final_op = NULL;

  if (has_vert) {
    final_op = raw;
    g_swap_in = swap_in;
    g_swap_out = swap_out;
  } else {
    /* Wrap so input/output is always (lon, lat) regardless of CRS axis
       order. proj_normalize_for_visualization handles polar CRS and any
       other non-trivial axis configuration that crs_obj_is_north_east
       cannot detect (e.g. EPSG:32761 UPS South where both axes have
       direction "north"). */
    PJ* normalized = proj_normalize_for_visualization(g_ctx, raw);
    proj_destroy(raw);
    if (!normalized) {
      proj_destroy(src_crs);
      proj_destroy(dst_crs);
      return NULL;
    }
    final_op = normalized;
    g_swap_in = 0;
    g_swap_out = 0;
  }

  proj_destroy(src_crs);
  proj_destroy(dst_crs);

  g_op = final_op;
  strncpy(g_src, src, sizeof(g_src) - 1);
  g_src[sizeof(g_src) - 1] = '\0';
  strncpy(g_dst, dst, sizeof(g_dst) - 1);
  g_dst[sizeof(g_dst) - 1] = '\0';
  return g_op;
}

int pw_transform(const char* src, const char* dst,
                 double* x, double* y, double* z) {
  if (!x || !y || !src || !dst) return 2;

  /* Hand the input coord to proj_get_op so the underlying select_best_op
     can call proj_get_suggested_operation and pick the regional op that
     applies here. */
  g_pending_x = *x;
  g_pending_y = *y;
  PJ* op = proj_get_op(src, dst);

  double in_x = g_swap_in ? *y : *x;
  double in_y = g_swap_in ? *x : *y;

  PJ_COORD c = proj_coord(in_x, in_y, z ? *z : 0.0, 0.0);
  PJ_COORD r = proj_trans(op, PJ_FWD, c);
  int err = (op == NULL) ? 3 : proj_errno(op);

  /* If the cached op chosen for an earlier coord doesn't cover this point,
     proj_trans returns an error. Drop the cache and re-resolve once with
     the current coord so proj_get_suggested_operation can pick the op
     that applies here. */
  if (op != NULL && err != 0) {
    clear_op_cache();
    op = proj_get_op(src, dst);
    if (op != NULL) {
      in_x = g_swap_in ? *y : *x;
      in_y = g_swap_in ? *x : *y;
      c = proj_coord(in_x, in_y, z ? *z : 0.0, 0.0);
      r = proj_trans(op, PJ_FWD, c);
      err = proj_errno(op);
    } else {
      err = 3;
    }
  }

  g_pending_x = 0.0 / 0.0;
  g_pending_y = 0.0 / 0.0;
  if (op == NULL) return 3;
  if (err != 0) return 4;

  *x = g_swap_out ? r.xyz.y : r.xyz.x;
  *y = g_swap_out ? r.xyz.x : r.xyz.y;
  if (z) *z = r.xyz.z;

  return 0;
}

/* Drop all internal caches. Kept exported for tests / the legacy JS path. */
void pw_clear_cache(void) {
  clear_op_cache();
  if (g_ctx) proj_grid_cache_clear(g_ctx);
}

void pw_cleanup(void) {
  clear_op_cache();
  if (g_ctx) {
    proj_context_destroy(g_ctx);
    g_ctx = NULL;
  }
  g_data_dir[0] = '\0';
}
