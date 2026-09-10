#pragma once

#include <string>
#include <vector>

namespace pwtest {

// Held back from the data directory at startup so the strict-path test can
// observe the transition from "grid absent" to "grid present" in one process.
extern const char* const DEFERRED_GRID;

struct Coord {
  double x;
  double y;
  double z;
};

const std::string& data_dir();
void prepare_data_dir();
void link_deferred_grid();

// Independent expectation for operation selection: a private PJ_CONTEXT over
// the same data directory, built with proj_create_crs_to_crs. Only valid for
// CRS pairs without a vertical component, because the wrapper deliberately
// skips proj_normalize_for_visualization on those.
Coord reference_transform(const char* src, const char* dst, Coord input);

// Extracts the values a JSON object list carries for one string field, so the
// tests can assert on grid names as observation units instead of searching the
// whole document. Grid names are ASCII, so \u escapes are not decoded.
std::vector<std::string> json_string_values(const std::string& json,
                                            const std::string& field);

}  // namespace pwtest
