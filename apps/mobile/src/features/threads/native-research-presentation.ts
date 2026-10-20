import type {
  MatrixAnswer,
  MatrixResearchDataset,
  MatrixResearchObservation,
} from "@t3tools/contracts";
import { resolveResearchView } from "@t3tools/shared/matrixResearch";

export function nativeResearchView(answer: MatrixAnswer, dataset: MatrixResearchDataset) {
  const query = answer.spec.queries?.find((candidate) => candidate.id === dataset.id);
  const saved = answer.views?.find((candidate) => candidate.datasetId === dataset.id)?.view;
  const map = answer.spec.blocks.find(
    (block) => block.kind === "map" && block.dataset === dataset.id,
  );
  return resolveResearchView(dataset, query, saved, map?.kind === "map" ? map.measure : undefined);
}

export function nativeResearchFocus(entities: readonly string[], entityId: string): string[] {
  return [entityId, ...entities.filter((id) => id !== entityId)].slice(0, 6);
}

export function nativeResearchCompare(entities: readonly string[], entityId: string): string[] {
  return entities.includes(entityId)
    ? entities.length > 1
      ? entities.filter((id) => id !== entityId)
      : [...entities]
    : entities.length < 6
      ? [...entities, entityId]
      : [...entities];
}

export interface NativeResearchRow {
  readonly entity: MatrixResearchDataset["entities"][number];
  readonly observation: MatrixResearchObservation | undefined;
}

export function nativeResearchRows(
  dataset: MatrixResearchDataset,
  year: number,
  sort: { measure: string; descending: boolean },
) {
  const observations = new Map(
    dataset.observations
      .filter((observation) => observation.year === year)
      .map((observation) => [observation.entityId, observation]),
  );
  return dataset.entities
    .map((entity) => ({ entity, observation: observations.get(entity.id) }))
    .sort((a, b) => {
      const left = a.observation?.values[sort.measure];
      const right = b.observation?.values[sort.measure];
      if (left == null) return right == null ? a.entity.name.localeCompare(b.entity.name) : 1;
      if (right == null) return -1;
      return (
        (sort.descending ? right - left : left - right) ||
        a.entity.name.localeCompare(b.entity.name)
      );
    });
}

export function nativeResearchPage(
  rows: readonly NativeResearchRow[],
  options: { search: string; entities: readonly string[] | null; page: number },
) {
  const search = options.search.trim().toLowerCase();
  const filtered = rows.filter(
    (row) =>
      row.entity.name.toLowerCase().includes(search) &&
      (options.entities === null || options.entities.includes(row.entity.id)),
  );
  const pageCount = Math.max(1, Math.ceil(filtered.length / 20));
  const page = Math.max(0, Math.min(options.page, pageCount - 1));
  return {
    rows: filtered.slice(page * 20, (page + 1) * 20),
    page,
    pageCount,
    total: filtered.length,
    first: filtered.length === 0 ? 0 : page * 20 + 1,
    last: Math.min((page + 1) * 20, filtered.length),
  };
}

export function nativeResearchSourceUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function nativeResearchColor(
  value: number | null | undefined,
  extent: readonly [number, number] | null,
  diverging: boolean,
): string {
  if (value == null || extent === null) return "#64748b";
  if (diverging) {
    const bound = Math.max(Math.abs(extent[0]), Math.abs(extent[1])) || 1;
    const strength = Math.min(1, Math.abs(value) / bound);
    return value < 0
      ? `rgb(${Math.round(240 - strength * 40)},${Math.round(230 - strength * 170)},${Math.round(215 - strength * 170)})`
      : `rgb(${Math.round(220 - strength * 190)},${Math.round(235 - strength * 120)},${Math.round(240 - strength * 80)})`;
  }
  const strength = Math.max(0, Math.min(1, (value - extent[0]) / (extent[1] - extent[0] || 1)));
  return `rgb(${Math.round(210 - strength * 190)},${Math.round(235 - strength * 120)},${Math.round(225 - strength * 130)})`;
}
