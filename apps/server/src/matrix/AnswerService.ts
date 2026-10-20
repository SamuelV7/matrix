import {
  CommandId,
  MatrixAnswer,
  MatrixAnswerError,
  MatrixPresentAnswerInput,
  MatrixSetAnswerPinnedInput,
  MatrixSetAnswerViewInput,
  type MatrixWorkspace,
  type RunId,
  type ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { resolveResearchView } from "@t3tools/shared/matrixResearch";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as SecData from "./SecData.ts";
import * as ResearchData from "./ResearchData.ts";
import {
  decodeSpec,
  normalizeCompany,
  requestedMetrics,
  validResearchView,
  validateResearchAnswer,
} from "./answerData.ts";

export class AnswerService extends Context.Service<
  AnswerService,
  {
    readonly present: (input: {
      readonly threadId: ThreadId;
      readonly runId: RunId;
      readonly input: MatrixPresentAnswerInput;
    }) => Effect.Effect<MatrixAnswer, MatrixAnswerError>;
    readonly workspace: (threadId: ThreadId) => Effect.Effect<MatrixWorkspace, MatrixAnswerError>;
    readonly setPinned: (
      input: MatrixSetAnswerPinnedInput,
    ) => Effect.Effect<MatrixAnswer, MatrixAnswerError>;
    readonly setView: (
      input: MatrixSetAnswerViewInput,
    ) => Effect.Effect<MatrixAnswer, MatrixAnswerError>;
    readonly streamWorkspace: (
      threadId: ThreadId,
    ) => Stream.Stream<MatrixWorkspace, MatrixAnswerError>;
  }
>()("t3/matrix/AnswerService") {}

const isMatrixAnswerError = Schema.is(MatrixAnswerError);
const decodeAnswer = Schema.decodeEffect(MatrixAnswer);
const decodePresentInput = Schema.decodeEffect(MatrixPresentAnswerInput);
const decodePinInput = Schema.decodeEffect(MatrixSetAnswerPinnedInput);
const decodeViewInput = Schema.decodeEffect(MatrixSetAnswerViewInput);

const failure = (cause: unknown): MatrixAnswerError =>
  isMatrixAnswerError(cause) ? cause : new MatrixAnswerError({ reason: "unavailable", cause });
const invalidRequest = (cause: unknown) =>
  new MatrixAnswerError({ reason: "invalid_request", cause });

const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const sec = yield* SecData.SecData;
  const research = yield* ResearchData.ResearchData;
  const crypto = yield* Crypto.Crypto;

  const read = Effect.fn("AnswerService.read")(function* (threadId: ThreadId) {
    const shell = yield* orchestrator.getThreadShell(threadId).pipe(Effect.mapError(failure));
    if (shell === null || shell.deletedAt !== null || shell.archivedAt !== null)
      return yield* new MatrixAnswerError({ reason: "not_found" });
    const records = yield* orchestrator
      .getThreadRecords(threadId, ["turnItems"], {
        turnItemTypes: ["matrix_answer"],
        messageRoles: [],
      })
      .pipe(Effect.mapError(failure));
    if (records.thread.deletedAt !== null || records.thread.archivedAt !== null)
      return yield* new MatrixAnswerError({ reason: "not_found" });
    return records.turnItems.flatMap((item) =>
      item.type === "matrix_answer" ? [item.answer] : [],
    );
  });
  const workspace: AnswerService["Service"]["workspace"] = Effect.fn("AnswerService.workspace")(
    function* (threadId) {
      return { answers: yield* read(threadId) };
    },
  );
  const record = Effect.fn("AnswerService.record")(function* (
    answer: MatrixAnswer,
    runId: RunId | null,
    expectedRevision: number | null,
  ) {
    const validated = yield* decodeAnswer(answer).pipe(Effect.mapError(failure));
    yield* validateResearchAnswer(validated);
    const result = yield* orchestrator
      .dispatch({
        type: "matrix.answer.record",
        commandId: CommandId.make(
          `matrix-answer:${yield* crypto.randomUUIDv4().pipe(Effect.mapError(failure))}`,
        ),
        threadId: answer.threadId,
        runId,
        expectedRevision,
        answer: validated,
      })
      .pipe(Effect.mapError(failure));
    // Return the exact committed revision, not a later concurrent writer's snapshot.
    for (const stored of result.storedEvents) {
      if (
        stored.event.type === "turn-item.updated" &&
        stored.event.payload.type === "matrix_answer" &&
        stored.event.payload.id === answer.id
      )
        return stored.event.payload.answer;
    }
    return yield* new MatrixAnswerError({ reason: "unavailable" });
  });
  const present: AnswerService["Service"]["present"] = Effect.fn("AnswerService.present")(
    function* ({ threadId, runId, input }) {
      const parsed = yield* decodePresentInput(input).pipe(Effect.mapError(invalidRequest));
      if ((parsed.answerId === undefined) !== (parsed.expectedRevision === undefined))
        return yield* new MatrixAnswerError({ reason: "invalid_request" });
      const spec = yield* decodeSpec(parsed.spec);
      const answers = yield* read(threadId);
      const existing =
        parsed.answerId === undefined
          ? undefined
          : answers.find((answer) => answer.id === parsed.answerId);
      if (parsed.answerId !== undefined && existing === undefined)
        return yield* new MatrixAnswerError({ reason: "not_found" });
      if (existing !== undefined && existing.revision !== parsed.expectedRevision)
        return yield* new MatrixAnswerError({ reason: "conflict" });
      const metrics = requestedMetrics(spec);
      const companies = yield* Effect.forEach(
        spec.symbols,
        (symbol) =>
          sec.company(symbol).pipe(
            Effect.map((company) => normalizeCompany(symbol, company, metrics)),
            Effect.mapError(
              (cause) =>
                new MatrixAnswerError({
                  reason:
                    cause.reason === "invalid_symbol"
                      ? "invalid_request"
                      : cause.reason === "not_found"
                        ? "not_found"
                        : "unavailable",
                  cause,
                }),
            ),
          ),
        { concurrency: 4 },
      );
      if (
        new Set(companies.map((company) => company.cik.replace(/^0+/, ""))).size !==
        companies.length
      )
        return yield* new MatrixAnswerError({ reason: "invalid_request" });
      const now = DateTime.formatIso(yield* DateTime.now);
      const datasets = yield* Effect.forEach(
        spec.queries ?? [],
        (query) =>
          research.query(query).pipe(
            Effect.mapError(
              (cause) =>
                new MatrixAnswerError({
                  reason: cause.reason === "invalid_query" ? "invalid_request" : "unavailable",
                  cause,
                }),
            ),
          ),
        { concurrency: 3 },
      );
      const preserve =
        existing !== undefined &&
        (existing.lastPresentedRunId === runId || parsed.viewPolicy !== "authored");
      const previousBlocks = existing?.spec.blocks ?? [];
      const previousView = existing?.views?.findLast((entry) =>
        previousBlocks.some((block) => "dataset" in block && block.dataset === entry.datasetId),
      )?.view;
      const previousFocus = preserve
        ? (existing?.researchFocus ??
          (previousView === undefined ? undefined : { entities: previousView.entities }))
        : undefined;
      const views = datasets.map((dataset) => {
        const saved = preserve
          ? existing?.views?.find((entry) => entry.datasetId === dataset.id)?.view
          : undefined;
        const map = spec.blocks.find(
          (block) => block.kind === "map" && block.dataset === dataset.id,
        );
        const inherited =
          previousFocus === undefined
            ? undefined
            : {
                entities: previousFocus.entities.filter((id) =>
                  dataset.entities.some((entity) => entity.id === id),
                ),
                year: null,
                measure: null,
              };
        return {
          datasetId: dataset.id,
          view: resolveResearchView(
            dataset,
            spec.queries?.find((query) => query.id === dataset.id),
            saved !== undefined && validResearchView(dataset, saved) ? saved : inherited,
            map?.kind === "map" ? map.measure : undefined,
          ),
        };
      });
      const primaryBlock = spec.blocks.find((block) => "dataset" in block);
      const primaryView =
        primaryBlock !== undefined && "dataset" in primaryBlock
          ? views.find((entry) => entry.datasetId === primaryBlock.dataset)?.view
          : undefined;
      const entityIds = new Set(
        datasets.flatMap((dataset) => dataset.entities.map((entity) => entity.id)),
      );
      const researchFocus = {
        entities: (previousFocus?.entities ?? primaryView?.entities ?? []).filter((id) =>
          entityIds.has(id),
        ),
      };
      return yield* record(
        {
          id:
            existing?.id ??
            TurnItemId.make(
              `matrix-answer:${yield* crypto.randomUUIDv4().pipe(Effect.mapError(failure))}`,
            ),
          threadId,
          revision: (existing?.revision ?? 0) + 1,
          pinned: existing?.pinned ?? false,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
          lastPresentedRunId: runId,
          spec,
          companies,
          ...(datasets.length === 0 ? {} : { datasets, views, researchFocus }),
        },
        runId,
        existing?.revision ?? null,
      );
    },
  );
  const setPinned: AnswerService["Service"]["setPinned"] = Effect.fn("AnswerService.setPinned")(
    function* (input) {
      const parsed = yield* decodePinInput(input).pipe(Effect.mapError(invalidRequest));
      const existing = (yield* read(parsed.threadId)).find(
        (answer) => answer.id === parsed.answerId,
      );
      if (existing === undefined) return yield* new MatrixAnswerError({ reason: "not_found" });
      if (existing.revision !== parsed.expectedRevision)
        return yield* new MatrixAnswerError({ reason: "conflict" });
      return yield* record(
        {
          ...existing,
          revision: existing.revision + 1,
          pinned: parsed.pinned,
          updatedAt: DateTime.formatIso(yield* DateTime.now),
        },
        null,
        parsed.expectedRevision,
      );
    },
  );
  const setView: AnswerService["Service"]["setView"] = Effect.fn("AnswerService.setView")(
    function* (input) {
      const parsed = yield* decodeViewInput(input).pipe(Effect.mapError(invalidRequest));
      const existing = (yield* read(parsed.threadId)).find(
        (answer) => answer.id === parsed.answerId,
      );
      if (existing === undefined) return yield* new MatrixAnswerError({ reason: "not_found" });
      if (existing.revision !== parsed.expectedRevision)
        return yield* new MatrixAnswerError({ reason: "conflict" });
      const dataset = existing.datasets?.find((dataset) => dataset.id === parsed.datasetId);
      if (dataset === undefined || !validResearchView(dataset, parsed.view))
        return yield* new MatrixAnswerError({ reason: "invalid_request" });
      return yield* record(
        {
          ...existing,
          revision: existing.revision + 1,
          updatedAt: DateTime.formatIso(yield* DateTime.now),
          researchFocus: { entities: parsed.view.entities },
          views: [
            ...(existing.views ?? []).filter((entry) => entry.datasetId !== parsed.datasetId),
            { datasetId: parsed.datasetId, view: parsed.view },
          ],
        },
        null,
        parsed.expectedRevision,
      );
    },
  );
  const streamWorkspace: AnswerService["Service"]["streamWorkspace"] = (threadId) =>
    Stream.unwrap(
      Effect.gen(function* () {
        // Cursor precedes the snapshot. Durable replay closes both snapshot/subscription
        // races, including changes while an initial snapshot is in flight.
        const afterSequence = yield* orchestrator
          .getThreadEventSequence(threadId)
          .pipe(Effect.mapError(failure));
        const initial = yield* workspace(threadId);
        return Stream.concat(
          Stream.succeed(initial),
          orchestrator.streamStoredEventsFrom({ threadId, afterSequence }).pipe(
            Stream.mapError(failure),
            Stream.filter(
              ({ event }) =>
                event.type === "thread.deleted" ||
                event.type === "thread.archived" ||
                (event.type === "turn-item.updated" && event.payload.type === "matrix_answer"),
            ),
            Stream.mapEffect(() => workspace(threadId)),
          ),
        );
      }),
    );
  return AnswerService.of({ present, workspace, setPinned, setView, streamWorkspace });
});

export const layer = Layer.effect(AnswerService, make);
