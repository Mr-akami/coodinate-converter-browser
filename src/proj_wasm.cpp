#include "proj_wasm.h"

#include <proj.h>

#include <cmath>
#include <cstddef>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <string>
#include <utility>
#include <vector>

namespace {

struct ContextDeleter {
  void operator()(PJ_CONTEXT* ctx) const { proj_context_destroy(ctx); }
};
struct PjDeleter {
  void operator()(PJ* pj) const { proj_destroy(pj); }
};
struct ObjListDeleter {
  void operator()(PJ_OBJ_LIST* list) const { proj_list_destroy(list); }
};
struct FactoryContextDeleter {
  void operator()(PJ_OPERATION_FACTORY_CONTEXT* factory) const {
    proj_operation_factory_context_destroy(factory);
  }
};

using ContextPtr = std::unique_ptr<PJ_CONTEXT, ContextDeleter>;
using PjPtr = std::unique_ptr<PJ, PjDeleter>;
using ObjListPtr = std::unique_ptr<PJ_OBJ_LIST, ObjListDeleter>;
using FactoryContextPtr =
    std::unique_ptr<PJ_OPERATION_FACTORY_CONTEXT, FactoryContextDeleter>;

struct OperationKey {
  std::string src;
  std::string dst;
  bool allow_ballpark = false;

  bool operator==(const OperationKey& other) const {
    return src == other.src && dst == other.dst &&
           allow_ballpark == other.allow_ballpark;
  }
};

struct CachedOperation {
  OperationKey key;
  PjPtr op;
  int swap_in = 0;
  int swap_out = 0;
};

/* ctx is declared first so it is destroyed last: calling proj_destroy on a PJ
   after its PJ_CONTEXT has been destroyed is undefined. */
struct WrapperState {
  ContextPtr ctx;
  std::string data_dir;
  CachedOperation cached;
};

WrapperState& state() {
  static WrapperState instance;
  return instance;
}

void apply_data_dir(PJ_CONTEXT* ctx, const std::string& data_dir) {
  if (data_dir.empty()) return;

  const char* paths[1] = {data_dir.c_str()};
  proj_context_set_search_paths(ctx, 1, paths);

  const std::string db_path = data_dir + "/proj.db";
  proj_context_set_database_path(ctx, db_path.c_str(), nullptr, nullptr);
}

bool crs_has_vertical(PJ* crs) {
  if (!crs) return false;
  const PJ_TYPE type = proj_get_type(crs);
  return type == PJ_TYPE_GEOGRAPHIC_3D_CRS || type == PJ_TYPE_COMPOUND_CRS ||
         type == PJ_TYPE_VERTICAL_CRS;
}

PjPtr crs_get_horizontal_2d(PJ_CONTEXT* ctx, PJ* crs) {
  if (!crs) return nullptr;
  switch (proj_get_type(crs)) {
    case PJ_TYPE_COMPOUND_CRS:
      return PjPtr(proj_crs_get_sub_crs(ctx, crs, 0));
    case PJ_TYPE_GEOGRAPHIC_3D_CRS:
      return PjPtr(proj_crs_demote_to_2D(ctx, nullptr, crs));
    case PJ_TYPE_VERTICAL_CRS:
      return nullptr;
    default:
      return PjPtr(proj_clone(ctx, crs));
  }
}

/* Check if a CRS axis order is north,east (lat first). */
bool crs_is_north_east(PJ_CONTEXT* ctx, PJ* crs) {
  if (!crs) return false;

  PjPtr horizontal;
  PJ* target = crs;
  if (proj_get_type(crs) == PJ_TYPE_COMPOUND_CRS) {
    horizontal = PjPtr(proj_crs_get_sub_crs(ctx, crs, 0));
    if (horizontal) target = horizontal.get();
  }

  const PjPtr cs(proj_crs_get_coordinate_system(ctx, target));
  if (!cs) return false;

  const char* dir0 = nullptr;
  const char* dir1 = nullptr;
  return proj_cs_get_axis_count(ctx, cs.get()) >= 2 &&
         proj_cs_get_axis_info(ctx, cs.get(), 0, nullptr, nullptr, &dir0,
                               nullptr, nullptr, nullptr, nullptr) &&
         proj_cs_get_axis_info(ctx, cs.get(), 1, nullptr, nullptr, &dir1,
                               nullptr, nullptr, nullptr, nullptr) &&
         dir0 && dir1 && std::strcmp(dir0, "north") == 0 &&
         std::strcmp(dir1, "east") == 0;
}

struct CrsPair {
  PjPtr src;
  PjPtr dst;
  int swap_in = 0;
  int swap_out = 0;
};

/*
 * resolve_crs_pair: parse src/dst CRS strings, compute axis-swap flags,
 * promote vertical-only to compound CRS so operation selection works.
 */
bool resolve_crs_pair(PJ_CONTEXT* ctx, const char* src, const char* dst,
                      CrsPair* out) {
  PjPtr src_crs(proj_create(ctx, src));
  PjPtr dst_crs(proj_create(ctx, dst));
  if (!src_crs || !dst_crs) return false;

  PJ_TYPE src_type = proj_get_type(src_crs.get());
  PJ_TYPE dst_type = proj_get_type(dst_crs.get());

  /* Vertical-only on src side: build compound (other_horiz + vertical). */
  if (src_type == PJ_TYPE_VERTICAL_CRS && dst_type != PJ_TYPE_VERTICAL_CRS) {
    const PjPtr horizontal = crs_get_horizontal_2d(ctx, dst_crs.get());
    if (horizontal) {
      PjPtr compound(proj_create_compound_crs(ctx, "src+vert", horizontal.get(),
                                              src_crs.get()));
      if (compound) {
        src_crs = std::move(compound);
        src_type = proj_get_type(src_crs.get());
      }
    }
  }
  /* Vertical-only on dst side: build compound similarly. */
  if (dst_type == PJ_TYPE_VERTICAL_CRS && src_type != PJ_TYPE_VERTICAL_CRS) {
    const PjPtr horizontal = crs_get_horizontal_2d(ctx, src_crs.get());
    if (horizontal) {
      PjPtr compound(proj_create_compound_crs(ctx, "dst+vert", horizontal.get(),
                                              dst_crs.get()));
      if (compound) {
        dst_crs = std::move(compound);
        dst_type = proj_get_type(dst_crs.get());
      }
    }
  }

  out->swap_in = crs_is_north_east(ctx, src_crs.get()) ? 1 : 0;
  out->swap_out = crs_is_north_east(ctx, dst_crs.get()) ? 1 : 0;

  /* If one side is vertical-only (rare after compound promotion), inherit
     horizontal axis order from the other. */
  if (dst_type == PJ_TYPE_VERTICAL_CRS) out->swap_out = out->swap_in;
  if (src_type == PJ_TYPE_VERTICAL_CRS) out->swap_in = out->swap_out;

  out->src = std::move(src_crs);
  out->dst = std::move(dst_crs);
  return true;
}

enum class OperationOutcome {
  kSelected,
  kBallparkOnly,
  kFactoryError,
};

/*
 * select_best_op: returns the best coordinate operation, choosing by
 * coordinate when has_coord is true (uses proj_get_suggested_operation; sx,sy
 * must be in source CRS axis order).
 *
 * kBallparkOnly means the candidate list held no operation the caller accepts,
 * kFactoryError means PROJ could not produce a list at all.
 */
PjPtr select_best_op(PJ_CONTEXT* ctx, PJ* src_crs, PJ* dst_crs, double sx,
                     double sy, bool has_coord, bool allow_ballpark,
                     bool discard_missing, OperationOutcome* outcome) {
  *outcome = OperationOutcome::kFactoryError;
  if (!src_crs || !dst_crs) return nullptr;

  const FactoryContextPtr factory(
      proj_create_operation_factory_context(ctx, nullptr));
  if (!factory) return nullptr;

  /* discard_missing=true mirrors proj_create_crs_to_crs's default behavior:
     ops requiring grids we don't have on disk are discarded, so the picked
     op (which might be ballpark) is always runnable. discard_missing=false
     surfaces every candidate including ones with missing grids — used by
     pw_grids_needed, pw_strict_check and the strict transform path to
     enumerate / verify the theoretically-best op. */
  proj_operation_factory_context_set_grid_availability_use(
      ctx, factory.get(),
      discard_missing ? PROJ_GRID_AVAILABILITY_DISCARD_OPERATION_IF_MISSING_GRID
                      : PROJ_GRID_AVAILABILITY_IGNORED);
  /* PARTIAL_INTERSECTION matches proj_create_crs_to_crs's internal default
     (crs_to_crs.cpp:568). It surfaces regionally-scoped grid ops (NADCON
     CONUS, NTv2 etc.) for points within their extent, which is the
     behavior we want for accurate transformations. */
  proj_operation_factory_context_set_spatial_criterion(
      ctx, factory.get(), PROJ_SPATIAL_CRITERION_PARTIAL_INTERSECTION);
  proj_operation_factory_context_set_allow_ballpark_transformations(
      ctx, factory.get(), allow_ballpark ? 1 : 0);

  const ObjListPtr list(
      proj_create_operations(ctx, src_crs, dst_crs, factory.get()));
  if (!list) return nullptr;

  const int count = proj_list_get_count(list.get());
  if (count <= 0) {
    *outcome = OperationOutcome::kBallparkOnly;
    return nullptr;
  }

  int index = 0;
  if (has_coord) {
    const PJ_COORD coord = proj_coord(sx, sy, 0.0, HUGE_VAL);
    const int suggested =
        proj_get_suggested_operation(ctx, list.get(), PJ_FWD, coord);
    if (suggested >= 0 && suggested < count) index = suggested;
  }
  PjPtr op(proj_list_get(ctx, list.get(), index));
  if (!op) return nullptr;

  /* When the caller forbade ballpark, double-check the chosen op too. */
  if (!allow_ballpark &&
      proj_coordoperation_has_ballpark_transformation(ctx, op.get()) == 1) {
    *outcome = OperationOutcome::kBallparkOnly;
    return nullptr;
  }

  *outcome = OperationOutcome::kSelected;
  return op;
}

void append_json_string(std::string* out, const char* value) {
  out->push_back('"');
  for (const char* p = value ? value : ""; *p != '\0'; ++p) {
    const unsigned char c = static_cast<unsigned char>(*p);
    if (c == '"' || c == '\\') {
      out->push_back('\\');
      out->push_back(static_cast<char>(c));
    } else if (c < 0x20) {
      char escaped[8];
      std::snprintf(escaped, sizeof(escaped), "\\u%04x", c);
      out->append(escaped);
    } else {
      out->push_back(static_cast<char>(c));
    }
  }
  out->push_back('"');
}

void append_grid(std::string* out, bool first, const char* short_name,
                 const char* full_name, const char* package_name,
                 const char* url, int available) {
  if (!first) out->push_back(',');
  out->append("{\"shortName\":");
  append_json_string(out, short_name);
  out->append(",\"fullName\":");
  append_json_string(out, full_name);
  out->append(",\"packageName\":");
  append_json_string(out, package_name);
  out->append(",\"url\":");
  append_json_string(out, url);
  out->append(",\"available\":");
  out->append(available ? "1" : "0");
  out->push_back('}');
}

bool contains(const std::vector<std::string>& names, const char* name) {
  for (const std::string& seen : names) {
    if (seen == name) return true;
  }
  return false;
}

/* PJ_TYPE as a name a caller can group or filter on without knowing PROJ. */
const char* crs_type_name(PJ_TYPE type) {
  switch (type) {
    case PJ_TYPE_GEOGRAPHIC_2D_CRS: return "geographic2d";
    case PJ_TYPE_GEOGRAPHIC_3D_CRS: return "geographic3d";
    case PJ_TYPE_PROJECTED_CRS: return "projected";
    case PJ_TYPE_VERTICAL_CRS: return "vertical";
    case PJ_TYPE_COMPOUND_CRS: return "compound";
    case PJ_TYPE_GEOCENTRIC_CRS: return "geocentric";
    default: return "other";
  }
}

char* duplicate(const std::string& text) {
  char* copy = static_cast<char*>(std::malloc(text.size() + 1));
  if (!copy) return nullptr;
  std::memcpy(copy, text.c_str(), text.size() + 1);
  return copy;
}

/*
 * prepare_operation: return the cached operation for this call, resolving it
 * when the key changed. On failure *out_code holds the pw_transform code.
 *
 * Selection is delegated to proj_create_crs_to_crs_from_pj, which is what
 * cs2cs uses, rather than picked here from proj_create_operations. Hand-rolled
 * selection kept disagreeing with cs2cs on real data, in both directions:
 *
 *   - Asking proj_get_suggested_operation for a list that includes ballpark
 *     hands back the ballpark entry whenever the point falls outside the
 *     accurate operation's declared extent, because a ballpark's extent is the
 *     whole world. EPSG:6667 -> EPSG:6695 at Naha silently passed the height
 *     through: its operation over jp_gsi_gsigeo2011.tif is scoped to
 *     "Japan - onshore mainland" while the grid itself covers Okinawa.
 *   - Simply preferring a non-ballpark candidate instead breaks the opposite
 *     case, where no accurate operation covers the point and ballpark is the
 *     right answer. EPSG:4202 -> EPSG:7844 at Sydney then moved by 130 m.
 *
 * proj_trans resolves this per point: it retries up to three candidates and,
 * when none of their areas match, falls back to the first operation needing no
 * grids (trans.cpp). Reimplementing that is not worth it, and any divergence
 * shows up as wrong coordinates rather than an error.
 *
 * Because PROJ chooses per point, the cache key is only
 * (src, dst, allow_ballpark) — no coordinate cell.
 *
 * Pipeline differs based on whether either CRS is vertical/compound:
 *   - has vertical: keep the raw op, manual axis swap (this avoids
 *     proj_normalize_for_visualization perturbing vgridshift candidate
 *     selection in PROJ 9.6–9.8).
 *   - no vertical: wrap with proj_normalize_for_visualization so callers
 *     can always pass (lon, lat) regardless of source / target CRS axis
 *     order. This also handles polar CRS (e.g. UPS) where both axes
 *     direction strings are "north" and our crs_is_north_east heuristic
 *     would otherwise misclassify them.
 */
const CachedOperation* prepare_operation(const char* src, const char* dst,
                                         bool allow_ballpark, int* out_code) {
  WrapperState& s = state();
  if (!s.ctx) {
    *out_code = 3;
    return nullptr;
  }

  OperationKey key;
  key.src = src;
  key.dst = dst;
  key.allow_ballpark = allow_ballpark;

  if (s.cached.op && s.cached.key == key) return &s.cached;
  s.cached.op.reset();

  CrsPair pair;
  if (!resolve_crs_pair(s.ctx.get(), src, dst, &pair)) {
    *out_code = 3;
    return nullptr;
  }

  /* Strict still enumerates first, so a missing grid is reported as such
     instead of being replaced by something less accurate. Enumerating as if
     every grid were present is what makes the difference between "we cannot
     do this at all" (6) and "fetch this grid and retry" (5) visible. */
  if (!allow_ballpark) {
    OperationOutcome outcome = OperationOutcome::kFactoryError;
    const PjPtr best =
        select_best_op(s.ctx.get(), pair.src.get(), pair.dst.get(), 0.0, 0.0,
                       /*has_coord=*/false, /*allow_ballpark=*/false,
                       /*discard_missing=*/false, &outcome);
    if (!best) {
      *out_code = (outcome == OperationOutcome::kBallparkOnly) ? 6 : 3;
      return nullptr;
    }
    if (proj_coordoperation_is_instantiable(s.ctx.get(), best.get()) != 1) {
      *out_code = 5;
      return nullptr;
    }
  }

  /* Prefer the CRS as written, which is what cs2cs hands to PROJ. Passing the
     compound that resolve_crs_pair promotes a vertical-only side into changes
     which operation PROJ picks: EPSG:6667 -> EPSG:6695 at Naha then loses its
     height correction entirely.

     The promotion is still needed in the other direction. PROJ cannot form an
     operation from a vertical-only source to a geographic CRS at all — cs2cs
     simply refuses EPSG:6695 -> EPSG:6667 — and supporting that inverse is a
     deliberate extension of ours. So fall back to the promoted pair only when
     PROJ produces nothing from the CRS as written. */
  const char* strict_options[] = {"ALLOW_BALLPARK=NO", nullptr};
  const char* const* options = allow_ballpark ? nullptr : strict_options;

  PjPtr raw;
  const PjPtr src_as_written(proj_create(s.ctx.get(), src));
  const PjPtr dst_as_written(proj_create(s.ctx.get(), dst));
  if (src_as_written && dst_as_written) {
    raw.reset(proj_create_crs_to_crs_from_pj(s.ctx.get(), src_as_written.get(),
                                             dst_as_written.get(), nullptr,
                                             options));
  }
  if (!raw) {
    raw.reset(proj_create_crs_to_crs_from_pj(
        s.ctx.get(), pair.src.get(), pair.dst.get(), nullptr, options));
  }
  if (!raw) {
    *out_code = 3;
    return nullptr;
  }

  if (crs_has_vertical(pair.src.get()) || crs_has_vertical(pair.dst.get())) {
    s.cached.op = std::move(raw);
    s.cached.swap_in = pair.swap_in;
    s.cached.swap_out = pair.swap_out;
  } else {
    PjPtr normalized(proj_normalize_for_visualization(s.ctx.get(), raw.get()));
    if (!normalized) {
      *out_code = 3;
      return nullptr;
    }
    s.cached.op = std::move(normalized);
    s.cached.swap_in = 0;
    s.cached.swap_out = 0;
  }
  s.cached.key = std::move(key);
  return &s.cached;
}

int transform_point(const char* src, const char* dst, bool allow_ballpark,
                    double* x, double* y, double* z) {
  int code = 3;
  const CachedOperation* entry =
      prepare_operation(src, dst, allow_ballpark, &code);
  if (!entry) return code;

  const double in_x = entry->swap_in ? *y : *x;
  const double in_y = entry->swap_in ? *x : *y;

  /* PROJ keeps errno on the PJ until something overwrites it, and this op
     outlives the call, so a previous point's failure would be read as this
     point's failure. */
  proj_errno_reset(entry->op.get());
  const PJ_COORD result = proj_trans(entry->op.get(), PJ_FWD,
                                     proj_coord(in_x, in_y, z ? *z : 0.0, HUGE_VAL));
  if (proj_errno(entry->op.get()) != 0) return 4;

  *x = entry->swap_out ? result.xyz.y : result.xyz.x;
  *y = entry->swap_out ? result.xyz.x : result.xyz.y;
  if (z) *z = result.xyz.z;
  return 0;
}

}  // namespace

int pw_init(const char* data_dir) {
  WrapperState& s = state();
  if (s.ctx) return 0;

  s.ctx.reset(proj_context_create());
  if (!s.ctx) return 1;

  s.data_dir = data_dir ? data_dir : "";
  apply_data_dir(s.ctx.get(), s.data_dir);
  return 0;
}

char* pw_grids_needed(const char* src, const char* dst, double x, double y,
                      int discard_missing, int* out_status) {
  if (!out_status) return nullptr;
  *out_status = -1;

  WrapperState& s = state();
  if (!src || !dst || !s.ctx) return nullptr;

  CrsPair pair;
  if (!resolve_crs_pair(s.ctx.get(), src, dst, &pair)) {
    *out_status = -2;
    return nullptr;
  }

  const bool has_coord = !std::isnan(x) && !std::isnan(y);
  /* Apply swap_in to put coord into source CRS axis order before passing
     to PROJ's suggested-operation API. */
  const double sx = pair.swap_in ? y : x;
  const double sy = pair.swap_in ? x : y;

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
  PjPtr op;
  ObjListPtr candidates;
  int candidate_count = 0;
  if (discard_missing) {
    const FactoryContextPtr factory(
        proj_create_operation_factory_context(s.ctx.get(), nullptr));
    if (factory) {
      proj_operation_factory_context_set_grid_availability_use(
          s.ctx.get(), factory.get(), PROJ_GRID_AVAILABILITY_IGNORED);
      proj_operation_factory_context_set_spatial_criterion(
          s.ctx.get(), factory.get(), PROJ_SPATIAL_CRITERION_PARTIAL_INTERSECTION);
      proj_operation_factory_context_set_allow_ballpark_transformations(
          s.ctx.get(), factory.get(), 0);
      candidates.reset(proj_create_operations(s.ctx.get(), pair.src.get(),
                                              pair.dst.get(), factory.get()));
      if (candidates) candidate_count = proj_list_get_count(candidates.get());
    }
    if (!candidates) {
      *out_status = -2;
      return nullptr;
    }
  } else {
    OperationOutcome outcome = OperationOutcome::kFactoryError;
    op = select_best_op(s.ctx.get(), pair.src.get(), pair.dst.get(), sx, sy,
                        has_coord, /*allow_ballpark=*/false,
                        /*discard_missing=*/false, &outcome);
    if (!op) {
      *out_status = outcome == OperationOutcome::kBallparkOnly ? -3 : -2;
      return nullptr;
    }
  }

  /* Up to N candidates' grids, deduped by shortName. */
  constexpr int kMaxCandidates = 8;
  if (candidate_count > kMaxCandidates) candidate_count = kMaxCandidates;

  /* The names PROJ reports are owned by the operation they came from, so they
     are copied before that operation is destroyed. */
  std::vector<std::string> seen;
  std::string json = "[";

  const auto append_grids_of = [&](PJ* operation) {
    const int grid_count =
        proj_coordoperation_get_grid_used_count(s.ctx.get(), operation);
    for (int i = 0; i < grid_count; ++i) {
      const char* short_name = nullptr;
      const char* full_name = nullptr;
      const char* package_name = nullptr;
      const char* url = nullptr;
      int direct_download = 0;
      int open_license = 0;
      int available = 0;
      if (!proj_coordoperation_get_grid_used(
              s.ctx.get(), operation, i, &short_name, &full_name, &package_name,
              &url, &direct_download, &open_license, &available)) {
        continue;
      }
      if (!short_name || contains(seen, short_name)) continue;

      append_grid(&json, seen.empty(), short_name, full_name, package_name, url,
                  available);
      seen.emplace_back(short_name);
    }
  };

  if (op) append_grids_of(op.get());

  for (int i = 0; i < candidate_count; ++i) {
    const PjPtr candidate(proj_list_get(s.ctx.get(), candidates.get(), i));
    if (!candidate) continue;
    append_grids_of(candidate.get());
  }

  json.push_back(']');

  char* result = duplicate(json);
  if (!result) return nullptr;

  *out_status = 0;
  return result;
}

/*
 * pw_describe: report the operation a transform would actually use, so callers
 * can show accuracy and grid requirements without running a transform and
 * without a second guess at operation selection. It resolves through the same
 * cache as pw_transform, so what it describes is what the next call runs.
 */
char* pw_describe(const char* src, const char* dst, double x, double y,
                  int allow_ballpark, int* out_status) {
  if (!out_status) return nullptr;
  *out_status = -1;
  if (!src || !dst) return nullptr;

  WrapperState& s = state();
  if (!s.ctx) return nullptr;

  /* Run the point through, then ask PROJ which operation it actually used.
     prepare_operation hands back a crs_to_crs object, which is a container of
     alternatives rather than a coordinate operation: asking it for a name or
     an accuracy yields nothing. Only after a transform does PROJ know which
     alternative applied at this point, which is also the honest answer to
     "what would a transform here do". */
  double px = x;
  double py = y;
  double pz = 0.0;
  const bool has_coord = !std::isnan(x) && !std::isnan(y);
  if (has_coord) {
    const int code = transform_point(src, dst, allow_ballpark != 0, &px, &py, &pz);
    if (code != 0 && code != 4) {
      *out_status = -2;
      return nullptr;
    }
  } else {
    int code = 0;
    if (!prepare_operation(src, dst, allow_ballpark != 0, &code)) {
      *out_status = -2;
      return nullptr;
    }
  }

  const CachedOperation* entry = &state().cached;
  if (!entry->op) {
    *out_status = -2;
    return nullptr;
  }

  const PjPtr used(proj_trans_get_last_used_operation(entry->op.get()));
  PJ* described = used ? used.get() : entry->op.get();

  const char* name = proj_get_name(described);
  const double accuracy = proj_coordoperation_get_accuracy(s.ctx.get(), described);
  const int ballpark =
      proj_coordoperation_has_ballpark_transformation(s.ctx.get(), described);

  std::string json = "{\"name\":";
  append_json_string(&json, name ? name : "");
  json += ",\"accuracy\":";
  if (accuracy < 0.0) {
    json += "null";
  } else {
    char buffer[64];
    std::snprintf(buffer, sizeof(buffer), "%.6g", accuracy);
    json += buffer;
  }
  json += ",\"ballpark\":";
  json += (ballpark == 1) ? "true" : "false";
  json += ",\"grids\":";

  /* Reuse the enumeration so the grid shape matches pw_grids_needed exactly;
     a caller comparing the two should never see two spellings of one grid. */
  int grid_status = 0;
  char* grids = pw_grids_needed(src, dst, x, y, 0, &grid_status);
  if (grids && grid_status == 0) {
    json += grids;
  } else {
    json += "[]";
  }
  std::free(grids);
  json.push_back('}');

  char* result = duplicate(json);
  if (!result) return nullptr;
  *out_status = 0;
  return result;
}

/* Bit flags for pw_list_crs's `kinds`; see src/proj_wasm.h. */
enum {
  kCrsHorizontal = 1,
  kCrsVertical = 2,
  kCrsThreeDimensional = 4,
};

/*
 * Names that mean "we could not identify the datum". PROJ carries them so the
 * database is complete; offering them to someone choosing a CRS is noise.
 */
bool is_unidentified_datum(const char* name) {
  if (!name) return true;
  return std::strncmp(name, "Unknown datum", 13) == 0 ||
         std::strncmp(name, "Unspecified datum", 17) == 0;
}

bool authority_allowed(const char* auth_name, const std::string& allowed) {
  if (allowed.empty()) return true;
  if (!auth_name) return false;
  /* Comma-separated, matched whole: "EPSG" must not match "EPSG_HISTORIC". */
  const std::string needle = std::string(",") + auth_name + ",";
  const std::string haystack = "," + allowed + ",";
  return haystack.find(needle) != std::string::npos;
}

char* pw_list_crs(double lon, double lat, int kinds, const char* authorities,
                  int* out_status) {
  if (!out_status) return nullptr;
  *out_status = -1;
  if (std::isnan(lon) || std::isnan(lat)) return nullptr;

  WrapperState& s = state();
  if (!s.ctx) return nullptr;

  std::vector<PJ_TYPE> types;
  if (kinds & kCrsHorizontal) {
    types.push_back(PJ_TYPE_GEOGRAPHIC_2D_CRS);
    types.push_back(PJ_TYPE_PROJECTED_CRS);
  }
  if (kinds & kCrsVertical) {
    types.push_back(PJ_TYPE_VERTICAL_CRS);
  }
  if (kinds & kCrsThreeDimensional) {
    types.push_back(PJ_TYPE_GEOGRAPHIC_3D_CRS);
    types.push_back(PJ_TYPE_COMPOUND_CRS);
  }
  if (types.empty()) return nullptr;

  PROJ_CRS_LIST_PARAMETERS* params = proj_get_crs_list_parameters_create();
  if (!params) {
    *out_status = -2;
    return nullptr;
  }
  params->types = types.data();
  params->typesCount = types.size();
  params->allow_deprecated = 0;
  /* A degenerate bounding box is the point itself; "area contains the box"
     then means "area contains the point", which is the question being asked. */
  params->bbox_valid = 1;
  params->west_lon_degree = lon;
  params->east_lon_degree = lon;
  params->south_lat_degree = lat;
  params->north_lat_degree = lat;
  params->crs_area_of_use_contains_bbox = 1;

  int count = 0;
  PROJ_CRS_INFO** list =
      proj_get_crs_info_list_from_database(s.ctx.get(), nullptr, params, &count);
  proj_get_crs_list_parameters_destroy(params);
  if (!list) {
    *out_status = -2;
    return nullptr;
  }

  const std::string allowed = authorities ? authorities : "";
  std::string json = "[";
  bool first = true;

  for (int i = 0; i < count; ++i) {
    const PROJ_CRS_INFO* info = list[i];
    if (!info || !info->auth_name || !info->code) continue;
    if (!authority_allowed(info->auth_name, allowed)) continue;
    if (is_unidentified_datum(info->name)) continue;

    if (!first) json.push_back(',');
    first = false;

    json += "{\"id\":";
    append_json_string(&json, (std::string(info->auth_name) + ":" + info->code).c_str());
    json += ",\"authority\":";
    append_json_string(&json, info->auth_name);
    json += ",\"code\":";
    append_json_string(&json, info->code);
    json += ",\"name\":";
    append_json_string(&json, info->name ? info->name : "");
    json += ",\"type\":";
    append_json_string(&json, crs_type_name(info->type));
    json += ",\"areaName\":";
    append_json_string(&json, info->area_name ? info->area_name : "");
    json += ",\"areaSquareDegrees\":";
    if (info->bbox_valid) {
      /* An area crossing the antimeridian is stored with east < west, so a
         plain subtraction makes a world-wide CRS look like the most local one
         available and sorts it to the top of a chooser. */
      double width = info->east_lon_degree - info->west_lon_degree;
      if (width < 0.0) width += 360.0;
      const double height = info->north_lat_degree - info->south_lat_degree;
      char buffer[64];
      std::snprintf(buffer, sizeof(buffer), "%.6g", std::fabs(width * height));
      json += buffer;
    } else {
      json += "null";
    }
    json.push_back('}');
  }

  proj_crs_info_list_destroy(list);
  json.push_back(']');

  char* result = duplicate(json);
  if (!result) return nullptr;
  *out_status = 0;
  return result;
}

int pw_strict_check(const char* src, const char* dst, double x, double y) {
  WrapperState& s = state();
  if (!src || !dst) return -1;
  if (!s.ctx) return -2;

  CrsPair pair;
  if (!resolve_crs_pair(s.ctx.get(), src, dst, &pair)) return -2;

  const bool has_coord = !std::isnan(x) && !std::isnan(y);
  const double sx = pair.swap_in ? y : x;
  const double sy = pair.swap_in ? x : y;

  /* strict_check verifies the best NON-ballpark op is instantiable;
     a 0 result means callers should treat the missing-grid condition as
     significant (silent ballpark substitution would otherwise hide it). */
  OperationOutcome outcome = OperationOutcome::kFactoryError;
  const PjPtr op =
      select_best_op(s.ctx.get(), pair.src.get(), pair.dst.get(), sx, sy,
                     has_coord, /*allow_ballpark=*/false,
                     /*discard_missing=*/false, &outcome);
  if (!op) return 0;

  return proj_coordoperation_is_instantiable(s.ctx.get(), op.get()) == 1 ? 1 : 0;
}

int pw_refresh_after_grid_write(void) {
  WrapperState& s = state();
  if (!s.ctx) return -1;

  /* Drop the cached operation first: it is a PJ that predates the writes and
     would otherwise keep running a pipeline built without the new grids, and
     it must not outlive the context it belongs to. */
  s.cached.op.reset();

  /* Recreate the whole context so every PROJ-side cache (database grid info,
     network chunk cache, internal proj.db query cache) is dropped. Phase 0
     testing showed proj_grid_cache_clear alone does NOT invalidate
     DatabaseContext::Private::cacheGridInfo_ (factory.cpp:3436,3552). */
  s.ctx.reset(proj_context_create());
  if (!s.ctx) return -2;

  apply_data_dir(s.ctx.get(), s.data_dir);
  return 0;
}

int pw_transform(const char* src, const char* dst, int allow_ballpark, double* x,
                 double* y, double* z) {
  if (!src || !dst || !x || !y) return 2;
  return transform_point(src, dst, allow_ballpark != 0, x, y, z);
}

int pw_transform_many(const char* src, const char* dst, int allow_ballpark,
                      double* xyz, int count) {
  if (!src || !dst || !xyz || count < 0) return -2;

  for (int i = 0; i < count; ++i) {
    double* point = xyz + static_cast<std::ptrdiff_t>(i) * 3;
    const int code =
        transform_point(src, dst, allow_ballpark != 0, point, point + 1,
                        point + 2);
    if (code == 0) continue;
    /* Code 4 is the only failure produced by this point's coordinate; the
       others describe the CRS pair, so they keep their pw_transform meaning. */
    return code == 4 ? i : -code;
  }
  return -1;
}
