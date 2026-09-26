#include <proj_wasm.h>

#include "harness.h"
#include "support.h"
#include "tests.h"

namespace {

// EPSG:4267 -> EPSG:6318 resolves to NAD27_TO_NAD83_2011_CONUS inside the
// contiguous US and to NAD27_TO_NAD83_2011_ALASKA in Alaska, so the two points
// below need different operations for the same CRS pair.
constexpr const char* SRC = "EPSG:4267";
constexpr const char* DST = "EPSG:6318";
constexpr pwtest::Coord CONUS{-100.0, 40.0, 0.0};
constexpr pwtest::Coord ALASKA{-150.0, 60.0, 0.0};

// Both paths run the same NADCON5 chain, so agreement is far tighter than this;
// the regional operations differ by metres, which is ~1e-5 degrees.
constexpr double TOL_DEG = 1e-9;

constexpr int ALLOW_BALLPARK = 1;

pwtest::Coord transform(pwtest::Coord input) {
  pwtest::Coord result = input;
  PW_CHECK_INT(
      pw_transform(SRC, DST, ALLOW_BALLPARK, &result.x, &result.y, &result.z),
      0);
  return result;
}

void check_matches_reference(const char* label, pwtest::Coord actual,
                             pwtest::Coord input) {
  const pwtest::Coord expected = pwtest::reference_transform(SRC, DST, input);
  if (!(actual.x - expected.x >= -TOL_DEG && actual.x - expected.x <= TOL_DEG &&
        actual.y - expected.y >= -TOL_DEG && actual.y - expected.y <= TOL_DEG)) {
    PW_FAIL(std::string(label) + " = (" + pwtest::format_double(actual.x) +
            ", " + pwtest::format_double(actual.y) + "), expected (" +
            pwtest::format_double(expected.x) + ", " +
            pwtest::format_double(expected.y) + ") +/- " +
            pwtest::format_double(TOL_DEG));
  }
}

}  // namespace

// The cached operation survives across calls, so the point that follows a
// different point in the same process must still get the operation that applies
// where it is.
void test_operation_selected_per_coordinate_cell() {
  PW_CHECK_INT(pw_refresh_after_grid_write(), 0);

  const pwtest::Coord conus_cold = transform(CONUS);
  check_matches_reference("conus after cache reset", conus_cold, CONUS);

  const pwtest::Coord alaska_warm = transform(ALASKA);
  check_matches_reference("alaska after conus", alaska_warm, ALASKA);

  const pwtest::Coord conus_warm = transform(CONUS);
  check_matches_reference("conus after alaska", conus_warm, CONUS);

  PW_CHECK_INT(pw_refresh_after_grid_write(), 0);
  const pwtest::Coord alaska_cold = transform(ALASKA);
  PW_CHECK_SAME_DOUBLE(alaska_warm.x, alaska_cold.x);
  PW_CHECK_SAME_DOUBLE(alaska_warm.y, alaska_cold.y);
  PW_CHECK_SAME_DOUBLE(alaska_warm.z, alaska_cold.z);
}
