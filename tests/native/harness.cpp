#include "harness.h"

#include <algorithm>
#include <cstdio>
#include <exception>
#include <sstream>

namespace pwtest {

void fail(const char* file, int line, const std::string& detail) {
  std::ostringstream out;
  out << file << ":" << line << ": " << detail;
  throw CheckFailed(out.str());
}

std::string format_double(double value) {
  char buffer[64];
  std::snprintf(buffer, sizeof(buffer), "%.12g", value);
  return std::string(buffer);
}

namespace {

std::string join(const std::vector<std::string>& values) {
  std::ostringstream out;
  out << "[";
  for (std::size_t i = 0; i < values.size(); ++i) {
    if (i > 0) out << ", ";
    out << values[i];
  }
  out << "]";
  return out.str();
}

}  // namespace

void check_string_list(const char* file, int line, const char* label,
                       std::vector<std::string> actual,
                       std::vector<std::string> expected) {
  std::sort(actual.begin(), actual.end());
  std::sort(expected.begin(), expected.end());
  if (actual != expected) {
    fail(file, line,
         std::string(label) + " = " + join(actual) + ", expected " +
             join(expected));
  }
}

int run(const TestCase* cases, std::size_t count) {
  std::size_t failed = 0;
  for (std::size_t i = 0; i < count; ++i) {
    try {
      cases[i].fn();
      std::printf("ok   %s\n", cases[i].name);
    } catch (const std::exception& error) {
      ++failed;
      std::printf("FAIL %s\n     %s\n", cases[i].name, error.what());
    }
    std::fflush(stdout);
  }
  std::printf("%zu/%zu passed\n", count - failed, count);
  return failed == 0 ? 0 : 1;
}

}  // namespace pwtest
