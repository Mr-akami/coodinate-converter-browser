/*
 * Which locally stored Data Version to start from.
 *
 * A generation is usable only when its own directory holds a published
 * manifest and a published proj.db; grids are fetched on demand and are not
 * part of that decision.
 */

/**
 * @typedef {{
 *   version: string,
 *   manifestPublished: boolean,
 *   projDbPublished: boolean,
 *   installedAt: number,
 * }} Generation
 */

/**
 * @param {Generation[]} generations
 * @returns {string | null} the newest complete Data Version, or null
 */
export function selectNewestCompleteVersion(generations) {
  const complete = generations.filter(
    (generation) => generation.manifestPublished && generation.projDbPublished,
  );
  if (complete.length === 0) return null;

  const newest = complete.reduce((best, candidate) => {
    if (candidate.installedAt !== best.installedAt) {
      return candidate.installedAt > best.installedAt ? candidate : best;
    }
    // Same install time: order by identifier so the choice does not depend on
    // the order the directories were listed in.
    return candidate.version > best.version ? candidate : best;
  });
  return newest.version;
}
