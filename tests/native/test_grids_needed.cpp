#include <proj_wasm.h>

#include <cmath>
#include <cstdlib>
#include <string>
#include <vector>

#include "harness.h"
#include "support.h"
#include "tests.h"

namespace {

// The JS caller frees the returned string with Module._free, so the enumeration
// result has to be free()-able and carries no caller-supplied capacity.
std::vector<std::string> grid_short_names(const char* src, const char* dst,
                                          double x, double y,
                                          int discard_missing) {
  int status = 1;
  char* json = pw_grids_needed(src, dst, x, y, discard_missing, &status);
  if (status < 0 || json == nullptr) {
    std::free(json);
    PW_FAIL(std::string("pw_grids_needed(") + src + ", " + dst +
            ") status=" + std::to_string(status) +
            (json == nullptr ? ", json=null" : ""));
  }
  const std::string text(json);
  std::free(json);
  return pwtest::json_string_values(text, "shortName");
}

}  // namespace

// The regional operation that applies at the point decides which grids the
// caller has to fetch.
void test_grids_needed_names_per_region() {
  const std::vector<std::string> conus_expected = {
      "us_noaa_nadcon5_nad27_nad83_1986_conus.tif",
      "us_noaa_nadcon5_nad83_1986_nad83_harn_conus.tif",
      "us_noaa_nadcon5_nad83_harn_nad83_fbn_conus.tif",
      "us_noaa_nadcon5_nad83_fbn_nad83_2007_conus.tif",
      "us_noaa_nadcon5_nad83_2007_nad83_2011_conus.tif",
  };
  const std::vector<std::string> alaska_expected = {
      "us_noaa_nadcon5_nad27_nad83_1986_alaska.tif",
      "us_noaa_nadcon5_nad83_1986_nad83_1992_alaska.tif",
      "us_noaa_nadcon5_nad83_1992_nad83_2007_alaska.tif",
      "us_noaa_nadcon5_nad83_2007_nad83_2011_alaska.tif",
  };

  PW_CHECK_STRING_LIST(
      "conus grids",
      grid_short_names("EPSG:4267", "EPSG:6318", -100.0, 40.0, 0),
      conus_expected);
  PW_CHECK_STRING_LIST(
      "alaska grids",
      grid_short_names("EPSG:4267", "EPSG:6318", -150.0, 60.0, 0),
      alaska_expected);
}

// EPSG:4979 -> EPSG:3855 has two non-ballpark candidates and both reference a
// grid, so the deduplication actually compares names taken from a candidate
// that has already been destroyed. Repeating the call exercises that compare
// often enough for AddressSanitizer to see a read of freed memory.
void test_grids_needed_dedup_is_stable_across_repeats() {
  const std::vector<std::string> expected = {
      "us_nga_egm08_25.tif",
      "Und_min1x1_egm2008_isw=82_WGS84_TideFree",
  };
  const double no_coord = std::nan("");

  std::vector<std::string> first;
  for (int i = 0; i < 256; ++i) {
    std::vector<std::string> names =
        grid_short_names("EPSG:4979", "EPSG:3855", no_coord, no_coord, 1);
    if (i == 0) {
      PW_CHECK_STRING_LIST("egm2008 grids", names, expected);
      first = names;
      continue;
    }
    PW_CHECK_STRING_LIST("egm2008 grids on repeat", names, first);
  }
}
