#include <proj_wasm.h>

#include <cmath>
#include <filesystem>
#include <string>

#include "harness.h"
#include "support.h"
#include "tests.h"

namespace fs = std::filesystem;

namespace {

constexpr int STRICT = 0;
constexpr double TOL_DEG = 1e-9;
constexpr double TOL_M = 1e-4;

// A Florida East (ftUS) point on NAVD88: the operation PROJ runs needs GEOID18
// and a chain of NADCON5 grids, and drops to a geoid-less one when any of them
// is not mounted.
constexpr const char* FL_SRC = "EPSG:2236+6360";
constexpr const char* FL_DST = "EPSG:4979";
constexpr pwtest::Coord FL_POINT{940505.12, 681727.461, 24.978};
constexpr const char* FL_GEOID = "us_noaa_g2018u0.tif";

// EGM2008 height: the best operation names the 1x1 grid, which no data set
// ships; native PROJ falls back to the 2.5x2.5 one.
constexpr const char* EGM08_SRC = "EPSG:32654+3855";
constexpr pwtest::Coord EGM08_POINT{380000.0, 3950000.0, 50.0};

void check_matches_reference(const char* label, const char* src,
                             pwtest::Coord input) {
  pwtest::Coord result = input;
  PW_CHECK_INT(pw_transform(src, FL_DST, STRICT, &result.x, &result.y, &result.z), 0);
  const pwtest::Coord expected = pwtest::reference_transform(src, FL_DST, input);
  if (!(std::fabs(result.x - expected.x) <= TOL_DEG &&
        std::fabs(result.y - expected.y) <= TOL_DEG &&
        std::fabs(result.z - expected.z) <= TOL_M)) {
    PW_FAIL(std::string(label) + " = (" + pwtest::format_double(result.x) +
            ", " + pwtest::format_double(result.y) + ", " +
            pwtest::format_double(result.z) + "), expected (" +
            pwtest::format_double(expected.x) + ", " +
            pwtest::format_double(expected.y) + ", " +
            pwtest::format_double(expected.z) + ")");
  }
}

}  // namespace

// With a catalog, strict wants what native PROJ runs with every catalog grid
// on disk, at the point, and names the unmounted grids it needs.
void test_catalog_strict_selection() {
  std::string names;
  for (const auto& entry : fs::directory_iterator(PW_TEST_DATA_DIR)) {
    const std::string name = entry.path().filename().string();
    if (name != "proj.db") names += name + "\n";
  }
  const std::string catalog = std::string(PW_TEST_WORK_DIR) + "/catalog";
  fs::remove_all(catalog);
  PW_CHECK_INT(pw_set_grid_catalog(catalog.c_str(), names.c_str()), 0);

  check_matches_reference("EGM2008 through the 2.5x2.5 grid", EGM08_SRC,
                          EGM08_POINT);

  const fs::path geoid = fs::path(pwtest::data_dir()) / FL_GEOID;
  fs::remove(geoid);
  PW_CHECK_INT(pw_refresh_after_grid_write(), 0);

  pwtest::Coord point = FL_POINT;
  PW_CHECK_INT(pw_transform(FL_SRC, FL_DST, STRICT, &point.x, &point.y, &point.z), 5);
  const std::string missing = pw_last_missing();
  if (missing.find(std::string("\"") + FL_GEOID + "\"") == std::string::npos ||
      missing.find("\"x\":940505.12") == std::string::npos) {
    PW_FAIL("pw_last_missing does not name the geoid at the point: " + missing);
  }
  PW_CHECK_INT(pw_strict_check(FL_SRC, FL_DST, FL_POINT.x, FL_POINT.y), 0);

  fs::create_symlink(fs::absolute(fs::path(PW_TEST_DATA_DIR) / FL_GEOID), geoid);
  PW_CHECK_INT(pw_refresh_after_grid_write(), 0);
  PW_CHECK_INT(pw_strict_check(FL_SRC, FL_DST, FL_POINT.x, FL_POINT.y), 1);
  check_matches_reference("Florida once GEOID18 is mounted", FL_SRC, FL_POINT);
}

// GDALWKT1:3D:<def> is the CRS GDAL builds from GeoTIFF keys (WKT1, no area
// of use) promoted to 3D. EPSG:3490 (California zone 1, ftUS) at a point south
// of its area: PROJ picks a different NAD83(NSRS2007) -> WGS 84 operation for
// the 3D CRS with and without the area. Reference: the WKT C++ sc-tilers built.
void test_gdal_wkt1_prefix_drops_area_of_use() {
  constexpr pwtest::Coord SIGN{6421332.4, 1097545.7, 358.7};
  const auto run = [&](const char* src) {
    pwtest::Coord c = SIGN;
    PW_CHECK_INT(pw_transform(src, "EPSG:4979", 1, &c.x, &c.y, &c.z), 0);
    return c;
  };
  const pwtest::Coord plain = run("EPSG:3490");
  const pwtest::Coord wkt1 = run("GDALWKT1:3D:EPSG:3490");
  // cs2cs with the C++ WKT gives (37.842689899, -122.485375215).
  if (!(std::fabs(wkt1.x - -122.485375215) < 1e-8 && std::fabs(wkt1.y - 37.842689899) < 1e-8)) {
    PW_FAIL("GDALWKT1:3D:EPSG:3490 = (" + pwtest::format_double(wkt1.x) + ", " +
            pwtest::format_double(wkt1.y) + "), expected the C++ CRS result");
  }
  if (!(std::fabs(plain.x - -122.485362034) < 1e-8)) {
    PW_FAIL("EPSG:3490 no longer takes the other operation: " + pwtest::format_double(plain.x));
  }
}
