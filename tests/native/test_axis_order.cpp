#include <proj_wasm.h>

#include "harness.h"
#include "tests.h"

namespace {

// tests/comparison.js:4-11, the tolerances the browser suite applies to the
// same reference rows.
constexpr double TOL_GEOGRAPHIC_DEG = 1e-6;
constexpr double TOL_PROJECTED_M = 0.01;
constexpr double TOL_HEIGHT_M = 0.01;

// src/proj-worker.js keeps ballpark operations allowed in this phase, so these
// cases observe the mode the browser actually uses.
constexpr int ALLOW_BALLPARK = 1;

}  // namespace

// tests/reference.csv "JP:Tokyo Datum->WGS84".
void test_axis_order_geographic() {
  double x = 139.7671;
  double y = 35.6812;
  double z = 0.0;

  PW_CHECK_INT(
      pw_transform("EPSG:4301", "EPSG:4326", ALLOW_BALLPARK, &x, &y, &z), 0);
  PW_CHECK_NEAR(x, 139.7638660290, TOL_GEOGRAPHIC_DEG);
  PW_CHECK_NEAR(y, 35.6844388831, TOL_GEOGRAPHIC_DEG);
  PW_CHECK_NEAR(z, 0.0, TOL_HEIGHT_M);
}

// tests/reference.csv "US:NYC WGS84->UTM18N".
void test_axis_order_projected() {
  double x = -74.0060;
  double y = 40.7128;
  double z = 0.0;

  PW_CHECK_INT(
      pw_transform("EPSG:4326", "EPSG:32618", ALLOW_BALLPARK, &x, &y, &z), 0);
  PW_CHECK_NEAR(x, 583959.3723240850, TOL_PROJECTED_M);
  PW_CHECK_NEAR(y, 4507350.9982433207, TOL_PROJECTED_M);
  PW_CHECK_NEAR(z, 0.0, TOL_HEIGHT_M);
}

// tests/reference.csv "GL:UPS-South WGS84->32761". Both axes of EPSG:32761 are
// declared "north", which an axis-direction comparison cannot order.
void test_axis_order_polar() {
  double x = 0.0;
  double y = -85.0;
  double z = 0.0;

  PW_CHECK_INT(
      pw_transform("EPSG:4326", "EPSG:32761", ALLOW_BALLPARK, &x, &y, &z), 0);
  PW_CHECK_NEAR(x, 2000000.0000000000, TOL_PROJECTED_M);
  PW_CHECK_NEAR(y, 2555457.3913826775, TOL_PROJECTED_M);
  PW_CHECK_NEAR(z, 0.0, TOL_HEIGHT_M);
}

// tests/reference.csv "JP:GSIGEO2011 Tokyo Z=76". EPSG:6697 is a compound CRS.
void test_axis_order_compound() {
  double x = 139.7671;
  double y = 35.6812;
  double z = 76.0;

  PW_CHECK_INT(
      pw_transform("EPSG:6667", "EPSG:6697", ALLOW_BALLPARK, &x, &y, &z), 0);
  PW_CHECK_NEAR(x, 139.7671000000, TOL_GEOGRAPHIC_DEG);
  PW_CHECK_NEAR(y, 35.6812000000, TOL_GEOGRAPHIC_DEG);
  PW_CHECK_NEAR(z, 39.3376352532, TOL_HEIGHT_M);
}

// tests/reference.csv "US:NYC WGS84->EGM96". EPSG:5773 is vertical-only, so the
// wrapper has to promote it to a compound CRS before selecting an operation.
void test_axis_order_vertical_only() {
  double x = -74.0060;
  double y = 40.7128;
  double z = 30.0;

  PW_CHECK_INT(
      pw_transform("EPSG:4979", "EPSG:5773", ALLOW_BALLPARK, &x, &y, &z), 0);
  PW_CHECK_NEAR(x, -74.0060000000, TOL_GEOGRAPHIC_DEG);
  PW_CHECK_NEAR(y, 40.7128000000, TOL_GEOGRAPHIC_DEG);
  PW_CHECK_NEAR(z, 62.7601506221, TOL_HEIGHT_M);
}
