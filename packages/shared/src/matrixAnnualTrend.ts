import type { MatrixSecCompany } from "@t3tools/contracts";

type Observation = MatrixSecCompany["metrics"][number]["observations"][number];

/** Resolve repeated annual endpoints without choosing among conflicting same-day disclosures. */
export function selectAnnualTrend(observations: readonly Observation[]): Observation[] {
  const periods = new Map<string, { point: Observation; ambiguous: boolean }>();
  for (const point of observations) {
    const existing = periods.get(point.end);
    if (!existing || point.filed > existing.point.filed) {
      periods.set(point.end, { point, ambiguous: false });
    } else if (point.filed === existing.point.filed) {
      if (
        point.value !== existing.point.value ||
        point.start !== existing.point.start ||
        point.tag !== existing.point.tag
      ) {
        existing.ambiguous = true;
      } else if (point.accession > existing.point.accession) {
        existing.point = point;
      }
    }
  }
  return [...periods.values()]
    .filter((entry) => !entry.ambiguous)
    .map((entry) => entry.point)
    .sort((left, right) => left.end.localeCompare(right.end));
}
