#include <proj.h>
#include <stdio.h>
#include <string.h>

static PJ_CONTEXT* g_ctx = NULL;
static PJ* g_op = NULL;
static char g_src[256];
static char g_dst[256];
static int g_swap_in = 0;
static int g_swap_out = 0;

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

/*
 * Check if a CRS has a vertical component (3D geographic or compound).
 * When either source or target has vertical, we must skip
 * proj_normalize_for_visualization because it breaks bbox evaluation
 * for vgridshift candidates (PROJ 9.x bug).
 */
static int crs_has_vertical(const char* crs_str) {
  PJ* crs = proj_create(g_ctx, crs_str);
  if (!crs) return 0;

  PJ_TYPE t = proj_get_type(crs);
  int vert = (t == PJ_TYPE_GEOGRAPHIC_3D_CRS || t == PJ_TYPE_COMPOUND_CRS ||
              t == PJ_TYPE_VERTICAL_CRS);
  proj_destroy(crs);
  return vert;
}

/* Check if a CRS is a vertical-only CRS. */
static int crs_is_vertical(const char* crs_str) {
  PJ* crs = proj_create(g_ctx, crs_str);
  if (!crs) return 0;

  PJ_TYPE t = proj_get_type(crs);
  int is_vertical = (t == PJ_TYPE_VERTICAL_CRS);
  proj_destroy(crs);
  return is_vertical;
}

/* Check if a CRS axis order is north,east (lat/ northing first). */
static int crs_is_north_east(const char* crs_str) {
  PJ* crs = proj_create(g_ctx, crs_str);
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
  proj_destroy(crs);
  return swap;
}

static PJ* proj_get_op(const char* src, const char* dst) {
  if (!g_ctx) return NULL;

  if (g_op && src && dst &&
      strcmp(src, g_src) == 0 && strcmp(dst, g_dst) == 0) {
    return g_op;
  }

  if (g_op) {
    proj_destroy(g_op);
    g_op = NULL;
  }
  g_swap_in = 0;
  g_swap_out = 0;

  if (!src || !dst) return NULL;

  int has_vert = crs_has_vertical(src) || crs_has_vertical(dst);
  PJ* op = NULL;

  if (has_vert) {
    PJ* src_crs = proj_create(g_ctx, src);
    PJ* dst_crs = proj_create(g_ctx, dst);
    if (!src_crs || !dst_crs) {
      if (src_crs) proj_destroy(src_crs);
      if (dst_crs) proj_destroy(dst_crs);
      return NULL;
    }

    PJ* src_for_op = src_crs;
    PJ* src_compound = NULL;
    if (proj_get_type(src_crs) == PJ_TYPE_VERTICAL_CRS &&
        proj_get_type(dst_crs) != PJ_TYPE_VERTICAL_CRS) {
      PJ* horiz = crs_get_horizontal_2d(dst_crs);
      if (horiz) {
        src_compound = proj_create_compound_crs(g_ctx, "src+vert", horiz, src_crs);
        proj_destroy(horiz);
        if (src_compound) src_for_op = src_compound;
      }
    }

    op = proj_create_crs_to_crs_from_pj(g_ctx, src_for_op, dst_crs, NULL, NULL);

    g_swap_in = crs_is_north_east(src);
    g_swap_out = crs_is_north_east(dst);
    if (proj_get_type(src_crs) == PJ_TYPE_VERTICAL_CRS &&
        proj_get_type(dst_crs) != PJ_TYPE_VERTICAL_CRS) {
      g_swap_in = crs_is_north_east(dst);
    }
    if (!g_swap_out && crs_is_vertical(dst)) {
      g_swap_out = g_swap_in;
    }

    if (src_compound) proj_destroy(src_compound);
    proj_destroy(src_crs);
    proj_destroy(dst_crs);
    if (!op) return NULL;
    g_op = op;
  } else {
    op = proj_create_crs_to_crs(g_ctx, src, dst, NULL);
    if (!op) return NULL;
    PJ* normalized = proj_normalize_for_visualization(g_ctx, op);
    proj_destroy(op);
    if (!normalized) return NULL;
    g_op = normalized;
  }

  strncpy(g_src, src, sizeof(g_src) - 1);
  g_src[sizeof(g_src) - 1] = '\0';
  strncpy(g_dst, dst, sizeof(g_dst) - 1);
  g_dst[sizeof(g_dst) - 1] = '\0';
  return g_op;
}

int pw_init(const char* data_dir) {
  if (g_ctx) return 0;

  g_ctx = proj_context_create();
  if (!g_ctx) return 1;

  if (data_dir && data_dir[0] != '\0') {
    const char* paths[1] = {data_dir};
    proj_context_set_search_paths(g_ctx, 1, paths);

    char db_path[1024];
    snprintf(db_path, sizeof(db_path), "%s/proj.db", data_dir);
    proj_context_set_database_path(g_ctx, db_path, NULL, NULL);
  }

  return 0;
}

int pw_transform(const char* src, const char* dst, double* x, double* y, double* z) {
  if (!x || !y) return 2;

  PJ* op = proj_get_op(src, dst);
  if (!op) return 3;

  /* JS sends lon,lat. If raw op expects lat,lon, swap. */
  double in_x = g_swap_in ? *y : *x;
  double in_y = g_swap_in ? *x : *y;

  PJ_COORD c = proj_coord(in_x, in_y, z ? *z : 0.0, 0.0);
  PJ_COORD r = proj_trans(op, PJ_FWD, c);
  if (proj_errno(op) != 0) return 4;

  /* If output is lat,lon, swap back to lon,lat for JS. */
  *x = g_swap_out ? r.xyz.y : r.xyz.x;
  *y = g_swap_out ? r.xyz.x : r.xyz.y;
  if (z) *z = r.xyz.z;

  return 0;
}

void pw_clear_cache(void) {
  if (g_op) {
    proj_destroy(g_op);
    g_op = NULL;
  }
  g_src[0] = '\0';
  g_dst[0] = '\0';
  g_swap_in = 0;
  g_swap_out = 0;
}

void pw_cleanup(void) {
  pw_clear_cache();
  if (g_ctx) {
    proj_context_destroy(g_ctx);
    g_ctx = NULL;
  }
}
