#include <proj.h>
#include <proj_wasm.h>

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <exception>

#include "harness.h"
#include "support.h"
#include "tests.h"

int main() {
  // The dev shell exports PROJ_LIB, and PROJ_DATA may be set by the caller.
  // The tests must see only the data directory they build themselves.
  unsetenv("PROJ_DATA");
  unsetenv("PROJ_LIB");

  char expected_version[32];
  std::snprintf(expected_version, sizeof(expected_version), "%d.%d.%d",
                PROJ_VERSION_MAJOR, PROJ_VERSION_MINOR, PROJ_VERSION_PATCH);
  if (std::strcmp(proj_info().version, expected_version) != 0) {
    std::fprintf(stderr,
                 "linked PROJ reports %s but the submodule headers say %s\n",
                 proj_info().version, expected_version);
    return 1;
  }

  try {
    pwtest::prepare_data_dir();
  } catch (const std::exception& error) {
    std::fprintf(stderr, "%s\n", error.what());
    return 1;
  }

  const int rc = pw_init(pwtest::data_dir().c_str());
  if (rc != 0) {
    std::fprintf(stderr, "pw_init failed: %d\n", rc);
    return 1;
  }

  // test_strict_transform_across_grid_arrival adds the held-back grid to the
  // data directory, so it runs last.
  const pwtest::TestCase cases[] = {
      {"axis_order_geographic", test_axis_order_geographic},
      {"axis_order_projected", test_axis_order_projected},
      {"axis_order_polar", test_axis_order_polar},
      {"axis_order_compound", test_axis_order_compound},
      {"axis_order_vertical_only", test_axis_order_vertical_only},
      {"operation_selected_per_coordinate_cell",
       test_operation_selected_per_coordinate_cell},
      {"grids_needed_names_per_region", test_grids_needed_names_per_region},
      {"grids_needed_dedup_is_stable_across_repeats",
       test_grids_needed_dedup_is_stable_across_repeats},
      {"transform_many_agrees_with_repeated_transform",
       test_transform_many_agrees_with_repeated_transform},
      {"transform_many_reports_first_failing_point",
       test_transform_many_reports_first_failing_point},
      {"transform_many_reports_pair_level_failure",
       test_transform_many_reports_pair_level_failure},
      {"ballpark_only_pair", test_ballpark_only_pair},
      {"strict_transform_across_grid_arrival",
       test_strict_transform_across_grid_arrival},
      {"geoid_applies_outside_declared_extent",
       test_geoid_applies_outside_declared_extent},
      {"vertical_only_source_round_trips",
       test_vertical_only_source_round_trips},
  };

  return pwtest::run(cases, sizeof(cases) / sizeof(cases[0]));
}
