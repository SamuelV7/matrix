import * as Schema from "effect/Schema";
import { PositiveInt, ThreadId, TrimmedNonEmptyString, TurnItemId } from "./baseSchemas.ts";

const Identifier = TrimmedNonEmptyString.check(
  Schema.isMaxLength(80),
  Schema.isPattern(/^[a-zA-Z0-9_-]+$/),
);
const MeasureId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(80),
  Schema.isPattern(/^[a-zA-Z0-9_.-]+$/),
);
const Label = TrimmedNonEmptyString.check(Schema.isMaxLength(200));
const Description = Schema.String.check(Schema.isMaxLength(4_000));
const HttpsUrl = Schema.String.check(Schema.isMaxLength(2_000), Schema.isPattern(/^https:\/\//));
export const MatrixResearchYear = Schema.Int.check(
  Schema.isBetween({ minimum: 1900, maximum: 2100 }),
);
export const MatrixResearchView = Schema.Struct({
  entities: Schema.Array(Identifier).check(Schema.isMaxLength(6)),
  year: Schema.NullOr(MatrixResearchYear),
  measure: Schema.NullOr(MeasureId),
});
export type MatrixResearchView = typeof MatrixResearchView.Type;

export const MatrixResearchFocus = Schema.Struct({
  entities: MatrixResearchView.fields.entities,
});
export type MatrixResearchFocus = typeof MatrixResearchFocus.Type;

const ResearchQueryFields = {
  id: Identifier,
  fromYear: Schema.optional(MatrixResearchYear),
  toYear: Schema.optional(MatrixResearchYear),
  entities: Schema.optional(Schema.Array(Identifier).check(Schema.isMaxLength(6))),
  year: Schema.optional(MatrixResearchYear),
  measure: Schema.optional(MeasureId),
};
/** Queries name server-owned providers; the agent cannot supply URLs or numerical observations. */
export const MatrixResearchQuery = Schema.Union([
  Schema.Struct({
    ...ResearchQueryFields,
    kind: Schema.Literal("crop"),
    crop: Identifier,
    includeDrought: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    ...ResearchQueryFields,
    kind: Schema.Literal("indicators"),
    indicators: Schema.Array(
      Schema.String.check(
        Schema.isMaxLength(80),
        Schema.isPattern(/^[a-zA-Z0-9]+(?:[._-][a-zA-Z0-9]+)+$/),
      ),
    ).check(Schema.isMinLength(1), Schema.isMaxLength(4)),
  }),
]);
export type MatrixResearchQuery = typeof MatrixResearchQuery.Type;

export const MatrixResearchSource = Schema.Struct({
  id: Identifier,
  name: Label,
  url: HttpsUrl,
  downloadUrl: HttpsUrl,
  retrievedAt: Schema.String,
  updatedAt: Schema.NullOr(Schema.String),
  license: Label,
  description: Description,
});
export type MatrixResearchSource = typeof MatrixResearchSource.Type;
export const MatrixResearchMeasure = Schema.Struct({
  id: MeasureId,
  label: Label,
  unit: Label,
  description: Description,
  sourceIds: Schema.Array(Identifier).check(Schema.isMinLength(1), Schema.isMaxLength(4)),
  derived: Schema.Boolean,
  colorScale: Schema.Literals(["sequential", "diverging"]),
});
export type MatrixResearchMeasure = typeof MatrixResearchMeasure.Type;
export const MatrixResearchObservation = Schema.Struct({
  entityId: Identifier,
  year: MatrixResearchYear,
  values: Schema.Record(MeasureId, Schema.NullOr(Schema.Finite)).check(Schema.isMaxProperties(16)),
  status: Schema.optional(Schema.Literals(["reported", "estimate", "forecast", "mixed"])),
});
export type MatrixResearchObservation = typeof MatrixResearchObservation.Type;
export const MatrixResearchDataset = Schema.Struct({
  id: Identifier,
  title: Label,
  frequency: Schema.Literal("annual"),
  geography: Schema.Literal("country"),
  timeBasis: Description,
  defaultYear: MatrixResearchYear,
  entities: Schema.Array(
    Schema.Struct({
      id: Identifier,
      name: Label,
      iso3: Schema.NullOr(Schema.String.check(Schema.isPattern(/^[A-Z]{3}$/))),
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(350)),
  measures: Schema.Array(MatrixResearchMeasure).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(16),
  ),
  observations: Schema.Array(MatrixResearchObservation).check(Schema.isMaxLength(30_000)),
  sources: Schema.Array(MatrixResearchSource).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
  warnings: Schema.Array(Description).check(Schema.isMaxLength(32)),
});
export type MatrixResearchDataset = typeof MatrixResearchDataset.Type;

export const MatrixResearchBlock = Schema.Union([
  Schema.Struct({
    id: Identifier,
    kind: Schema.Literal("map"),
    dataset: Identifier,
    measure: MeasureId,
  }),
  Schema.Struct({
    id: Identifier,
    kind: Schema.Literal("series"),
    dataset: Identifier,
    measure: MeasureId,
    chartType: Schema.Literals(["line", "bar"]),
  }),
  Schema.Struct({
    id: Identifier,
    kind: Schema.Literal("data-table"),
    dataset: Identifier,
    measures: Schema.Array(MeasureId).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
  }),
  Schema.Struct({
    id: Identifier,
    kind: Schema.Literal("data-metrics"),
    dataset: Identifier,
    measures: Schema.Array(MeasureId).check(Schema.isMinLength(1), Schema.isMaxLength(6)),
  }),
  Schema.Struct({
    id: Identifier,
    kind: Schema.Literal("scatter"),
    dataset: Identifier,
    xMeasure: MeasureId,
    yMeasure: MeasureId,
  }),
]);
export type MatrixResearchBlock = typeof MatrixResearchBlock.Type;
export const MatrixResearchSavedView = Schema.Struct({
  datasetId: Identifier,
  view: MatrixResearchView,
});
export type MatrixResearchSavedView = typeof MatrixResearchSavedView.Type;
export const MatrixSetAnswerViewInput = Schema.Struct({
  threadId: ThreadId,
  answerId: TurnItemId,
  expectedRevision: PositiveInt,
  datasetId: Identifier,
  view: MatrixResearchView,
});
export type MatrixSetAnswerViewInput = typeof MatrixSetAnswerViewInput.Type;
