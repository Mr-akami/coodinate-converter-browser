#include "support.h"

#include <proj.h>

#include <cctype>
#include <filesystem>
#include <memory>
#include <stdexcept>

#include "harness.h"

namespace fs = std::filesystem;

namespace pwtest {

const char* const DEFERRED_GRID = "be_ign_bd72lb72_etrs89lb08.tif";

const std::string& data_dir() {
  static const std::string dir = std::string(PW_TEST_WORK_DIR) + "/data";
  return dir;
}

void prepare_data_dir() {
  const fs::path source(PW_TEST_DATA_DIR);
  if (!fs::is_directory(source)) {
    throw std::runtime_error(
        "proj-data directory not found: " + source.string() +
        " (set PROJ_TEST_DATA_DIR before running scripts/build-proj-native.sh)");
  }

  const fs::path work(data_dir());
  fs::remove_all(work);
  fs::create_directories(work);

  bool deferred_seen = false;
  for (const auto& entry : fs::directory_iterator(source)) {
    const std::string name = entry.path().filename().string();
    if (name == DEFERRED_GRID) {
      deferred_seen = true;
      continue;
    }
    fs::create_symlink(fs::absolute(entry.path()), work / name);
  }

  if (!deferred_seen) {
    throw std::runtime_error(std::string("grid ") + DEFERRED_GRID +
                             " not found in " + source.string());
  }
  if (!fs::exists(work / "proj.db")) {
    throw std::runtime_error("proj.db not found in " + source.string());
  }
}

void link_deferred_grid() {
  const fs::path link = fs::path(data_dir()) / DEFERRED_GRID;
  if (fs::exists(fs::symlink_status(link))) {
    throw std::runtime_error(std::string("grid ") + DEFERRED_GRID +
                             " is already present in " + data_dir());
  }
  fs::create_symlink(fs::absolute(fs::path(PW_TEST_DATA_DIR) / DEFERRED_GRID),
                     link);
}

namespace {

struct ReferenceContext {
  PJ_CONTEXT* ctx = proj_context_create();

  ReferenceContext() {
    if (!ctx) throw std::runtime_error("proj_context_create failed");
    const char* paths[1] = {data_dir().c_str()};
    proj_context_set_search_paths(ctx, 1, paths);
    const std::string db = data_dir() + "/proj.db";
    proj_context_set_database_path(ctx, db.c_str(), nullptr, nullptr);
  }
  ~ReferenceContext() { proj_context_destroy(ctx); }
  ReferenceContext(const ReferenceContext&) = delete;
  ReferenceContext& operator=(const ReferenceContext&) = delete;
};

using PjPtr = std::unique_ptr<PJ, PJ* (*)(PJ*)>;

}  // namespace

Coord reference_transform(const char* src, const char* dst, Coord input) {
  ReferenceContext reference;

  PJ* created = proj_create_crs_to_crs(reference.ctx, src, dst, nullptr);
  if (!created) {
    throw CheckFailed(std::string("reference proj_create_crs_to_crs failed for ") +
                      src + " -> " + dst);
  }
  PjPtr raw(created, proj_destroy);

  PJ* normalized = proj_normalize_for_visualization(reference.ctx, raw.get());
  if (!normalized) {
    throw CheckFailed(
        std::string("reference proj_normalize_for_visualization failed for ") +
        src + " -> " + dst);
  }
  PjPtr op(normalized, proj_destroy);

  const PJ_COORD in = proj_coord(input.x, input.y, input.z, 0.0);
  const PJ_COORD out = proj_trans(op.get(), PJ_FWD, in);
  const int err = proj_errno(op.get());
  if (err != 0) {
    throw CheckFailed(std::string("reference proj_trans failed for ") + src +
                      " -> " + dst + ": " + proj_errno_string(err));
  }
  return Coord{out.xyz.x, out.xyz.y, out.xyz.z};
}

std::vector<std::string> json_string_values(const std::string& json,
                                            const std::string& field) {
  const std::string key = "\"" + field + "\"";
  std::vector<std::string> values;

  std::size_t search = 0;
  while (true) {
    const std::size_t found = json.find(key, search);
    if (found == std::string::npos) break;

    std::size_t i = found + key.size();
    while (i < json.size() && std::isspace(static_cast<unsigned char>(json[i]))) ++i;
    if (i >= json.size() || json[i] != ':') {
      throw std::runtime_error("malformed JSON: no ':' after " + key);
    }
    ++i;
    while (i < json.size() && std::isspace(static_cast<unsigned char>(json[i]))) ++i;
    if (i >= json.size() || json[i] != '"') {
      throw std::runtime_error("malformed JSON: " + key + " is not a string");
    }
    ++i;

    std::string value;
    while (i < json.size() && json[i] != '"') {
      if (json[i] == '\\' && i + 1 < json.size()) {
        value.push_back(json[i + 1]);
        i += 2;
        continue;
      }
      value.push_back(json[i]);
      ++i;
    }
    if (i >= json.size()) {
      throw std::runtime_error("malformed JSON: unterminated string for " + key);
    }

    values.push_back(value);
    search = i + 1;
  }

  return values;
}

}  // namespace pwtest
