import {
  MatrixResearchDataset,
  MatrixResearchMeasure,
  MatrixResearchObservation,
  MatrixResearchSource,
  MatrixResearchView,
  type MatrixResearchQuery,
} from "@t3tools/contracts";
import {
  researchRanking,
  researchObservation,
  resolveResearchView,
} from "@t3tools/shared/matrixResearch";
import * as Schema from "effect/Schema";

const historyLimit = 32;

export const ResearchInspection = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  view: MatrixResearchView,
  entities: MatrixResearchDataset.fields.entities,
  measures: Schema.Array(MatrixResearchMeasure),
  coverage: Schema.Array(
    Schema.Struct({
      measure: Schema.String,
      fromYear: Schema.NullOr(Schema.Int),
      toYear: Schema.NullOr(Schema.Int),
      observations: Schema.Int,
    }),
  ),
  focus: Schema.Array(
    Schema.Struct({
      entityId: Schema.String,
      current: Schema.NullOr(MatrixResearchObservation),
      history: Schema.Array(MatrixResearchObservation).check(Schema.isMaxLength(historyLimit)),
      historyCoverage: Schema.Struct({
        fromYear: Schema.NullOr(Schema.Int),
        toYear: Schema.NullOr(Schema.Int),
        rows: Schema.Int,
        returnedRows: Schema.Int,
        truncated: Schema.Boolean,
      }),
    }),
  ),
  ranking: Schema.Array(Schema.Struct({ entityId: Schema.String, value: Schema.Finite })),
  sources: Schema.Array(MatrixResearchSource),
  warnings: Schema.Array(Schema.String),
});

export function inspectResearchDataset(
  dataset: MatrixResearchDataset,
  query?: MatrixResearchQuery,
  saved?: MatrixResearchView,
): typeof ResearchInspection.Type {
  const view = resolveResearchView(dataset, query, saved);
  const coverage = dataset.measures.map((measure) => {
    let fromYear: number | null = null;
    let toYear: number | null = null;
    let observations = 0;
    for (const point of dataset.observations) {
      if (typeof point.values[measure.id] !== "number") continue;
      fromYear = fromYear === null ? point.year : Math.min(fromYear, point.year);
      toYear = toYear === null ? point.year : Math.max(toYear, point.year);
      observations++;
    }
    return { measure: measure.id, fromYear, toYear, observations };
  });
  return {
    id: dataset.id,
    title: dataset.title,
    view,
    entities: dataset.entities,
    measures: dataset.measures,
    coverage,
    focus: view.entities.map((entityId) => {
      const history = dataset.observations
        .filter((point) => point.entityId === entityId && point.year <= view.year)
        .sort((a, b) => a.year - b.year);
      return {
        entityId,
        current: researchObservation(dataset, entityId, view.year) ?? null,
        history: history.length > historyLimit ? history.slice(-historyLimit) : history,
        historyCoverage: {
          fromYear: history[0]?.year ?? null,
          toYear: history.at(-1)?.year ?? null,
          rows: history.length,
          returnedRows: Math.min(history.length, historyLimit),
          truncated: history.length > historyLimit,
        },
      };
    }),
    ranking: researchRanking(dataset, view.year, view.measure)
      .slice(0, 10)
      .map((entry) => ({ entityId: entry.entity.id, value: entry.value })),
    sources: dataset.sources,
    warnings: [
      ...dataset.warnings,
      `Inspection is compact: selected entities show at most ${historyLimit} annual rows ending at the focused year; historyCoverage explicitly identifies omitted rows. Do not infer full-period extrema or statistics from a truncated history: inspect the omitted exact range first. Ranking shows 10 countries. The saved workspace retains full fetched history. Coverage counts include source aggregates; country rankings exclude aggregates.`,
    ],
  };
}
