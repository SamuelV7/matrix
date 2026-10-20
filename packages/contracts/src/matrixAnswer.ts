import * as Schema from "effect/Schema";
import { PositiveInt, RunId, ThreadId, TrimmedNonEmptyString, TurnItemId } from "./baseSchemas.ts";
import { MatrixSecCompany } from "./matrixSec.ts";
import {
  MatrixResearchBlock,
  MatrixResearchDataset,
  MatrixResearchFocus,
  MatrixResearchQuery,
  MatrixResearchSavedView,
} from "./matrixResearch.ts";

const Title = TrimmedNonEmptyString.check(Schema.isMaxLength(160));
const Copy = Schema.String.check(Schema.isMaxLength(4_000));
const BlockId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-zA-Z0-9_-]+$/),
);
export const MatrixMetricId = Schema.Literals([
  "revenue",
  "netIncome",
  "operatingCashFlow",
  "capex",
  "assets",
  "liabilities",
  "netMargin",
  "operatingCashFlowMargin",
]);
export type MatrixMetricId = typeof MatrixMetricId.Type;
export const MatrixAnswerLevel = Schema.Literals(["guided", "analyst"]);
export const MatrixAnswerBlock = Schema.Union([
  ...MatrixResearchBlock.members,
  Schema.Struct({ id: BlockId, kind: Schema.Literal("metric"), metric: MatrixMetricId }),
  Schema.Struct({
    id: BlockId,
    kind: Schema.Literal("chart"),
    metric: MatrixMetricId,
    chartType: Schema.Literals(["line", "bar"]),
    periods: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(20))),
  }),
  Schema.Struct({
    id: BlockId,
    kind: Schema.Literal("table"),
    metrics: Schema.Array(MatrixMetricId).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
    periods: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(20))),
  }),
  Schema.Struct({ id: BlockId, kind: Schema.Literal("filings"), title: Title }),
  Schema.Struct({ id: BlockId, kind: Schema.Literal("explanation"), title: Title, text: Copy }),
  Schema.Struct({ id: BlockId, kind: Schema.Literal("company") }),
  Schema.Struct({
    id: BlockId,
    kind: Schema.Literal("diagram"),
    title: Title,
    nodes: Schema.Array(Schema.Struct({ id: BlockId, label: Title, detail: Copy })).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(8),
    ),
    edges: Schema.Array(
      Schema.Struct({ from: BlockId, to: BlockId, label: Schema.optional(Title) }),
    ).check(Schema.isMaxLength(16)),
  }),
  Schema.Struct({
    id: BlockId,
    kind: Schema.Literal("actions"),
    title: Title,
    prompts: Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(240))).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(4),
    ),
  }),
]);
export type MatrixAnswerBlock = typeof MatrixAnswerBlock.Type;
export const MatrixAnswerSpec = Schema.Struct({
  title: Title,
  summary: Copy,
  level: MatrixAnswerLevel,
  symbols: Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(32))).check(
    Schema.isMaxLength(4),
  ),
  blocks: Schema.Array(MatrixAnswerBlock).check(Schema.isMinLength(1), Schema.isMaxLength(12)),
  queries: Schema.optional(
    Schema.Array(MatrixResearchQuery).check(Schema.isMinLength(1), Schema.isMaxLength(3)),
  ),
  sections: Schema.optional(
    Schema.Array(
      Schema.Struct({
        id: BlockId,
        label: TrimmedNonEmptyString.check(Schema.isMaxLength(40)),
        columns: Schema.Literals([1, 2, 3]),
        blockIds: Schema.Array(BlockId).check(Schema.isMinLength(1), Schema.isMaxLength(12)),
      }),
    ).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
  ),
});
export type MatrixAnswerSpec = typeof MatrixAnswerSpec.Type;

export const MatrixAnswerSource = Schema.Struct({
  url: Schema.String.check(Schema.isPattern(/^https:\/\/(?:www\.|data\.)?sec\.gov\//)),
  accession: Schema.String,
  tag: Schema.String,
  filed: Schema.String,
});
export const MatrixAnswerObservation = Schema.Struct({
  start: Schema.NullOr(Schema.String),
  end: Schema.String,
  value: Schema.Finite,
  sources: Schema.Array(MatrixAnswerSource).check(Schema.isMinLength(1), Schema.isMaxLength(2)),
});
export const MatrixAnswerMetric = Schema.Struct({
  id: MatrixMetricId,
  label: Title,
  description: Copy,
  unit: Schema.Literals(["USD", "percent"]),
  observations: Schema.Array(MatrixAnswerObservation).check(Schema.isMaxLength(20)),
});
export type MatrixAnswerMetric = typeof MatrixAnswerMetric.Type;
export const MatrixAnswerCompany = Schema.Struct({
  symbol: TrimmedNonEmptyString,
  cik: TrimmedNonEmptyString,
  name: Title,
  metrics: Schema.Array(MatrixAnswerMetric).check(Schema.isMaxLength(8)),
  filings: MatrixSecCompany.fields.filings,
  sources: MatrixSecCompany.fields.sources,
  warnings: MatrixSecCompany.fields.warnings,
  profile: Schema.optional(MatrixSecCompany.fields.company),
});
export type MatrixAnswerCompany = typeof MatrixAnswerCompany.Type;
export const MatrixAnswer = Schema.Struct({
  id: TurnItemId,
  threadId: ThreadId,
  revision: PositiveInt,
  pinned: Schema.Boolean,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  lastPresentedRunId: Schema.optional(RunId),
  spec: MatrixAnswerSpec,
  companies: Schema.Array(MatrixAnswerCompany).check(Schema.isMaxLength(4)),
  datasets: Schema.optional(Schema.Array(MatrixResearchDataset).check(Schema.isMaxLength(3))),
  views: Schema.optional(Schema.Array(MatrixResearchSavedView).check(Schema.isMaxLength(3))),
  researchFocus: Schema.optional(MatrixResearchFocus),
});
export type MatrixAnswer = typeof MatrixAnswer.Type;

export const MatrixPresentAnswerInput = Schema.Struct({
  answerId: Schema.optional(TurnItemId),
  expectedRevision: Schema.optional(PositiveInt),
  viewPolicy: Schema.optional(Schema.Literals(["preserve", "authored"])),
  spec: MatrixAnswerSpec,
});
export type MatrixPresentAnswerInput = typeof MatrixPresentAnswerInput.Type;
export const MatrixWorkspaceInput = Schema.Struct({ threadId: ThreadId });
export const MatrixWorkspace = Schema.Struct({ answers: Schema.Array(MatrixAnswer) });
export type MatrixWorkspace = typeof MatrixWorkspace.Type;
export const MatrixSetAnswerPinnedInput = Schema.Struct({
  threadId: ThreadId,
  answerId: TurnItemId,
  expectedRevision: PositiveInt,
  pinned: Schema.Boolean,
});
export type MatrixSetAnswerPinnedInput = typeof MatrixSetAnswerPinnedInput.Type;

export class MatrixAnswerError extends Schema.TaggedError<MatrixAnswerError>()(
  "MatrixAnswerError",
  {
    reason: Schema.Literals(["invalid_request", "not_found", "conflict", "unavailable"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "invalid_request":
        return "This answer requests unsupported or inconsistent data. No substitute values were used.";
      case "not_found":
        return "This research answer or conversation is no longer available.";
      case "conflict":
        return "This answer changed. Read its latest revision and try again.";
      case "unavailable":
        return "The research answer could not be saved or its source data could not be retrieved. No substitute values were used.";
    }
  }
}
