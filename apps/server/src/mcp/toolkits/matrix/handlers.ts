import { MatrixAnswerError, OrchestratorMcpFailure } from "@t3tools/contracts";
import type { MatrixAnswer } from "@t3tools/contracts";
import { resolveResearchView } from "@t3tools/shared/matrixResearch";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SecData from "../../../matrix/SecData.ts";
import * as AnswerService from "../../../matrix/AnswerService.ts";
import * as ResearchData from "../../../matrix/ResearchData.ts";
import { inspectResearchDataset } from "../../../matrix/researchSummary.ts";
import { AnswerCallerCheck } from "../../../matrix/AnswerCaller.ts";
import { isLiveCallerShell } from "../../OrchestratorMcpService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { assertLiveCaller, readCaller, unavailable } from "../../threadAccess.ts";
import { MatrixToolkit } from "./tools.ts";

const isResearchDataFailure = Schema.is(ResearchData.ResearchDataFailure);
const answerFailure = (error: MatrixAnswerError) =>
  new OrchestratorMcpFailure({
    code:
      error.reason === "invalid_request"
        ? "invalid_request"
        : error.reason === "not_found"
          ? "thread_not_found"
          : "orchestration_error",
    message:
      error.reason === "conflict"
        ? `${error.message} Use matrix_inspect_answers to read the latest revision.`
        : error.message,
    ...(isResearchDataFailure(error.cause) ? { message: error.cause.message } : {}),
  });
const liveCaller = Effect.gen(function* () {
  const context = yield* readCaller();
  const scope = yield* McpInvocationContext.requireThreadScope(context.scope, "Matrix answers");
  yield* assertLiveCaller(context);
  const check = context.threads.getThreadShell(scope.thread.threadId).pipe(
    Effect.mapError((cause) => new MatrixAnswerError({ reason: "unavailable", cause })),
    Effect.flatMap((shell) =>
      shell !== null &&
      shell.deletedAt === null &&
      isLiveCallerShell(shell, scope.thread.providerInstanceId)
        ? Effect.void
        : Effect.fail(new MatrixAnswerError({ reason: "not_found" })),
    ),
  );
  return { ...context, scope, check };
});
const metadata = (answer: Pick<MatrixAnswer, "id" | "revision" | "pinned">) => ({
  answerId: answer.id,
  revision: answer.revision,
  pinned: answer.pinned,
  message:
    "Saved in this conversation. Source values, units, dates, coverage and licenses retain provenance; growth/ratios are server-calculated. Missing data is not zero. Historical climate association is not causation; summary and explanations are model interpretation.",
});

export const layer = McpToolAccess.toLayer(MatrixToolkit, {
  matrix_research_catalog: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      yield* readCaller();
      const research = yield* ResearchData.ResearchData;
      return yield* research.catalog(input).pipe(
        Effect.mapError(
          (error) =>
            new OrchestratorMcpFailure({
              code: error.reason === "invalid_query" ? "invalid_request" : "orchestration_error",
              message: error.message,
            }),
        ),
      );
    }),
  ),
  matrix_research_data: McpToolAccess.reads(({ query, viewPolicy }) =>
    Effect.gen(function* () {
      const { scope } = yield* readCaller();
      const research = yield* ResearchData.ResearchData;
      const dataset = yield* research.query(query).pipe(
        Effect.mapError(
          (error) =>
            new OrchestratorMcpFailure({
              code: error.reason === "invalid_query" ? "invalid_request" : "orchestration_error",
              message: error.message,
            }),
        ),
      );
      let focused: MatrixAnswer | undefined;
      if (scope.thread !== undefined && viewPolicy !== "authored") {
        const service = yield* AnswerService.AnswerService;
        const workspace = yield* service
          .workspace(scope.thread.threadId)
          .pipe(Effect.mapError(answerFailure));
        for (const answer of workspace.answers) {
          if (
            answer.researchFocus !== undefined &&
            (focused === undefined || answer.updatedAt > focused.updatedAt)
          ) {
            focused = answer;
          }
        }
      }
      const focus = focused?.researchFocus;
      const view =
        focus === undefined
          ? undefined
          : {
              ...resolveResearchView(dataset, query),
              entities: focus.entities.filter((id) =>
                dataset.entities.some((entity) => entity.id === id),
              ),
            };
      const inspection = inspectResearchDataset(dataset, query, view);
      return view === undefined
        ? inspection
        : {
            ...inspection,
            warnings: [
              ...inspection.warnings,
              "This inspection uses the thread's saved reader geography, not a new country selection inferred from query.entities. Keep that focus for contextual follow-ups; use root viewPolicy:'authored' only to deliberately inspect a different geography. Uncovered selected countries are omitted, never replaced with World.",
            ],
          };
    }),
  ),
  matrix_sec_company: McpToolAccess.reads(({ symbol }) =>
    Effect.gen(function* () {
      yield* readCaller();
      const sec = yield* SecData.SecData;
      return yield* sec.company(symbol).pipe(
        Effect.mapError(
          (error) =>
            new OrchestratorMcpFailure({
              code:
                error.reason === "invalid_symbol" || error.reason === "not_found"
                  ? "invalid_request"
                  : "orchestration_error",
              message: `SEC research failed (${error.reason}). Check the identifier, data service and SEC access configuration. No substitute data was used.`,
            }),
        ),
      );
    }),
  ),
  matrix_present_answer: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const { scope, threads, check } = yield* liveCaller;
      const records = yield* threads
        .getThreadRecords(scope.thread.threadId, ["runs"], { messageRoles: [] })
        .pipe(Effect.mapError(unavailable));
      const run = records.runs
        .filter(
          (candidate) =>
            ThreadManagement.isActiveRun(candidate) &&
            candidate.providerInstanceId === scope.thread.providerInstanceId &&
            candidate.status !== "preparing",
        )
        .toSorted((left, right) => right.ordinal - left.ordinal)[0];
      if (run === undefined)
        return yield* new OrchestratorMcpFailure({
          code: "parent_not_active",
          message: "The calling provider no longer owns an active run for publishing an answer.",
        });
      const service = yield* AnswerService.AnswerService;
      return metadata(
        yield* service
          .present({ threadId: scope.thread.threadId, runId: run.id, input })
          .pipe(Effect.provideService(AnswerCallerCheck, check), Effect.mapError(answerFailure)),
      );
    }),
  ),
  matrix_inspect_answers: McpToolAccess.readsAsCaller(() =>
    Effect.gen(function* () {
      const { scope } = yield* liveCaller;
      const service = yield* AnswerService.AnswerService;
      const workspace = yield* service
        .workspace(scope.thread.threadId)
        .pipe(Effect.mapError(answerFailure));
      return {
        answers: workspace.answers.map((answer) => ({
          answerId: answer.id,
          revision: answer.revision,
          pinned: answer.pinned,
          spec: answer.spec,
          views: answer.views ?? [],
          researchFocus: answer.researchFocus ?? null,
          datasets: (answer.datasets ?? []).map((dataset) =>
            inspectResearchDataset(
              dataset,
              answer.spec.queries?.find((query) => query.id === dataset.id),
              answer.views?.find((entry) => entry.datasetId === dataset.id)?.view,
            ),
          ),
        })),
      };
    }),
  ),
  matrix_set_answer_pinned: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const { scope, check } = yield* liveCaller;
      const service = yield* AnswerService.AnswerService;
      return metadata(
        yield* service
          .setPinned({ ...input, threadId: scope.thread.threadId })
          .pipe(Effect.provideService(AnswerCallerCheck, check), Effect.mapError(answerFailure)),
      );
    }),
  ),
});
