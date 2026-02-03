#include <proj.h>
#include <stdio.h>
#include <string.h>

static PJ_CONTEXT* g_ctx = NULL;
static PJ* g_op = NULL;
static char g_src[256];
static char g_dst[256];

static PJ* proj_get_op(const char* src, const char* dst) {
  if (!g_ctx) {
    return NULL;
  }

  if (g_op && src && dst && strcmp(src, g_src) == 0 && strcmp(dst, g_dst) == 0) {
    return g_op;
  }

  if (g_op) {
    proj_destroy(g_op);
    g_op = NULL;
  }

  if (!src || !dst) {
    return NULL;
  }

  PJ* op = proj_create_crs_to_crs(g_ctx, src, dst, NULL);
  if (!op) {
    return NULL;
  }

  PJ* normalized = proj_normalize_for_visualization(g_ctx, op);
  proj_destroy(op);
  if (!normalized) {
    return NULL;
  }

  g_op = normalized;
  strncpy(g_src, src, sizeof(g_src) - 1);
  g_src[sizeof(g_src) - 1] = '\0';
  strncpy(g_dst, dst, sizeof(g_dst) - 1);
  g_dst[sizeof(g_dst) - 1] = '\0';
  return g_op;
}

int proj_init(const char* data_dir) {
  if (g_ctx) {
    return 0;
  }

  g_ctx = proj_context_create();
  if (!g_ctx) {
    return 1;
  }

  if (data_dir && data_dir[0] != '\0') {
    const char* paths[1] = {data_dir};
    proj_context_set_search_paths(g_ctx, 1, paths);

    char db_path[1024];
    snprintf(db_path, sizeof(db_path), "%s/proj.db", data_dir);
    proj_context_set_database_path(g_ctx, db_path, NULL, NULL);
  }

  return 0;
}

int proj_transform(const char* src, const char* dst, double* x, double* y, double* z) {
  if (!x || !y) {
    return 2;
  }

  PJ* op = proj_get_op(src, dst);
  if (!op) {
    return 3;
  }

  PJ_COORD c = proj_coord(*x, *y, z ? *z : 0.0, 0.0);
  PJ_COORD r = proj_trans(op, PJ_FWD, c);
  if (proj_errno(op) != 0) {
    return 4;
  }

  *x = r.xyz.x;
  *y = r.xyz.y;
  if (z) {
    *z = r.xyz.z;
  }

  return 0;
}

void proj_clear_cache(void) {
  if (g_op) {
    proj_destroy(g_op);
    g_op = NULL;
  }
  g_src[0] = '\0';
  g_dst[0] = '\0';
}

void proj_cleanup(void) {
  proj_clear_cache();
  if (g_ctx) {
    proj_context_destroy(g_ctx);
    g_ctx = NULL;
  }
}
