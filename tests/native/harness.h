#pragma once

#include <cstddef>
#include <stdexcept>
#include <string>
#include <vector>

namespace pwtest {

struct TestCase {
  const char* name;
  void (*fn)();
};

class CheckFailed : public std::runtime_error {
 public:
  explicit CheckFailed(const std::string& what) : std::runtime_error(what) {}
};

[[noreturn]] void fail(const char* file, int line, const std::string& detail);
void check_string_list(const char* file, int line, const char* label,
                       std::vector<std::string> actual,
                       std::vector<std::string> expected);
std::string format_double(double value);
int run(const TestCase* cases, std::size_t count);

}  // namespace pwtest

#define PW_FAIL(detail) ::pwtest::fail(__FILE__, __LINE__, (detail))

#define PW_CHECK(condition)                                            \
  do {                                                                 \
    if (!(condition)) PW_FAIL(std::string("not true: ") + #condition); \
  } while (0)

#define PW_CHECK_INT(actual, expected)                                     \
  do {                                                                     \
    const long long pw_actual = static_cast<long long>(actual);            \
    const long long pw_expected = static_cast<long long>(expected);        \
    if (pw_actual != pw_expected)                                          \
      PW_FAIL(std::string(#actual) + " = " + std::to_string(pw_actual) +   \
              ", expected " + std::to_string(pw_expected));                \
  } while (0)

#define PW_CHECK_NEAR(actual, expected, tolerance)                            \
  do {                                                                        \
    const double pw_actual = (actual);                                        \
    const double pw_expected = (expected);                                    \
    const double pw_tolerance = (tolerance);                                  \
    const double pw_delta = pw_actual - pw_expected;                          \
    if (!(pw_delta >= -pw_tolerance && pw_delta <= pw_tolerance))             \
      PW_FAIL(std::string(#actual) + " = " +                                  \
              ::pwtest::format_double(pw_actual) + ", expected " +            \
              ::pwtest::format_double(pw_expected) + " +/- " +                \
              ::pwtest::format_double(pw_tolerance) + " (delta " +            \
              ::pwtest::format_double(pw_delta) + ")");                       \
  } while (0)

#define PW_CHECK_SAME_DOUBLE(actual, expected)                               \
  do {                                                                       \
    const double pw_actual = (actual);                                       \
    const double pw_expected = (expected);                                   \
    if (!(pw_actual == pw_expected))                                         \
      PW_FAIL(std::string(#actual) + " = " +                                 \
              ::pwtest::format_double(pw_actual) + ", expected exactly " +   \
              ::pwtest::format_double(pw_expected));                         \
  } while (0)

#define PW_CHECK_STRING_LIST(label, actual, expected) \
  ::pwtest::check_string_list(__FILE__, __LINE__, (label), (actual), (expected))
