import type {
  MatrixResearchBlock,
  MatrixResearchDataset,
  MatrixResearchObservation,
  MatrixResearchQuery,
  MatrixResearchView,
} from "@t3tools/contracts";

export interface ResolvedResearchView {
  readonly entities: string[];
  readonly year: number;
  readonly measure: string;
}
export interface ResearchPoint {
  readonly year: number;
  readonly value: number;
  readonly status?: MatrixResearchObservation["status"];
}

type Entity = MatrixResearchDataset["entities"][number];
interface DatasetIndex {
  readonly entities: Map<string, Entity>;
  readonly rows: Map<string, Map<number, MatrixResearchObservation>>;
  readonly ordered: Map<string, MatrixResearchObservation[]>;
}

// Dataset snapshots are immutable. View-only renders must not rescan every country-year for each polygon.
const indexes = new WeakMap<MatrixResearchDataset, DatasetIndex>();
function index(dataset: MatrixResearchDataset): DatasetIndex {
  const cached = indexes.get(dataset);
  if (cached) return cached;
  const rows = new Map<string, Map<number, MatrixResearchObservation>>();
  for (const observation of dataset.observations) {
    let country = rows.get(observation.entityId);
    if (!country) {
      country = new Map();
      rows.set(observation.entityId, country);
    }
    country.set(observation.year, observation);
  }
  const result: DatasetIndex = {
    entities: new Map(dataset.entities.map((entity) => [entity.id, entity])),
    rows,
    ordered: new Map(
      [...rows].map(([id, years]) => [id, [...years.values()].sort((a, b) => a.year - b.year)]),
    ),
  };
  indexes.set(dataset, result);
  return result;
}

export function resolveResearchView(
  dataset: MatrixResearchDataset,
  query?: MatrixResearchQuery,
  saved?: MatrixResearchView,
  authoredMeasure?: string,
): ResolvedResearchView {
  const lookup = index(dataset);
  const requested = saved?.entities ?? query?.entities ?? ["OWID_WRL"];
  const entities = [...new Set(requested.filter((id) => lookup.entities.has(id)))].slice(0, 6);
  if (entities.length === 0 && requested.length > 0) {
    const fallback = lookup.entities.get("OWID_WRL") ?? dataset.entities[0];
    if (fallback) entities.push(fallback.id);
  }
  const measures = new Set(dataset.measures.map((measure) => measure.id));
  const requestedMeasure = saved?.measure ?? authoredMeasure ?? query?.measure;
  return {
    entities,
    year: saved?.year ?? query?.year ?? dataset.defaultYear,
    measure:
      requestedMeasure && measures.has(requestedMeasure)
        ? requestedMeasure
        : dataset.measures[0]!.id,
  };
}

/** Quantitative headings follow the actual frame and selection, never a stale authored caption. */
export function researchBlockTitle(
  dataset: MatrixResearchDataset,
  block: MatrixResearchBlock,
  view: Pick<ResolvedResearchView, "measure">,
): string {
  switch (block.kind) {
    case "map":
    case "series": {
      const id = block.kind === "map" ? view.measure : block.measure;
      const label = dataset.measures.find((measure) => measure.id === id)?.label ?? id;
      return `${label} ${block.kind === "map" ? "by country" : "history"}`;
    }
    case "data-table":
      return "Country comparison";
    case "data-metrics":
      return "Selected observations";
    case "scatter":
      return "Country relationship";
  }
}

export function researchObservation(
  dataset: MatrixResearchDataset,
  entityId: string,
  year: number,
): MatrixResearchObservation | undefined {
  return index(dataset).rows.get(entityId)?.get(year);
}

export function researchSeries(
  dataset: MatrixResearchDataset,
  entityId: string,
  measure: string,
): ResearchPoint[] {
  const result: ResearchPoint[] = [];
  for (const observation of index(dataset).ordered.get(entityId) ?? []) {
    const value = observation.values[measure];
    if (typeof value === "number" && Number.isFinite(value)) {
      result.push({
        year: observation.year,
        value,
        ...(observation.status ? { status: observation.status } : {}),
      });
    }
  }
  return result;
}

/** Split ascending annual points at missing years; a gap is not an interpolated observation. */
export function researchSeriesSegments(points: readonly ResearchPoint[]): ResearchPoint[][] {
  const segments: ResearchPoint[][] = [];
  for (const point of points) {
    const previous = segments[segments.length - 1];
    if (!previous || previous[previous.length - 1]!.year + 1 !== point.year) {
      segments.push([point]);
    } else {
      previous.push(point);
    }
  }
  return segments;
}

export function researchRanking(dataset: MatrixResearchDataset, year: number, measure: string) {
  const rows: { entity: Entity; observation: MatrixResearchObservation; value: number }[] = [];
  const lookup = index(dataset);
  for (const entity of dataset.entities) {
    if (entity.iso3 === null) continue;
    const observation = lookup.rows.get(entity.id)?.get(year);
    const value = observation?.values[measure];
    if (observation && typeof value === "number" && Number.isFinite(value)) {
      rows.push({ entity, observation, value });
    }
  }
  return rows.sort((a, b) => b.value - a.value || a.entity.name.localeCompare(b.entity.name));
}

export function researchChange(
  dataset: MatrixResearchDataset,
  entityId: string,
  measure: string,
  year: number,
): { absolute: number; percent: number | null } | null {
  const current = researchObservation(dataset, entityId, year)?.values[measure];
  const previous = researchObservation(dataset, entityId, year - 1)?.values[measure];
  if (
    typeof current !== "number" ||
    typeof previous !== "number" ||
    !Number.isFinite(current) ||
    !Number.isFinite(previous)
  )
    return null;
  const absolute = current - previous;
  const percent = previous > 0 ? (100 * absolute) / previous : null;
  return {
    absolute,
    percent: percent !== null && Number.isFinite(percent) ? percent : null,
  };
}

const concise = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 });
const decimal = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const exact = new Intl.NumberFormat("en-US", { maximumSignificantDigits: 21 });
export function isResearchPercentageUnit(unit: string): boolean {
  return /%|\bpercent(?:age)?\b/i.test(unit);
}

/** A difference between percentage-valued observations is percentage points, not percent. */
export function formatResearchDifference(
  value: number | null | undefined,
  unit: string,
  compact = false,
): string {
  return formatResearchValue(
    value,
    isResearchPercentageUnit(unit) ? "percentage points" : unit,
    compact,
  );
}

export function formatResearchValue(
  value: number | null | undefined,
  unit: string,
  compact = false,
): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "Not available";
  const suffix =
    unit === "tonnes"
      ? "t"
      : unit === "hectares"
        ? "ha"
        : ["tonnes per hectare", "tonnes/hectare", "t/ha"].includes(unit)
          ? "t/ha"
          : unit === "percent" || unit === "%"
            ? "%"
            : unit === "index" || unit === "dimensionless"
              ? ""
              : unit;
  const percentage = isResearchPercentageUnit(unit);
  const number = compact
    ? (!percentage && Math.abs(value) >= 1_000 ? concise : decimal).format(value)
    : exact.format(value);
  return suffix === "%" ? `${number}%` : suffix ? `${number} ${suffix}` : number;
}
