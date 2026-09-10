#include <proj_wasm.h>

#include <cmath>
#include <string>

#include "harness.h"
#include "support.h"
#include "tests.h"

namespace {

constexpr int STRICT = 0;
constexpr int ALLOW_BALLPARK = 1;

// EPSG:31370 -> EPSG:4326 has three non-ballpark candidates; only the most
// accurate one (1.01 m) uses be_ign_bd72lb72_etrs89lb08.tif, which the test
// data directory holds back until the transition below.
constexpr const char* BE_SRC = "EPSG:31370";
constexpr const char* BE_DST = "EPSG:4326";
// Brussels, obtained by transforming (4.3517, 50.8503) with cs2cs.
constexpr pwtest::Coord BRUSSELS_LB72{148799.1416, 171100.0349, 0.0};

// Tight enough that a different operation cannot pass: the candidates for this
// pair differ by decimetres, which is ~1e-6 degrees.
constexpr double TOL_DEG = 1e-9;

pwtest::Coord transform(const char* src, const char* dst, int allow_ballpark,
                        pwtest::Coord input, int expected_rc) {
  pwtest::Coord result = input;
  PW_CHECK_INT(
      pw_transform(src, dst, allow_ballpark, &result.x, &result.y, &result.z),
      expected_rc);
  return result;
}

void check_close(const char* label, pwtest::Coord actual,
                 pwtest::Coord expected) {
  if (!(std::fabs(actual.x - expected.x) <= TOL_DEG &&
        std::fabs(actual.y - expected.y) <= TOL_DEG)) {
    PW_FAIL(std::string(label) + " = (" + pwtest::format_double(actual.x) +
            ", " + pwtest::format_double(actual.y) + "), expected (" +
            pwtest::format_double(expected.x) + ", " +
            pwtest::format_double(expected.y) + ") +/- " +
            pwtest::format_double(TOL_DEG));
  }
}

}  // namespace

// EPSG:4149 -> EPSG:4267 has no non-ballpark candidate at all, which is the
// condition code 6 describes.
void test_ballpark_only_pair() {
  const pwtest::Coord bern{7.4474, 46.9480, 0.0};

  transform("EPSG:4149", "EPSG:4267", STRICT, bern, 6);
  transform("EPSG:4149", "EPSG:4267", ALLOW_BALLPARK, bern, 0);
}

// One process, one wrapper context: the grid appears while the wrapper is
// already running and holds a cached operation, and every following call has to
// reflect the state at that moment.
void test_strict_transform_across_grid_arrival() {
  PW_CHECK_INT(pw_refresh_after_grid_write(), 0);

  transform(BE_SRC, BE_DST, STRICT, BRUSSELS_LB72, 5);

  const pwtest::Coord without_grid =
      transform(BE_SRC, BE_DST, ALLOW_BALLPARK, BRUSSELS_LB72, 0);
  check_close("ballpark-allowed result while the grid is absent", without_grid,
              pwtest::reference_transform(BE_SRC, BE_DST, BRUSSELS_LB72));

  // The operation just cached for the ballpark-allowed call is not the one
  // strict mode asks for, so the missing grid must still be reported.
  transform(BE_SRC, BE_DST, STRICT, BRUSSELS_LB72, 5);

  pwtest::link_deferred_grid();
  PW_CHECK_INT(pw_refresh_after_grid_write(), 0);

  const pwtest::Coord with_grid =
      transform(BE_SRC, BE_DST, STRICT, BRUSSELS_LB72, 0);
  check_close("strict result once the grid is present", with_grid,
              pwtest::reference_transform(BE_SRC, BE_DST, BRUSSELS_LB72));

  const double moved = std::fabs(with_grid.x - without_grid.x) +
                       std::fabs(with_grid.y - without_grid.y);
  if (!(moved > TOL_DEG)) {
    PW_FAIL(
        "the strict result equals the result taken without the grid, so the "
        "two calls did not use different operations (delta " +
        pwtest::format_double(moved) + ")");
  }
}
