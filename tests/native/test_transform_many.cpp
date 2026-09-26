#include <proj_wasm.h>

#include <string>
#include <vector>

#include "harness.h"
#include "tests.h"

namespace {

constexpr int STRICT = 0;
constexpr int ALLOW_BALLPARK = 1;

// pw_transform_many reports the index of the first failing point, so success
// cannot be reported as 0.
constexpr int MANY_OK = -1;

std::vector<double> transform_each(const char* src, const char* dst,
                                   std::vector<double> xyz) {
  for (std::size_t i = 0; i + 2 < xyz.size(); i += 3) {
    PW_CHECK_INT(pw_transform(src, dst, ALLOW_BALLPARK, &xyz[i], &xyz[i + 1],
                              &xyz[i + 2]),
                 0);
  }
  return xyz;
}

}  // namespace

// The batch call must resolve the operation per point exactly like the
// single-point call does, including across points that fall in different
// regions of the same CRS pair.
void test_transform_many_agrees_with_repeated_transform() {
  const char* src = "EPSG:4267";
  const char* dst = "EPSG:6318";
  const std::vector<double> input = {
      -100.0, 40.0,  0.0,   // NADCON5 CONUS
      -150.0, 60.0,  0.0,   // NADCON5 Alaska
      -99.2,  39.4,  0.0,   // CONUS again, different 1-degree cell
  };

  PW_CHECK_INT(pw_refresh_after_grid_write(), 0);
  const std::vector<double> expected = transform_each(src, dst, input);

  PW_CHECK_INT(pw_refresh_after_grid_write(), 0);
  std::vector<double> actual = input;
  PW_CHECK_INT(pw_transform_many(src, dst, ALLOW_BALLPARK, actual.data(),
                                 static_cast<int>(actual.size() / 3)),
               MANY_OK);

  for (std::size_t i = 0; i < expected.size(); ++i) {
    if (actual[i] != expected[i]) {
      PW_FAIL("element " + std::to_string(i) + " = " +
              pwtest::format_double(actual[i]) + ", expected " +
              pwtest::format_double(expected[i]));
    }
  }
}

// Latitude 100 is rejected by PROJ's forward preparation
// (third_party/proj/src/fwd.cpp:58-65), which is what a per-point failure looks
// like to the wrapper.
void test_transform_many_reports_first_failing_point() {
  const char* src = "EPSG:4326";
  const char* dst = "EPSG:32618";
  const std::vector<double> input = {
      -74.0060, 40.7128, 0.0,
      0.0,      100.0,   0.0,
      -73.9000, 40.8000, 0.0,
  };

  PW_CHECK_INT(pw_refresh_after_grid_write(), 0);
  double first_x = input[0];
  double first_y = input[1];
  double first_z = input[2];
  PW_CHECK_INT(
      pw_transform(src, dst, ALLOW_BALLPARK, &first_x, &first_y, &first_z), 0);
  double bad_x = input[3];
  double bad_y = input[4];
  double bad_z = input[5];
  PW_CHECK_INT(pw_transform(src, dst, ALLOW_BALLPARK, &bad_x, &bad_y, &bad_z),
               4);

  PW_CHECK_INT(pw_refresh_after_grid_write(), 0);
  std::vector<double> actual = input;
  PW_CHECK_INT(pw_transform_many(src, dst, ALLOW_BALLPARK, actual.data(),
                                 static_cast<int>(actual.size() / 3)),
               1);

  PW_CHECK_SAME_DOUBLE(actual[0], first_x);
  PW_CHECK_SAME_DOUBLE(actual[1], first_y);
  PW_CHECK_SAME_DOUBLE(actual[2], first_z);
  for (std::size_t i = 3; i < input.size(); ++i) {
    PW_CHECK_SAME_DOUBLE(actual[i], input[i]);
  }
}

// A failure that belongs to the CRS pair rather than to one point keeps its
// pw_transform code, negated, so the caller can tell it from a point index.
// EPSG:4149 -> EPSG:4267 has no non-ballpark candidate, which is code 6.
void test_transform_many_reports_pair_level_failure() {
  const std::vector<double> input = {
      7.4474, 46.9480, 0.0,
      7.5000, 46.9000, 0.0,
  };

  PW_CHECK_INT(pw_refresh_after_grid_write(), 0);
  std::vector<double> actual = input;
  PW_CHECK_INT(pw_transform_many("EPSG:4149", "EPSG:4267", STRICT, actual.data(),
                                 static_cast<int>(actual.size() / 3)),
               -6);

  for (std::size_t i = 0; i < input.size(); ++i) {
    PW_CHECK_SAME_DOUBLE(actual[i], input[i]);
  }
}
