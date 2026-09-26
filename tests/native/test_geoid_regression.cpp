#include <proj_wasm.h>

#include "harness.h"
#include "tests.h"

// EPSG:6667 -> EPSG:6695 resolves to one accurate operation, an inverse
// vgridshift over jp_gsi_gsigeo2011.tif. That operation is scoped to
// "Japan - onshore mainland" (30.94N and north) although its grid also covers
// Okinawa, and cs2cs applies it there. Naha therefore sits outside the
// declared extent while still having a correct answer, which is exactly the
// case where a ballpark candidate wins the per-point suggestion and the
// height passes through unchanged. Tokyo is inside the extent and would not
// catch that.
void test_geoid_applies_outside_declared_extent() {
  struct Case {
    const char* label;
    double x;
    double y;
    double z;
    double want_z;
  };
  // Values from cs2cs 9.7.1 over the same data directory.
  const Case cases[] = {
      {"tokyo", 139.7671, 35.6812, 76.0, 39.3376352532},
      {"naha", 127.6811, 26.2124, 50.0, 18.5215771571},
  };

  for (const Case& c : cases) {
    double x = c.x;
    double y = c.y;
    double z = c.z;
    const int rc = pw_transform("EPSG:6667", "EPSG:6695", 1, &x, &y, &z);
    PW_CHECK_INT(rc, 0);
    PW_CHECK_NEAR(x, c.x, 1e-9);
    PW_CHECK_NEAR(y, c.y, 1e-9);
    PW_CHECK_NEAR(z, c.want_z, 1e-6);
  }
}

// The inverse direction has no cs2cs equivalent: PROJ cannot form an
// operation from a vertical-only source to a geographic CRS, and cs2cs
// refuses EPSG:6695 -> EPSG:6667 outright. Supporting it is an extension of
// ours, and it only works because the wrapper falls back to the compound it
// promotes a vertical-only side into. Round trips in the browser suite depend
// on it, so it is guarded here rather than only there.
void test_vertical_only_source_round_trips() {
  const double lon = 139.7671;
  const double lat = 35.6812;
  const double ellipsoidal = 76.0;

  double x = lon;
  double y = lat;
  double z = ellipsoidal;
  PW_CHECK_INT(pw_transform("EPSG:6667", "EPSG:6695", 1, &x, &y, &z), 0);
  PW_CHECK_NEAR(z, 39.3376352532, 1e-6);

  PW_CHECK_INT(pw_transform("EPSG:6695", "EPSG:6667", 1, &x, &y, &z), 0);
  PW_CHECK_NEAR(x, lon, 1e-9);
  PW_CHECK_NEAR(y, lat, 1e-9);
  PW_CHECK_NEAR(z, ellipsoidal, 1e-6);
}
