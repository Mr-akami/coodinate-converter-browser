#include <proj_wasm.h>

#include <cmath>
#include <cstdlib>
#include <string>

#include "harness.h"
#include "tests.h"

namespace {

std::string list_at(double lon, double lat, int kinds, const char* authorities) {
  int status = -1;
  char* json = pw_list_crs(lon, lat, kinds, authorities, &status);
  PW_CHECK_INT(status, 0);
  const std::string result(json ? json : "");
  std::free(json);
  return result;
}

}  // namespace

/*
 * The list exists so an application can offer a user the coordinate systems
 * that actually apply where they are working. Its value is in what it leaves
 * out, so the assertions are mostly about exclusion: a system whose area of
 * use is on the other side of the world is worse than no suggestion at all.
 */
void test_list_crs_is_local_to_the_point() {
  const std::string tokyo = list_at(139.7671, 35.6812, 1, "EPSG");

  // Japan Plane Rectangular CS IX covers Tokyo.
  PW_CHECK(tokyo.find("\"EPSG:6677\"") != std::string::npos);
  // CS I covers Kyushu and Okinawa, well away from Tokyo.
  PW_CHECK(tokyo.find("\"EPSG:6669\"") == std::string::npos);
  // A British grid has no business being offered in Japan.
  PW_CHECK(tokyo.find("\"EPSG:27700\"") == std::string::npos);

  const std::string london = list_at(-0.1278, 51.5074, 1, "EPSG");
  PW_CHECK(london.find("\"EPSG:27700\"") != std::string::npos);
  PW_CHECK(london.find("\"EPSG:6677\"") == std::string::npos);
}

void test_list_crs_separates_vertical_from_horizontal() {
  const std::string horizontal = list_at(139.7671, 35.6812, 1, "EPSG");
  const std::string vertical = list_at(139.7671, 35.6812, 2, "EPSG,CZM");

  PW_CHECK(horizontal.find("\"vertical\"") == std::string::npos);
  PW_CHECK(vertical.find("\"vertical\"") != std::string::npos);
  // The customised authority carries the JGD2024 vertical CRS, and a caller
  // asking for it by name must actually get it.
  PW_CHECK(vertical.find("\"CZM:JGD2024\"") != std::string::npos);
}

void test_list_crs_filters_by_authority() {
  const std::string epsg_only = list_at(139.7671, 35.6812, 2, "EPSG");
  PW_CHECK(epsg_only.find("\"CZM:") == std::string::npos);

  // No filter means every authority the database holds.
  const std::string everything = list_at(139.7671, 35.6812, 2, nullptr);
  PW_CHECK(everything.size() > epsg_only.size());
}

void test_list_crs_carries_what_a_chooser_needs() {
  const std::string tokyo = list_at(139.7671, 35.6812, 1, "EPSG");

  PW_CHECK(tokyo.find("\"name\":") != std::string::npos);
  PW_CHECK(tokyo.find("\"type\":\"projected\"") != std::string::npos);
  PW_CHECK(tokyo.find("\"areaName\":") != std::string::npos);
  // The area is what makes "most local first" possible, so it must be there
  // and must be a number rather than null for a CRS with a declared extent.
  PW_CHECK(tokyo.find("\"areaSquareDegrees\":null") == std::string::npos);
}

void test_list_crs_rejects_a_point_it_cannot_use() {
  int status = 0;
  char* json = pw_list_crs(NAN, 35.0, 1, "EPSG", &status);
  PW_CHECK_INT(status, -1);
  PW_CHECK(json == nullptr);

  // Asking for nothing is a caller error, not an empty list.
  status = 0;
  json = pw_list_crs(139.0, 35.0, 0, "EPSG", &status);
  PW_CHECK_INT(status, -1);
  PW_CHECK(json == nullptr);
}

/*
 * An area of use that crosses the antimeridian is stored with its eastern
 * bound numerically below its western one. Subtracting them gives a small
 * negative width, which makes a world-wide CRS look more local than a
 * prefecture and sorts it to the top of a chooser — the exact opposite of
 * what the ordering is for.
 */
void test_list_crs_measures_areas_that_cross_the_antimeridian() {
  const std::string tokyo = list_at(139.7671, 35.6812, 1, "EPSG");

  // "WGS 84 / Equal Earth Asia-Pacific" spans the world.
  const std::size_t at = tokyo.find("\"EPSG:8859\"");
  if (at == std::string::npos) return;  // not offered here; nothing to check

  const std::size_t area_at = tokyo.find("\"areaSquareDegrees\":", at);
  PW_CHECK(area_at != std::string::npos);
  const double area = std::atof(tokyo.c_str() + area_at + 20);
  // A world-wide area is tens of thousands of square degrees, not single
  // digits. Anything under a thousand means the width wrapped.
  PW_CHECK(area > 1000.0);
}
