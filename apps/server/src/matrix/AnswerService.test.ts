import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MatrixAnswer,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  RunId,
  type MatrixAnswerSpec,
  type MatrixSecCompany,
} from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../mcp/McpToolAccess.ts";
import * as MatrixHandlers from "../mcp/toolkits/matrix/handlers.ts";
import { MatrixToolkit } from "../mcp/toolkits/matrix/tools.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { AnswerService, layer } from "./AnswerService.ts";
import { decodeSpec, normalizeCompany } from "./answerData.ts";
import * as SecData from "./SecData.ts";
import * as ResearchData from "./ResearchData.ts";
import * as WdiData from "./WdiData.ts";

const decodeAnswer = Schema.decodeEffect(MatrixAnswer);
type Observation = MatrixSecCompany["metrics"][number]["observations"][number];
const point = (value: number, overrides: Partial<Observation> = {}): Observation => ({
  start: "2024-01-01",
  end: "2024-12-31",
  filed: "2025-02-01",
  form: "10-K",
  accession: "0000000001-25-000001",
  tag: "us-gaap:Revenue",
  value,
  url: "https://www.sec.gov/Archives/edgar/data/1/000000000125000001/",
  ...overrides,
});
const company = (metrics: MatrixSecCompany["metrics"]): MatrixSecCompany => ({
  company: {
    cik: "0000000001",
    name: "Example Company",
    tickers: ["EX"],
    exchanges: ["NYSE"],
    sic: "3571",
    industry: "Electronic Computers",
    fiscalYearEnd: "1231",
  },
  metrics,
  filings: [],
  sources: [
    {
      label: "SEC company facts",
      url: "https://data.sec.gov/api/xbrl/companyfacts/CIK0000000001.json",
      fetchedAt: "2025-02-01T00:00:00Z",
    },
  ],
  warnings: [],
});
const metric = (id: string, observations: Observation[], unit = "USD") => ({
  id,
  label: id,
  description: "Reported fact",
  unit,
  observations,
});
const financialData = company([
  metric("revenue", [point(100)]),
  metric("netIncome", [point(25, { tag: "us-gaap:NetIncomeLoss" })]),
  metric("operatingCashFlow", [
    point(-10, { tag: "us-gaap:NetCashProvidedByUsedInOperatingActivities" }),
  ]),
]);
const spec: MatrixAnswerSpec = {
  title: "Annual profitability",
  summary: "Interpretation: annual net margin is shown below, not a forecast.",
  level: "guided",
  symbols: ["EX"],
  blocks: [{ id: "profit", kind: "chart", metric: "netMargin", chartType: "line" }],
  sections: [{ id: "performance", label: "Performance", columns: 1, blockIds: ["profit"] }],
};

const overviewSpec: MatrixAnswerSpec = {
  title: "About Example Company",
  summary: "A compact introduction with sourced identity and an explanatory business model.",
  level: "guided",
  symbols: ["EX"],
  blocks: [
    { id: "identity", kind: "company" },
    {
      id: "model",
      kind: "diagram",
      title: "How the business works",
      nodes: [
        { id: "product", label: "Products", detail: "Interpretation: products serve customers." },
        { id: "customer", label: "Customers", detail: "Interpretation: customers use products." },
      ],
      edges: [{ from: "product", to: "customer", label: "serves" }],
    },
    {
      id: "next",
      kind: "actions",
      title: "Explore further",
      prompts: ["How has Example Company's revenue changed?", "Explain its business model."],
    },
  ],
  sections: [
    { id: "overview", label: "Overview", columns: 2, blockIds: ["identity", "model"] },
    { id: "explore", label: "Explore", columns: 1, blockIds: ["next"] },
  ],
};
const qualitativeSpec: MatrixAnswerSpec = {
  ...overviewSpec,
  title: "How products reach customers",
  symbols: [],
  blocks: overviewSpec.blocks.filter((block) => block.kind !== "company"),
  sections: [{ id: "model", label: "Business model", columns: 1, blockIds: ["model", "next"] }],
};

it("calculates finite matching-filing annual margins with both exact sources and reported signs", () => {
  const normalized = normalizeCompany("EX", financialData, [
    "revenue",
    "netMargin",
    "operatingCashFlowMargin",
    "assets",
  ]);
  assert.deepEqual(normalized.profile, financialData.company);
  const net = normalized.metrics[1]!;
  assert.equal(net.unit, "percent");
  assert.equal(net.observations[0]!.value, 25);
  assert.deepEqual(
    net.observations[0]!.sources.map((source) => source.tag),
    ["us-gaap:NetIncomeLoss", "us-gaap:Revenue"],
  );
  assert.equal(net.observations[0]!.start, "2024-01-01");
  assert.equal(net.observations[0]!.end, "2024-12-31");
  assert.equal(normalized.metrics[2]!.observations[0]!.value, -10);
  assert.deepEqual(normalized.metrics[3]!.observations, []);
  assert.isTrue(
    normalized.warnings.some((warning) => warning.includes("Missing values are not zero")),
  );
});

it("does not repair mismatched periods, unrelated filing contexts, missing or zero denominators", () => {
  for (const revenue of [
    [],
    [point(0)],
    [point(100, { start: "2024-01-02" })],
    [point(100, { accession: "0000000001-25-000002" })],
  ]) {
    const normalized = normalizeCompany(
      "EX",
      company([metric("revenue", revenue), metric("netIncome", [point(25)])]),
      ["netMargin"],
    );
    assert.deepEqual(normalized.metrics[0]!.observations, []);
  }
});

it("drops same-day conflicts, unsafe links, nonannual/nonfinite and non-USD facts without inventing zero", () => {
  const normalized = normalizeCompany(
    "EX",
    company([
      metric("revenue", [
        point(100),
        point(101),
        point(Infinity, { end: "2023-12-31" }),
        point(40, { end: "2022-12-31", start: "2022-10-01" }),
        point(90, { url: "https://sec.gov.evil.example/facts" }),
      ]),
      metric("assets", [point(20, { start: null })], "EUR"),
    ]),
    ["revenue", "assets"],
  );
  assert.deepEqual(
    normalized.metrics.map((entry) => entry.observations),
    [[], []],
  );
  assert.isTrue(normalized.warnings.some((warning) => warning.includes("conflicting")));
});

it("selects latest supported annual disclosures and limits stored history to twenty periods", () => {
  const observations = Array.from({ length: 24 }, (_, index) => {
    const year = 2000 + index;
    return point(year, {
      start: `${year}-01-01`,
      end: `${year}-12-31`,
      filed: `${year + 1}-02-01`,
    });
  });
  observations.push(point(999, { start: "2023-01-01", end: "2023-12-31", filed: "2025-02-01" }));
  const result = normalizeCompany("EX", company([metric("revenue", observations)]), ["revenue"]);
  assert.lengthOf(result.metrics[0]!.observations, 20);
  assert.equal(result.metrics[0]!.observations[0]!.end, "2004-12-31");
  assert.equal(result.metrics[0]!.observations.at(-1)!.value, 999);
});

it.effect(
  "rejects invalid data requirements, section coverage, action prompts and diagram graphs",
  () =>
    Effect.gen(function* () {
      const invalid = [
        { ...spec, symbols: ["ex", "EX"] },
        { ...spec, blocks: [spec.blocks[0], spec.blocks[0]] },
        { ...spec, symbols: [] },
        { ...spec, blocks: [{ id: "bad", kind: "metric", metric: "stockPrice" }] },
        { ...spec, blocks: [{ id: "bad", kind: "table", metrics: ["revenue", "revenue"] }] },
        ...["company", "metric", "chart", "table", "filings"].map((kind) => ({
          ...spec,
          symbols: [],
          blocks: [
            {
              id: "data",
              kind,
              metric: "revenue",
              chartType: "line",
              metrics: ["revenue"],
              title: "Disclosures",
            },
          ],
          sections: undefined,
        })),
        { ...spec, sections: [{ id: "empty", label: "Empty", columns: 1, blockIds: [] }] },
        { ...spec, sections: [{ id: "bad", label: "Bad", columns: 1, blockIds: ["unknown"] }] },
        {
          ...spec,
          sections: [{ id: "repeat", label: "Repeat", columns: 1, blockIds: ["profit", "profit"] }],
        },
        {
          ...overviewSpec,
          sections: [{ id: "partial", label: "Partial", columns: 1, blockIds: ["identity"] }],
        },
        {
          ...overviewSpec,
          sections: overviewSpec.sections!.map((section) => ({ ...section, id: "same" })),
        },
        {
          ...qualitativeSpec,
          blocks: [
            {
              id: "one",
              kind: "actions",
              title: "Next",
              prompts: ["Explain more", "Explain more"],
            },
          ],
          sections: undefined,
        },
        {
          ...qualitativeSpec,
          blocks: [
            { id: "one", kind: "actions", title: "Next", prompts: ["Explain more"] },
            { id: "two", kind: "actions", title: "Also", prompts: ["Explain more"] },
          ],
          sections: undefined,
        },
        ...[
          [{ from: "product", to: "missing" }],
          [{ from: "product", to: "product" }],
          [
            { from: "product", to: "customer" },
            { from: "product", to: "customer" },
          ],
          [
            { from: "product", to: "customer" },
            { from: "customer", to: "product" },
          ],
        ].map((edges) => ({
          ...qualitativeSpec,
          blocks: [{ ...overviewSpec.blocks[1], edges }],
          sections: undefined,
        })),
        {
          ...qualitativeSpec,
          blocks: [
            {
              ...overviewSpec.blocks[1],
              nodes: [
                { id: "same", label: "One", detail: "First" },
                { id: "same", label: "Two", detail: "Second" },
              ],
              edges: [],
            },
          ],
          sections: undefined,
        },
      ];
      for (const input of invalid)
        assert.equal((yield* decodeSpec(input).pipe(Effect.flip)).reason, "invalid_request");
      assert.deepEqual(
        (yield* decodeSpec({
          ...spec,
          symbols: [],
          sections: undefined,
          blocks: [
            { id: "text", kind: "explanation", title: "Context", text: "Interpretation only." },
          ],
        })).symbols,
        [],
      );
      assert.deepEqual(yield* decodeSpec(overviewSpec), overviewSpec);
      assert.deepEqual(yield* decodeSpec(qualitativeSpec), qualitativeSpec);
    }),
);

// Existing orchestration harness: no worker and no provider events/processes.
const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Publishing Matrix answers does not launch a provider"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const database = SqlitePersistence.layerMemory;
const orchestration = Layer.mergeAll(
  ProviderReplayHarness.layerWithRegistry(
    { name: "matrix-answers" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: database, runEffectWorker: false },
  ),
  ProjectionStore.layer.pipe(Layer.provide(database)),
);
const secTransport = SecData.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      ConfigProvider.layer(
        ConfigProvider.fromEnv({
          env: { MATRIX_DATA_URL: "http://127.0.0.1:7399", MATRIX_DATA_TOKEN: "a".repeat(32) },
        }),
      ),
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(financialData))),
        ),
      ),
    ),
  ),
);
const cropEntities = [
  { id: 37, name: "Brazil", code: "BRA" },
  { id: 13, name: "United States", code: "USA" },
  { id: 355, name: "World", code: "OWID_WRL" },
];
const cropTransport = ResearchData.layer.pipe(
  Layer.provide(WdiData.layer),
  Layer.provide(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) => {
        const url = new URL(request.url);
        if (url.pathname.startsWith("/v2/sources/2/series/")) {
          const code = url.pathname.split("/").at(-2)!;
          const metatype = [
            { id: "Unitofmeasure", value: code === "NY.GDP.MKTP.KD.ZG" ? "%" : "Unit" },
            { id: "Periodicity", value: "Annual" },
            { id: "License_Type", value: "CC BY-4.0" },
            { id: "License_URL", value: "https://datacatalog.worldbank.org/public-licenses#cc-by" },
            {
              id: "Aggregationmethod",
              value: code === "NY.GDP.MKTP.KD.ZG" ? "Weighted average" : "Sum",
            },
            { id: "Referenceperiod", value: "1960-2025" },
            {
              id: "Longdefinition",
              value:
                code === "NY.GDP.MKTP.KD.ZG"
                  ? "Percentage change over each previous year of the constant price series."
                  : "Midyear population estimates.",
            },
          ];
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json({
                page: 1,
                pages: 1,
                per_page: "5000",
                total: metatype.length,
                source: [
                  { id: "2", concept: [{ id: "Series", variable: [{ id: code, metatype }] }] },
                ],
              }),
            ),
          );
        }
        if (url.pathname === "/v2/source/2/indicator") {
          const indicators = [
            {
              id: "NY.GDP.MKTP.KD.ZG",
              name: "GDP growth (annual %)",
              unit: "",
              source: { id: "2", value: "World Development Indicators" },
              sourceNote:
                "Annual percentage growth rate of GDP at market prices based on constant local currency.",
              sourceOrganization: "World Bank national accounts data",
              topics: [{ id: "3", value: "Economy & Growth" }],
            },
            {
              id: "SP.POP.TOTL",
              name: "Population, total",
              unit: "",
              source: { id: "2", value: "World Development Indicators" },
              sourceNote: "Total population.",
              sourceOrganization: "United Nations",
              topics: [{ id: "19", value: "Population" }],
            },
          ];
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json([
                { page: 1, pages: 1, per_page: "10000", total: indicators.length },
                indicators,
              ]),
            ),
          );
        }
        if (url.pathname === "/v2/country") {
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json([
                { page: 1, pages: 1, per_page: "1000", total: 3 },
                [
                  { id: "BRA", name: "Brazil", region: { id: "LCN" } },
                  { id: "USA", name: "United States", region: { id: "NAC" } },
                  { id: "WLD", name: "World", region: { id: "NA" } },
                ],
              ]),
            ),
          );
        }
        if (url.pathname.startsWith("/v2/country/all/indicator/")) {
          const code = url.pathname.split("/").at(-1)!;
          const rows = [
            {
              indicator: { id: code },
              countryiso3code: "USA",
              date: "2024",
              value: code === "NY.GDP.MKTP.KD.ZG" ? 2.79318715363841 : 110,
              unit: "",
            },
            {
              indicator: { id: code },
              countryiso3code: "USA",
              date: "2023",
              value: code === "NY.GDP.MKTP.KD.ZG" ? 2.93436322440155 : 100,
              unit: "",
            },
            {
              indicator: { id: code },
              countryiso3code: "WLD",
              date: "2024",
              value: null,
              unit: "",
            },
          ];
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json([
                {
                  page: 1,
                  pages: 1,
                  per_page: 20000,
                  total: rows.length,
                  sourceid: "2",
                  lastupdated: "2026-10-08",
                },
                rows,
              ]),
            ),
          );
        }
        const id = /\/(\d+)\./.exec(request.url)?.[1];
        const metadata = request.url.includes(".metadata.json");
        const unit =
          id === "1198618" ? "hectares" : id === "1198624" ? "tonnes per hectare" : "tonnes";
        const values =
          id === "1198618"
            ? [22315010, 21186816, 35010952, 33547180, 211099136, 209954368]
            : id === "1198624"
              ? [5.913, 5.4257007, 11.1306, 11.256801, 5.8673, 5.8022003]
              : [131949710, 114953304, 389694460, 377632700, 1238582500, 1218205600];
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json(
              metadata
                ? {
                    id: Number(id),
                    name: "Maize | FAO annual observations",
                    unit,
                    datasetId: 7391,
                    datasetVersion: "2026-02-25",
                    timespan: "1961-2024",
                    dimensions: { entities: { values: cropEntities } },
                    origins: [
                      {
                        producer: "Food and Agriculture Organization of the United Nations",
                        title: "Production: Crops and livestock products",
                        datePublished: "2025-12-31",
                        license: { name: "CC BY-NC-SA 3.0 IGO" },
                      },
                    ],
                  }
                : {
                    values,
                    years: [2023, 2024, 2023, 2024, 2023, 2024],
                    entities: [37, 37, 13, 13, 355, 355],
                  },
            ),
          ),
        );
      }),
    ),
  ),
);
const dependencies = Layer.mergeAll(orchestration, secTransport, cropTransport, NodeCrypto.layer);
const testLayer = layer.pipe(Layer.provideMerge(dependencies));
const startThread = Effect.fnUntraced(function* (threadId: ThreadId) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`create:${threadId}`),
    threadId,
    projectId: ProjectId.make("project:matrix-answers"),
    title: "Research",
    modelSelection: { instanceId, model: "test" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  yield* orchestrator.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make(`message:${threadId}`),
    threadId,
    messageId: MessageId.make(`message:${threadId}`),
    text: "Research",
    attachments: [],
    dispatchMode: { type: "defer_start" },
    createdBy: "user",
    creationSource: "web",
  });
  const run = (yield* orchestrator.getThreadRecords(threadId, ["runs"])).runs[0]!;
  yield* orchestrator.dispatch({
    type: "prepared-run.release",
    commandId: CommandId.make(`release:${threadId}`),
    threadId,
    runId: run.id,
  });
  return run.id;
});

it.effect(
  "persists updates/pins on one original anchor and rejects stale, foreign and duplicate identities",
  () =>
    Effect.gen(function* () {
      const service = yield* AnswerService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("thread:answers");
      const runId = yield* startThread(threadId);
      const first = yield* service.present({ threadId, runId, input: { spec } });
      const anchor = yield* orchestrator.getTurnItem({ threadId, itemId: first.id });
      assert.equal(first.lastPresentedRunId, runId);
      assert.deepEqual(first.companies[0]!.profile, financialData.company);
      const { lastPresentedRunId: _presentation, ...legacy } = first;
      const oldAnswer = yield* decodeAnswer({
        ...legacy,
        companies: first.companies.map(({ profile: _profile, ...oldCompany }) => oldCompany),
      });
      assert.isUndefined(oldAnswer.lastPresentedRunId);
      assert.isUndefined(oldAnswer.companies[0]!.profile);
      const pinned = yield* service.setPinned({
        threadId,
        answerId: first.id,
        expectedRevision: 1,
        pinned: true,
      });
      assert.equal(pinned.lastPresentedRunId, runId);
      const updated = yield* service.present({
        threadId,
        runId,
        input: {
          answerId: first.id,
          expectedRevision: pinned.revision,
          spec: { ...spec, title: "Updated interpretation" },
        },
      });
      assert.equal(updated.revision, 3);
      assert.isTrue(updated.pinned);
      assert.equal(updated.createdAt, first.createdAt);
      assert.equal(updated.lastPresentedRunId, runId);
      const finalAnchor = yield* orchestrator.getTurnItem({ threadId, itemId: first.id });
      assert.deepEqual(
        [finalAnchor?.runId, finalAnchor?.nodeId, finalAnchor?.ordinal, finalAnchor?.startedAt],
        [anchor?.runId, anchor?.nodeId, anchor?.ordinal, anchor?.startedAt],
      );
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      assert.isTrue(
        (yield* projections.getTurnStartHistory(threadId)).some(
          (item) => item.id === first.id && item.type === "matrix_answer",
        ),
      );
      assert.isTrue(
        (yield* orchestrator.getTimelinePage(threadId, { view: "messages", limit: 50 })).items.some(
          (row) => row.item.id === first.id,
        ),
      );
      for (const [id, run, answer] of [
        ["model-pin-tamper", runId, { ...updated, revision: 4, pinned: false }],
        [
          "pin-spec-tamper",
          null,
          { ...updated, revision: 4, spec: { ...updated.spec, summary: "Not a pin-only change" } },
        ],
        [
          "pin-presentation-tamper",
          null,
          {
            ...updated,
            revision: 4,
            lastPresentedRunId: RunId.make("run:forged"),
          },
        ],
        [
          "pin-presentation-removal",
          null,
          {
            ...updated,
            revision: 4,
            lastPresentedRunId: undefined,
          },
        ],
        [
          "present-run-mismatch",
          runId,
          {
            ...updated,
            revision: 4,
            lastPresentedRunId: RunId.make("run:forged"),
          },
        ],
        [
          "present-run-missing",
          runId,
          {
            ...updated,
            revision: 4,
            lastPresentedRunId: undefined,
          },
        ],
        ["revision-skip", runId, { ...updated, revision: 5 }],
      ] as const) {
        const error = yield* orchestrator
          .dispatch({
            type: "matrix.answer.record",
            commandId: CommandId.make(id),
            threadId,
            runId: run,
            expectedRevision: 3,
            answer,
          })
          .pipe(Effect.flip);
        assert.equal(error._tag, "MatrixAnswerError");
        if (error._tag === "MatrixAnswerError") assert.equal(error.reason, "invalid_request");
      }
      assert.equal(
        (yield* service
          .setPinned({ threadId, answerId: first.id, expectedRevision: 1, pinned: false })
          .pipe(Effect.flip)).reason,
        "conflict",
      );
      const other = ThreadId.make("thread:other");
      const otherRun = yield* startThread(other);
      assert.equal(
        (yield* service
          .present({
            threadId: other,
            runId: otherRun,
            input: { answerId: first.id, expectedRevision: 3, spec },
          })
          .pipe(Effect.flip)).reason,
        "not_found",
      );
      assert.equal(
        (yield* service.present({ threadId, runId: otherRun, input: { spec } }).pipe(Effect.flip))
          .reason,
        "not_found",
      );
      const duplicate = yield* orchestrator
        .dispatch({
          type: "matrix.answer.record",
          commandId: CommandId.make("duplicate-answer"),
          threadId,
          runId,
          expectedRevision: null,
          answer: first,
        })
        .pipe(Effect.flip);
      assert.equal(duplicate._tag, "MatrixAnswerError");
      const foreign = yield* orchestrator
        .dispatch({
          type: "matrix.answer.record",
          commandId: CommandId.make("foreign-answer"),
          threadId: other,
          runId: otherRun,
          expectedRevision: null,
          answer: { ...first, threadId: other },
        })
        .pipe(Effect.flip);
      assert.equal(foreign._tag, "MatrixAnswerError");
      const reloaded = yield* AnswerService.use((fresh) => fresh.workspace(threadId)).pipe(
        Effect.provide(layer),
      );
      assert.deepEqual(reloaded.answers, [updated]);
      const throughSequence = yield* orchestrator.getThreadEventSequence(threadId);
      const committed = yield* orchestrator
        .streamStoredEventsFrom({ threadId, afterSequence: 0 })
        .pipe(
          Stream.takeUntil((stored) => stored.sequence === throughSequence),
          Stream.runCollect,
        );
      const replayed = yield* Effect.gen(function* () {
        const restored = yield* ProjectionStore.ProjectionStoreV2;
        yield* Effect.forEach(committed, (stored) => restored.apply(stored.event), {
          discard: true,
        });
        return yield* restored.getTurnItem({ threadId, itemId: first.id });
      }).pipe(Effect.provide(ProjectionStore.layerMemory));
      assert.equal(replayed?.type, "matrix_answer");
      if (replayed?.type === "matrix_answer") assert.deepEqual(replayed.answer, updated);
      yield* orchestrator.dispatch({
        type: "run.interrupt",
        commandId: CommandId.make("end-answer-run"),
        threadId,
        runId,
      });
      const settledPin = yield* service.setPinned({
        threadId,
        answerId: first.id,
        expectedRevision: 3,
        pinned: false,
      });
      assert.equal(settledPin.revision, 4);
      assert.equal(settledPin.lastPresentedRunId, runId);
      assert.equal(
        (yield* service
          .present({ threadId, runId, input: { answerId: first.id, expectedRevision: 4, spec } })
          .pipe(Effect.flip)).reason,
        "not_found",
      );
      yield* orchestrator.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("archive-answers"),
        threadId,
      });
      assert.equal((yield* service.workspace(threadId).pipe(Effect.flip)).reason, "not_found");
      assert.equal(
        (yield* service
          .setPinned({ threadId, answerId: first.id, expectedRevision: 4, pinned: true })
          .pipe(Effect.flip)).reason,
        "not_found",
      );
    }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "moves presentation to a follow-up run while preserving one pinned persisted anchor and CAS",
  () =>
    Effect.gen(function* () {
      const service = yield* AnswerService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("thread:answer-followup");
      const firstRunId = yield* startThread(threadId);
      const first = yield* service.present({
        threadId,
        runId: firstRunId,
        input: { spec: overviewSpec },
      });
      const pinned = yield* service.setPinned({
        threadId,
        answerId: first.id,
        expectedRevision: 1,
        pinned: true,
      });
      const anchor = yield* orchestrator.getTurnItem({ threadId, itemId: first.id });
      yield* orchestrator.dispatch({
        type: "run.interrupt",
        commandId: CommandId.make("followup:interrupt"),
        threadId,
        runId: firstRunId,
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("followup:message"),
        threadId,
        messageId: MessageId.make("followup:message"),
        text: "Explain its business model.",
        attachments: [],
        dispatchMode: { type: "defer_start" },
        createdBy: "user",
        creationSource: "web",
      });
      const nextRun = (yield* orchestrator.getThreadRecords(threadId, ["runs"])).runs.find(
        (run) => run.id !== firstRunId,
      )!;
      yield* orchestrator.dispatch({
        type: "prepared-run.release",
        commandId: CommandId.make("followup:release"),
        threadId,
        runId: nextRun.id,
      });
      const updated = yield* service.present({
        threadId,
        runId: nextRun.id,
        input: {
          answerId: first.id,
          expectedRevision: pinned.revision,
          spec: qualitativeSpec,
        },
      });
      assert.equal(updated.id, first.id);
      assert.equal(updated.lastPresentedRunId, nextRun.id);
      assert.equal(updated.createdAt, first.createdAt);
      assert.isTrue(updated.pinned);
      assert.deepEqual(updated.companies, []);
      const moved = yield* orchestrator.getTurnItem({ threadId, itemId: first.id });
      assert.deepEqual(
        [moved?.id, moved?.runId, moved?.nodeId, moved?.ordinal, moved?.startedAt],
        [anchor?.id, anchor?.runId, anchor?.nodeId, anchor?.ordinal, anchor?.startedAt],
      );
      assert.equal(
        (yield* service
          .setPinned({
            threadId,
            answerId: first.id,
            expectedRevision: pinned.revision,
            pinned: false,
          })
          .pipe(Effect.flip)).reason,
        "conflict",
      );
      const unpinned = yield* service.setPinned({
        threadId,
        answerId: first.id,
        expectedRevision: updated.revision,
        pinned: false,
      });
      assert.equal(unpinned.lastPresentedRunId, nextRun.id);
      assert.deepEqual((yield* service.workspace(threadId)).answers, [unpinned]);
    }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "serializes concurrent revisions and replays updates made before the live stream attaches",
  () =>
    Effect.gen(function* () {
      const service = yield* AnswerService;
      const threadId = ThreadId.make("thread:answer-races");
      const runId = yield* startThread(threadId);
      const first = yield* service.present({ threadId, runId, input: { spec } });
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const revisions: number[] = [];
      const consumer = yield* service.streamWorkspace(threadId).pipe(
        Stream.take(2),
        Stream.runForEach((workspace) =>
          Effect.gen(function* () {
            revisions.push(workspace.answers[0]!.revision);
            if (revisions.length === 1) {
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
            }
          }),
        ),
        Effect.forkChild,
      );
      yield* Deferred.await(entered);
      const results = yield* Effect.all(
        [
          service
            .setPinned({ threadId, answerId: first.id, expectedRevision: 1, pinned: true })
            .pipe(Effect.exit),
          service
            .present({
              threadId,
              runId,
              input: {
                answerId: first.id,
                expectedRevision: 1,
                spec: { ...spec, summary: "Concurrent interpretation" },
              },
            })
            .pipe(Effect.exit),
        ],
        { concurrency: "unbounded" },
      );
      assert.equal(results.filter(Exit.isSuccess).length, 1);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(consumer);
      assert.deepEqual(revisions, [1, 2]);
      assert.equal((yield* service.workspace(threadId)).answers[0]!.revision, 2);
    }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "refuses dead or external MCP callers and publishes/inspects/pins only the caller's thread",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("thread:mcp-answers");
      const runId = yield* startThread(threadId);
      const threads = Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: orchestrator.getThreadShell,
        getThreadRecords: orchestrator.getThreadRecords,
      });
      const invocation = McpInvocationContext.McpInvocationContext.of({
        environmentId: EnvironmentId.make("environment:test"),
        requestNamespace: "provider:test",
        capabilities: new Set(["orchestration"]),
        issuedAt: 0,
        client: undefined,
        thread: { threadId, providerSessionId: "session:test", providerInstanceId: instanceId },
      });
      const invoke = (scope: typeof invocation) =>
        Effect.gen(function* () {
          const tools = yield* MatrixToolkit;
          const published = yield* tools
            .handle("matrix_present_answer", { spec: overviewSpec })
            .pipe(Stream.unwrap, Stream.runCollect);
          const result = published.at(-1)!.result;
          if ("answerId" in result) {
            const inspected = yield* tools
              .handle("matrix_inspect_answers", {})
              .pipe(Stream.unwrap, Stream.runCollect);
            const inspection = inspected.at(-1)!.result;
            assert.deepEqual(
              "answers" in inspection ? inspection.answers.map((answer) => answer.answerId) : [],
              [result.answerId],
            );
            const pinned = yield* tools
              .handle("matrix_set_answer_pinned", {
                answerId: result.answerId,
                expectedRevision: 1,
                pinned: true,
              })
              .pipe(Stream.unwrap, Stream.runCollect);
            assert.include(pinned.at(-1)!.result, {
              answerId: result.answerId,
              revision: 2,
              pinned: true,
            });
            const service = yield* AnswerService;
            const saved = (yield* service.workspace(threadId)).answers[0]!;
            assert.deepEqual(saved.companies[0]!.profile, financialData.company);
            assert.equal(saved.lastPresentedRunId, runId);
            const qualitative = yield* tools
              .handle("matrix_present_answer", { spec: qualitativeSpec })
              .pipe(Stream.unwrap, Stream.runCollect);
            assert.property(qualitative.at(-1)!.result, "answerId");
            const answers = (yield* service.workspace(threadId)).answers;
            assert.deepEqual(
              answers.find((answer) => answer.spec.symbols.length === 0)?.companies,
              [],
            );
            for (const invalidSpec of [
              {
                ...overviewSpec,
                sections: [{ id: "bad", label: "Bad", columns: 1 as const, blockIds: ["missing"] }],
              },
              {
                ...qualitativeSpec,
                blocks: [
                  {
                    id: "bad",
                    kind: "diagram" as const,
                    title: "Bad graph",
                    nodes: [{ id: "one", label: "One", detail: "Context" }],
                    edges: [{ from: "one", to: "missing" }],
                  },
                ],
                sections: undefined,
              },
            ]) {
              const rejected = yield* tools
                .handle("matrix_present_answer", { spec: invalidSpec })
                .pipe(Stream.unwrap, Stream.runCollect);
              assert.include(rejected.at(-1)!.result, { code: "invalid_request" });
            }
          }
          return { result };
        }).pipe(
          Effect.provide(
            McpToolAccess.HandlersLayer.layer(MatrixHandlers.layer).pipe(
              Layer.provideMerge(threads),
              Layer.provideMerge(Layer.succeed(McpInvocationContext.McpInvocationContext, scope)),
            ),
          ),
        );
      const live = yield* invoke(invocation);
      assert.property(live.result, "answerId");
      const external = yield* invoke({ ...invocation, thread: undefined });
      assert.include(external.result, { code: "thread_credential_required" });
      yield* orchestrator.dispatch({
        type: "run.interrupt",
        commandId: CommandId.make("end-mcp-run"),
        threadId,
        runId,
      });
      const dead = yield* invoke(invocation);
      assert.include(dead.result, { code: "parent_not_active" });
    }).pipe(Effect.provide(testLayer)),
);

const cropSpec: MatrixAnswerSpec = {
  title: "Corn production around the world",
  summary: "Calendar-year FAO crop observations; missing values are not zero.",
  level: "analyst",
  symbols: [],
  queries: [
    {
      id: "crop",
      kind: "crop",
      crop: "corn",
      fromYear: 2023,
      toYear: 2024,
      entities: ["BRA"],
      year: 2024,
      measure: "production",
    },
  ],
  blocks: [
    {
      id: "map",
      kind: "map",
      dataset: "crop",
      measure: "production",
    },
    {
      id: "history",
      kind: "series",
      dataset: "crop",
      measure: "production",
      chartType: "line",
    },
    {
      id: "compare",
      kind: "data-table",
      dataset: "crop",
      measures: ["production", "yield", "harvestedArea", "productionGrowth"],
    },
  ],
};

it.effect(
  "persists linked crop focus, guards references and CAS, and resets only with an explicit new-run policy",
  () =>
    Effect.gen(function* () {
      const service = yield* AnswerService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("thread:crop-focus");
      const runId = yield* startThread(threadId);
      const first = yield* service.present({ threadId, runId, input: { spec: cropSpec } });
      const dataset = first.datasets![0]!;
      assert.equal(
        dataset.observations.find((point) => point.entityId === "BRA" && point.year === 2024)
          ?.values.production,
        114953304,
      );
      assert.equal(
        dataset.observations.find((point) => point.entityId === "BRA" && point.year === 2024)
          ?.values.harvestedArea,
        21186816,
      );
      assert.equal(
        dataset.observations.find((point) => point.entityId === "BRA" && point.year === 2024)
          ?.values.yield,
        5.4257007,
      );
      assert.equal(
        dataset.observations.find((point) => point.entityId === "OWID_WRL" && point.year === 2024)
          ?.values.production,
        1218205600,
      );
      for (const view of [
        { entities: ["MISSING"], year: 2024, measure: "production" },
        { entities: ["BRA", "BRA"], year: 2024, measure: "production" },
        { entities: ["BRA"], year: 2022, measure: "production" },
        { entities: ["BRA"], year: 2024, measure: "droughtIndex" },
      ]) {
        assert.equal(
          (yield* service
            .setView({
              threadId,
              answerId: first.id,
              expectedRevision: first.revision,
              datasetId: "crop",
              view,
            })
            .pipe(Effect.flip)).reason,
          "invalid_request",
        );
      }
      assert.equal(
        (yield* service
          .setView({
            threadId,
            answerId: first.id,
            expectedRevision: first.revision,
            datasetId: "foreign",
            view: { entities: [], year: null, measure: null },
          })
          .pipe(Effect.flip)).reason,
        "invalid_request",
      );
      const savedView = { entities: ["USA"], year: 2023, measure: "yield" };
      const focused = yield* service.setView({
        threadId,
        answerId: first.id,
        expectedRevision: first.revision,
        datasetId: "crop",
        view: savedView,
      });
      assert.deepEqual(focused.views, [{ datasetId: "crop", view: savedView }]);
      assert.deepEqual(focused.researchFocus, { entities: ["USA"] });
      assert.deepEqual(focused.datasets, first.datasets);
      assert.deepEqual(focused.spec, first.spec);
      assert.equal(focused.lastPresentedRunId, runId);
      assert.equal(
        (yield* service
          .setView({
            threadId,
            answerId: first.id,
            expectedRevision: first.revision,
            datasetId: "crop",
            view: savedView,
          })
          .pipe(Effect.flip)).reason,
        "conflict",
      );
      const inspected = yield* Effect.gen(function* () {
        const tools = yield* MatrixToolkit;
        for (const probe of [
          { input: { query: cropSpec.queries![0]! }, entity: "USA", production: 377632700 },
          {
            input: { query: cropSpec.queries![0]!, viewPolicy: "authored" },
            entity: "BRA",
            production: 114953304,
          },
        ] as const) {
          const dataReplies = yield* tools
            .handle("matrix_research_data", probe.input)
            .pipe(Stream.unwrap, Stream.runCollect);
          const data = dataReplies.at(-1)!.result;
          if (!("focus" in data)) return assert.fail("Scoped evidence inspection must succeed");
          assert.deepEqual(data.view.entities, [probe.entity]);
          assert.equal(data.focus[0]!.current!.values.production, probe.production);
        }
        const replies = yield* tools
          .handle("matrix_inspect_answers", {})
          .pipe(Stream.unwrap, Stream.runCollect);
        const result = replies.at(-1)!.result;
        if (!("answers" in result)) return assert.fail("Live research inspection must succeed");
        return result.answers[0]!;
      }).pipe(
        Effect.provide(
          McpToolAccess.HandlersLayer.layer(MatrixHandlers.layer).pipe(
            Layer.provideMerge(
              Layer.mock(ThreadManagement.ThreadManagementService)({
                getThreadShell: orchestrator.getThreadShell,
                getThreadRecords: orchestrator.getThreadRecords,
              }),
            ),
            Layer.provideMerge(
              Layer.succeed(McpInvocationContext.McpInvocationContext, {
                environmentId: EnvironmentId.make("environment:crop"),
                requestNamespace: "provider:crop",
                capabilities: new Set(["orchestration"] as const),
                issuedAt: 0,
                client: undefined,
                thread: {
                  threadId,
                  providerSessionId: "session:crop",
                  providerInstanceId: instanceId,
                },
              }),
            ),
          ),
        ),
      );
      assert.equal(inspected.revision, focused.revision);
      assert.deepEqual(inspected.views, focused.views);
      assert.deepEqual(inspected.researchFocus, focused.researchFocus);
      assert.equal(inspected.datasets[0]!.view.year, 2023);
      assert.deepEqual(inspected.datasets[0]!.view.entities, ["USA"]);
      assert.equal(inspected.datasets[0]!.focus[0]!.current!.values.yield, 11.1306);
      assert.isFalse("observations" in inspected.datasets[0]!);
      const enriched = yield* service.present({
        threadId,
        runId,
        input: {
          answerId: first.id,
          expectedRevision: focused.revision,
          viewPolicy: "authored",
          spec: cropSpec,
        },
      });
      assert.deepEqual(enriched.views, focused.views);
      const pinned = yield* service.setPinned({
        threadId,
        answerId: first.id,
        expectedRevision: enriched.revision,
        pinned: true,
      });
      assert.deepEqual(pinned.views, focused.views);
      const changedData = {
        ...pinned,
        datasets: pinned.datasets!.map((dataset) => ({
          ...dataset,
          observations: dataset.observations.map((point, index) =>
            index === 0 ? { ...point, values: { ...point.values, production: 1 } } : point,
          ),
        })),
      };
      const badView = {
        ...pinned,
        views: [
          {
            datasetId: "crop",
            view: { entities: ["invalid"], year: 2024, measure: "production" },
          },
        ],
      };
      const badFocus = { ...pinned, researchFocus: { entities: ["invalid"] } };
      for (const [index, answer] of [changedData, badView, badFocus].entries()) {
        const rejected = yield* orchestrator
          .dispatch({
            type: "matrix.answer.record",
            commandId: CommandId.make(`crop:tamper:${index}`),
            threadId,
            runId: null,
            expectedRevision: pinned.revision,
            answer: { ...answer, revision: pinned.revision + 1 },
          })
          .pipe(Effect.flip);
        assert.equal(rejected._tag, "MatrixAnswerError");
      }
      yield* orchestrator.dispatch({
        type: "run.interrupt",
        commandId: CommandId.make("crop:interrupt"),
        threadId,
        runId,
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("crop:followup"),
        threadId,
        messageId: MessageId.make("crop:followup"),
        text: "Compare Brazil's yield.",
        attachments: [],
        dispatchMode: { type: "defer_start" },
        createdBy: "user",
        creationSource: "web",
      });
      const next = (yield* orchestrator.getThreadRecords(threadId, ["runs"])).runs.find(
        (run) => run.id !== runId,
      )!;
      yield* orchestrator.dispatch({
        type: "prepared-run.release",
        commandId: CommandId.make("crop:release"),
        threadId,
        runId: next.id,
      });
      const revised = yield* service.present({
        threadId,
        runId: next.id,
        input: {
          answerId: first.id,
          expectedRevision: pinned.revision,
          viewPolicy: "authored",
          spec: cropSpec,
        },
      });
      assert.equal(revised.id, first.id);
      assert.isTrue(revised.pinned);
      assert.deepEqual(revised.views![0]!.view.entities, ["BRA"]);
      assert.equal(revised.views![0]!.view.year, 2024);
      assert.deepEqual(revised.researchFocus, { entities: ["BRA"] });
      assert.equal(revised.lastPresentedRunId, next.id);
      const stored = yield* orchestrator.getTurnItem({ threadId, itemId: first.id });
      assert.equal(stored!.runId, runId);
      assert.deepEqual((yield* service.workspace(threadId)).answers, [revised]);
    }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "preserves acknowledged focus on a normal follow-up and carries its countries into a new data pane",
  () =>
    Effect.gen(function* () {
      const service = yield* AnswerService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("thread:crop-followup-focus");
      const runId = yield* startThread(threadId);
      const first = yield* service.present({ threadId, runId, input: { spec: cropSpec } });
      const savedView = { entities: ["USA"], year: 2023, measure: "yield" };
      const focused = yield* service.setView({
        threadId,
        answerId: first.id,
        expectedRevision: first.revision,
        datasetId: "crop",
        view: savedView,
      });
      yield* orchestrator.dispatch({
        type: "run.interrupt",
        commandId: CommandId.make("focus:interrupt"),
        threadId,
        runId,
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("focus:followup"),
        threadId,
        messageId: MessageId.make("focus:followup"),
        text: "Compare that with another measure.",
        attachments: [],
        dispatchMode: { type: "defer_start" },
        createdBy: "user",
        creationSource: "web",
      });
      const next = (yield* orchestrator.getThreadRecords(threadId, ["runs"])).runs.find(
        (run) => run.id !== runId,
      )!;
      yield* orchestrator.dispatch({
        type: "prepared-run.release",
        commandId: CommandId.make("focus:release"),
        threadId,
        runId: next.id,
      });
      const revised = yield* service.present({
        threadId,
        runId: next.id,
        input: {
          answerId: first.id,
          expectedRevision: focused.revision,
          spec: {
            ...cropSpec,
            queries: [...cropSpec.queries!, { ...cropSpec.queries![0]!, id: "comparison" }],
            blocks: [
              ...cropSpec.blocks,
              { id: "comparison-map", kind: "map", dataset: "comparison", measure: "production" },
            ],
          },
        },
      });
      assert.equal(revised.id, first.id);
      assert.equal(revised.lastPresentedRunId, next.id);
      assert.deepEqual(revised.researchFocus, { entities: ["USA"] });
      assert.deepEqual(revised.views, [
        { datasetId: "crop", view: savedView },
        { datasetId: "comparison", view: { entities: ["USA"], year: 2024, measure: "production" } },
      ]);
      assert.equal((yield* orchestrator.getTurnItem({ threadId, itemId: first.id }))!.runId, runId);
    }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "rejects dangling datasets, measures and out-of-coverage authored focus without recording an answer",
  () =>
    Effect.gen(function* () {
      const service = yield* AnswerService;
      const threadId = ThreadId.make("thread:crop-references");
      const runId = yield* startThread(threadId);
      for (const bad of [
        { ...cropSpec, queries: [] },
        { ...cropSpec, queries: [cropSpec.queries![0]!, cropSpec.queries![0]!] },
        { ...cropSpec, queries: [{ ...cropSpec.queries![0]!, entities: ["UNKNOWN"] }] },
        {
          ...cropSpec,
          blocks: [
            {
              id: "bad",
              kind: "map" as const,
              dataset: "crop",
              measure: "madeUp",
            },
          ],
        },
      ]) {
        assert.equal(
          (yield* service.present({ threadId, runId, input: { spec: bad } }).pipe(Effect.flip))
            .reason,
          "invalid_request",
        );
      }
      assert.deepEqual((yield* service.workspace(threadId)).answers, []);
    }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "persists general indicator research with real measure codes and linked focus, not a crop-specific workspace",
  () =>
    Effect.gen(function* () {
      const service = yield* AnswerService;
      const threadId = ThreadId.make("thread:indicator-research");
      const runId = yield* startThread(threadId);
      const spec: MatrixAnswerSpec = {
        title: "GDP growth and population history",
        summary: "Historical country observations with source definitions and independent units.",
        level: "analyst",
        symbols: [],
        queries: [
          {
            id: "economy",
            kind: "indicators",
            indicators: ["NY.GDP.MKTP.KD.ZG", "SP.POP.TOTL"],
            fromYear: 2023,
            toYear: 2024,
            entities: ["USA"],
            year: 2024,
          },
        ],
        blocks: [
          {
            id: "population",
            kind: "map",
            dataset: "economy",
            measure: "SP.POP.TOTL",
          },
          {
            id: "history",
            kind: "series",
            dataset: "economy",
            measure: "NY.GDP.MKTP.KD.ZG",
            chartType: "line",
          },
          {
            id: "comparison",
            kind: "scatter",
            dataset: "economy",
            xMeasure: "SP.POP.TOTL",
            yMeasure: "NY.GDP.MKTP.KD.ZG",
          },
        ],
      };
      const first = yield* service.present({ threadId, runId, input: { spec } });
      const dataset = first.datasets![0]!;
      assert.equal(first.views![0]!.view.measure, "SP.POP.TOTL");
      assert.deepEqual(
        dataset.measures.map((measure) => measure.id),
        ["NY.GDP.MKTP.KD.ZG", "SP.POP.TOTL"],
      );
      assert.equal(dataset.measures[0]!.unit, "%");
      assert.equal(dataset.measures[1]!.unit, "Unit");
      assert.equal(
        dataset.observations.find((point) => point.entityId === "USA" && point.year === 2024)
          ?.values["NY.GDP.MKTP.KD.ZG"],
        2.79318715363841,
      );
      const focused = yield* service.setView({
        threadId,
        answerId: first.id,
        expectedRevision: first.revision,
        datasetId: "economy",
        view: { entities: ["USA"], year: 2023, measure: "NY.GDP.MKTP.KD.ZG" },
      });
      assert.equal(focused.views![0]!.view.measure, "NY.GDP.MKTP.KD.ZG");
      assert.equal(focused.views![0]!.view.year, 2023);
      assert.deepEqual(focused.datasets, first.datasets);
      assert.deepEqual(focused.spec, first.spec);
      assert.equal(focused.lastPresentedRunId, runId);
      const enriched = yield* service.present({
        threadId,
        runId,
        input: { answerId: first.id, expectedRevision: focused.revision, spec },
      });
      assert.deepEqual(enriched.views, focused.views);
      assert.deepEqual((yield* service.workspace(threadId)).answers, [enriched]);
    }).pipe(Effect.provide(testLayer)),
);
