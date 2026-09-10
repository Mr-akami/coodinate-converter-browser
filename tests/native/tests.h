#pragma once

// Declared in one place and run from main.cpp in a fixed order: the wrapper
// keeps one process-wide context and one operation cache, so the tests share
// state and their order has to be readable.

void test_axis_order_geographic();
void test_axis_order_projected();
void test_axis_order_polar();
void test_axis_order_compound();
void test_axis_order_vertical_only();
void test_operation_selected_per_coordinate_cell();
void test_grids_needed_names_per_region();
void test_grids_needed_dedup_is_stable_across_repeats();
void test_transform_many_agrees_with_repeated_transform();
void test_transform_many_reports_first_failing_point();
void test_transform_many_reports_pair_level_failure();
void test_ballpark_only_pair();
void test_strict_transform_across_grid_arrival();
void test_geoid_applies_outside_declared_extent();
void test_vertical_only_source_round_trips();
