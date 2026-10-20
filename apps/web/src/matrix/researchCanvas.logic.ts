import type {
  MatrixResearchDataset,
  MatrixResearchMeasure,
  MatrixResearchObservation,
} from "@t3tools/contracts";

export const RESEARCH_COLORS = ["#38bdf8", "#fbbf24", "#a78bfa", "#34d399", "#fb7185", "#f97316"];

export interface ResearchColorScale {
  min: number;
  max: number;
  diverging: boolean;
}
export interface ResearchYearRow {
  entity: MatrixResearchDataset["entities"][number];
  observation: MatrixResearchObservation | undefined;
}

export function toggleResearchEntity(selected: readonly string[], entityId: string): string[] {
  if (entityId === "OWID_WRL") return selected.includes(entityId) ? [] : [entityId];
  const countries = selected.filter((id) => id !== "OWID_WRL");
  if (countries.includes(entityId)) return countries.filter((id) => id !== entityId);
  return countries.length < 6 ? [...countries, entityId] : countries;
}

export function researchScale(
  values: readonly number[],
  measure: Pick<MatrixResearchMeasure, "colorScale">,
): ResearchColorScale | null {
  const finite = values.filter(Number.isFinite);
  if (!finite.length) return null;
  if (measure.colorScale === "diverging") {
    const bound = Math.max(...finite.map(Math.abs));
    return { min: -bound, max: bound, diverging: true };
  }
  return { min: Math.min(0, ...finite), max: Math.max(0, ...finite), diverging: false };
}

export function researchFill(
  value: number | null | undefined,
  scale: ResearchColorScale | null,
): string {
  if (value == null || !Number.isFinite(value) || !scale) return "#475569";
  const t =
    scale.max === scale.min
      ? scale.diverging
        ? 0.5
        : 0
      : Math.max(0, Math.min(1, (value - scale.min) / (scale.max - scale.min)));
  const start = scale.diverging ? (t < 0.5 ? [180, 83, 9] : [226, 232, 240]) : [30, 58, 70];
  const end = scale.diverging ? (t < 0.5 ? [226, 232, 240] : [14, 116, 144]) : [34, 211, 238];
  const ratio = scale.diverging ? (t < 0.5 ? t * 2 : (t - 0.5) * 2) : t;
  return `rgb(${start.map((channel, index) => Math.round(channel + (end[index]! - channel) * ratio)).join(",")})`;
}

export function researchYearRows(dataset: MatrixResearchDataset, year: number) {
  const observations = new Map(
    dataset.observations.filter((row) => row.year === year).map((row) => [row.entityId, row]),
  );
  return dataset.entities.map((entity) => ({ entity, observation: observations.get(entity.id) }));
}

export function sortResearchRows(rows: ResearchYearRow[], key: string, direction: "asc" | "desc") {
  const sign = direction === "asc" ? 1 : -1;
  return rows.toSorted((a, b) => {
    if (key === "country") return sign * a.entity.name.localeCompare(b.entity.name);
    const av = a.observation?.values[key];
    const bv = b.observation?.values[key];
    if (av == null) return bv == null ? a.entity.name.localeCompare(b.entity.name) : 1;
    if (bv == null) return -1;
    return sign * (av - bv) || a.entity.name.localeCompare(b.entity.name);
  });
}

export function researchTablePage<T>(rows: readonly T[], requestedPage: number) {
  const pageSize = 20;
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const page = Math.max(
    0,
    Math.min(pageCount - 1, Number.isFinite(requestedPage) ? Math.floor(requestedPage) : 0),
  );
  const offset = page * pageSize;
  return {
    rows: rows.slice(offset, offset + pageSize),
    page,
    pageCount,
    total: rows.length,
    start: rows.length ? offset + 1 : 0,
    end: Math.min(rows.length, offset + pageSize),
  };
}
