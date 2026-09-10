#include <proj_wasm.h>

#include <cstdlib>
#include <cstring>
#include <cstdio>
#include <string>

#include "harness.h"
#include "support.h"
#include "tests.h"

// describe() exists so a caller can see accuracy and grid requirements without
// running a transform. It must report the operation the next transform would
// actually use, so it resolves through the same cache rather than guessing
// again.
void test_describe_reports_operation() {
  int status = -1;
  char* json = pw_describe("EPSG:4326", "EPSG:6677", 139.7671, 35.6812, 1, &status);
  PW_CHECK_INT(status, 0);
  PW_CHECK(json != nullptr);
  const std::string projected(json ? json : "");
  std::free(json);

  PW_CHECK(projected.find("\"name\":") != std::string::npos);
  PW_CHECK(projected.find("\"accuracy\":") != std::string::npos);
  PW_CHECK(projected.find("\"ballpark\":") != std::string::npos);
  PW_CHECK(projected.find("\"grids\":[") != std::string::npos);
  // The name comes from the operation PROJ actually applied, not from the
  // crs_to_crs container, which has none.
  PW_CHECK(projected.find("\"name\":\"\"") == std::string::npos);

  // A pair with no datum shift between its datums is a ballpark, and saying so
  // is the whole point of the flag.
  status = -1;
  json = pw_describe("EPSG:4202", "EPSG:7844", 151.2093, -33.8688, 1, &status);
  PW_CHECK_INT(status, 0);
  const std::string ballpark(json ? json : "");
  std::free(json);
  PW_CHECK(ballpark.find("\"ballpark\":true") != std::string::npos);

  // An unresolvable CRS is reported, not crashed on.
  status = 0;
  json = pw_describe("EPSG:4326", "EPSG:999999", 0.0, 0.0, 1, &status);
  PW_CHECK_INT(status, -2);
  PW_CHECK(json == nullptr);
}
