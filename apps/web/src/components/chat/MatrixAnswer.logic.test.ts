import { describe, expect, it } from "vite-plus/test";
import {
  MessageId,
  RunAttemptId,
  RunId,
  NodeId,
  ThreadId,
  TurnItemId,
  type MatrixAnswer,
  type MatrixAnswerCompany,
  type MatrixAnswerMetric,
  type OrchestrationV2TurnItem,
  type OrchestrationV2ProjectedTurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { deriveTimelineEntriesFromVisibleTurnItems, type TimelineEntry } from "../../session-logic";
import { deriveMessagesTimelineRows } from "./MessagesTimeline.logic";
import {
  chartSeriesPoints,
  exactValue,
  financialRows,
  metricSeries,
  matrixSummaryPreview,
  periodKey,
  safeSecUrl,
  sortFinancialRows,
} from "./MatrixAnswer.logic";

const annual = {
  start: "2024-01-01",
  end: "2024-12-31",
  value: 12,
  sources: [
    {
      url: "https://www.sec.gov/Archives/example",
      accession: "filing-1",
      tag: "Revenues",
      filed: "2025-02-01",
    },
  ],
};
const revenue: MatrixAnswerMetric = {
  id: "revenue",
  label: "Revenue",
  description: "Reported revenue",
  unit: "USD",
  observations: [annual],
};
const companies: MatrixAnswerCompany[] = [
  {
    symbol: "AAA",
    cik: "1",
    name: "Company A",
    metrics: [revenue],
    filings: [],
    sources: [],
    warnings: [],
  },
  {
    symbol: "BBB",
    cik: "2",
    name: "Company B",
    metrics: [{ ...revenue, observations: [{ ...annual, value: -5 }] }],
    filings: [],
    sources: [],
    warnings: [],
  },
  {
    symbol: "CCC",
    cik: "3",
    name: "Company C",
    metrics: [{ ...revenue, observations: [] }],
    filings: [],
    sources: [],
    warnings: [],
  },
];

describe("Matrix financial data controls", () => {
  it("sorts numeric values rather than formatted text and always leaves missing cells last", () => {
    const rows = financialRows(companies, ["revenue"]);
    expect(sortFinancialRows(rows, "revenue", "asc").map((row) => row.company.symbol)).toEqual([
      "BBB",
      "AAA",
      "CCC",
    ]);
    expect(sortFinancialRows(rows, "revenue", "desc").map((row) => row.company.symbol)).toEqual([
      "AAA",
      "BBB",
      "CCC",
    ]);
    expect(rows[2]?.cells.size).toBe(0);
  });

  it("compares latest reported values without dropping companies whose fiscal dates differ", () => {
    const otherPeriod = { ...annual, start: "2024-07-01", end: "2025-06-30", value: 40 };
    const second = { ...companies[1]!, metrics: [{ ...revenue, observations: [otherPeriod] }] };
    const rows = financialRows([companies[0]!, second, companies[2]!], ["revenue"], "latest");
    expect(rows).toHaveLength(3);
    expect(rows[0]?.cells.get("revenue")?.observation).toBe(annual);
    expect(rows[1]?.cells.get("revenue")?.observation).toBe(otherPeriod);
    expect(rows[2]?.cells.has("revenue")).toBe(false);
    expect(sortFinancialRows(rows, "revenue", "desc").map((row) => row.company.symbol)).toEqual([
      "BBB",
      "AAA",
      "CCC",
    ]);
  });

  it("connects each company's own observations despite interleaved fiscal periods", () => {
    const previous = { ...annual, start: "2023-01-01", end: "2023-12-31", value: 3 };
    const interleaved = { ...annual, start: "2023-07-01", end: "2024-06-30", value: 90 };
    const keys = [previous, interleaved, annual].map(periodKey);
    const points = chartSeriesPoints([previous, annual], keys);
    expect(points.map((point) => point.index)).toEqual([0, 2]);
    expect(points[1]?.previousIndex).toBe(0);
    expect(points[1]?.previous).toBe(previous);
    expect(points[0]?.previous).toBeUndefined();
    expect(points.map((point) => point.observation.value)).toEqual([3, 12]);
  });

  it("does not combine different start dates, instant contexts, or units", () => {
    const margin: MatrixAnswerMetric = {
      id: "netMargin",
      label: "Net margin",
      description: "Matched net income / revenue",
      unit: "percent",
      observations: [
        {
          ...annual,
          value: 7.125,
          sources: [annual.sources[0]!, { ...annual.sources[0]!, tag: "NetIncomeLoss" }],
        },
      ],
    };
    const company = {
      ...companies[0]!,
      metrics: [
        { ...revenue, observations: [annual, { ...annual, start: "2024-10-01", value: 4 }] },
        margin,
        {
          ...revenue,
          id: "assets" as const,
          observations: [{ ...annual, start: null, value: 500 }],
        },
      ],
    };
    const rows = financialRows([company], ["revenue", "netMargin", "assets"]);
    expect(rows).toHaveLength(3);
    const fullYear = rows.find((row) => row.period?.start === annual.start)!;
    expect(fullYear.cells.get("revenue")?.metric.unit).toBe("USD");
    expect(fullYear.cells.get("netMargin")?.metric.unit).toBe("percent");
    expect(fullYear.cells.has("assets")).toBe(false);
    expect(fullYear.cells.get("netMargin")?.observation.sources).toHaveLength(2);
    expect(periodKey(annual)).not.toBe(periodKey({ ...annual, start: "2024-10-01" }));
    expect(exactValue(7.125, "percent")).toBe("7.125 %");
  });

  it("filters companies and end-date range without inventing observations", () => {
    const company = {
      ...companies[0]!,
      metrics: [
        {
          ...revenue,
          observations: [{ ...annual, start: "2023-01-01", end: "2023-12-31", value: 0 }, annual],
        },
      ],
    };
    const filtered = metricSeries(
      [company, companies[1]!],
      "revenue",
      new Set(["AAA"]),
      "2024-01-01",
      "2024-12-31",
    );
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.observations).toEqual([annual]);
    expect(
      metricSeries([company], "revenue", new Set(["AAA"]), "2025-01-01")[0]?.observations,
    ).toEqual([]);
    expect(metricSeries([company], "revenue", new Set())).toEqual([]);
    expect(company.metrics[0]?.observations[0]?.value).toBe(0);
  });

  it("only opens HTTPS SEC provenance links without credentials", () => {
    expect(safeSecUrl("https://www.sec.gov/Archives/report.htm")).toBe(
      "https://www.sec.gov/Archives/report.htm",
    );
    for (const unsafe of [
      "javascript:alert(1)",
      "https://sec.gov.attacker.test/report",
      "http://sec.gov/report",
      "https://user:password@sec.gov/report",
    ])
      expect(safeSecUrl(unsafe)).toBeNull();
  });
});

describe("compact Matrix interpretation", () => {
  it("keeps a short authored summary intact and bounds a long first glance", () => {
    const short = "Apple sells devices and services.";
    expect(matrixSummaryPreview(short)).toBe(short);
    const long = "A business interpretation with useful context. ".repeat(40);
    const preview = matrixSummaryPreview(long);
    expect(preview.length).toBeLessThanOrEqual(220);
    expect(preview.endsWith("…")).toBe(true);
    expect(long.startsWith(preview.slice(0, -1))).toBe(true);
    expect(matrixSummaryPreview("x".repeat(400)).length).toBeLessThanOrEqual(220);
  });
});

describe("Matrix first-class answer timeline", () => {
  const threadId = ThreadId.make("research-thread");
  const runId = RunId.make("research-run");
  const answer: MatrixAnswer = {
    id: TurnItemId.make("financial-answer"),
    threadId,
    revision: 1,
    pinned: false,
    createdAt: "2026-10-20T12:00:00Z",
    updatedAt: "2026-10-20T12:00:00Z",
    spec: {
      title: "Company comparison",
      summary: "Interpretation",
      level: "guided",
      symbols: ["AAA"],
      blocks: [{ id: "revenue", kind: "chart", metric: "revenue", chartType: "line" }],
    },
    companies: [companies[0]!],
  };
  const now = DateTime.makeUnsafe(answer.createdAt);
  const item: Extract<OrchestrationV2TurnItem, { type: "matrix_answer" }> = {
    id: answer.id,
    threadId,
    runId,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "completed",
    title: null,
    startedAt: now,
    completedAt: now,
    updatedAt: now,
    type: "matrix_answer",
    answer,
  };
  const projected: OrchestrationV2ProjectedTurnItem = {
    item,
    position: 1,
    visibility: "local",
    sourceThreadId: threadId,
    sourceItemId: item.id,
  };

  it("promotes answer items instead of treating them as work logs", () => {
    const entries = deriveTimelineEntriesFromVisibleTurnItems({
      visibleTurnItems: [projected],
      optimisticMessages: [],
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.kind).toBe("matrix-answer");
    if (entries[0]?.kind === "matrix-answer") expect(entries[0].answer).toBe(answer);
  });

  it("keeps answers visible while settled work and superseded attempts fold", () => {
    const attempt = {
      id: RunAttemptId.make("old-attempt"),
      runId,
      attemptOrdinal: 0,
      rootNodeId: NodeId.make("old-root"),
      status: "superseded" as const,
      completedAt: now,
    };
    const entries: TimelineEntry[] = [
      {
        id: "prompt",
        kind: "message",
        createdAt: answer.createdAt,
        message: {
          id: MessageId.make("prompt"),
          role: "user",
          streaming: false,
          text: "Compare companies",
          createdAt: answer.createdAt,
          updatedAt: answer.createdAt,
          runId,
        },
      },
      {
        id: "work",
        kind: "work",
        createdAt: answer.createdAt,
        attempt,
        entry: {
          id: "work",
          createdAt: answer.createdAt,
          runId,
          label: "Read filings",
          tone: "tool",
          toolLifecycleStatus: "completed",
        },
      },
      { id: item.id, kind: "matrix-answer", createdAt: answer.createdAt, runId, answer, attempt },
      {
        id: "reply",
        kind: "message",
        createdAt: answer.createdAt,
        message: {
          id: MessageId.make("reply"),
          role: "assistant",
          streaming: false,
          text: "Comparison ready",
          createdAt: answer.createdAt,
          updatedAt: answer.createdAt,
          runId,
        },
      },
    ];
    const rows = deriveMessagesTimelineRows({
      timelineEntries: entries,
      isWorking: false,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });
    expect(rows.filter((row) => row.kind === "matrix-answer").map((row) => row.id)).toEqual([
      answer.id,
    ]);
    expect(rows.some((row) => row.kind === "work")).toBe(false);
  });

  it("replaces a streamed revision at the same stable answer row identity", () => {
    const updated = {
      ...answer,
      revision: 2,
      spec: { ...answer.spec, title: "Updated comparison" },
    };
    const before = deriveTimelineEntriesFromVisibleTurnItems({
      visibleTurnItems: [projected],
      optimisticMessages: [],
    });
    const after = deriveTimelineEntriesFromVisibleTurnItems({
      visibleTurnItems: [{ ...projected, item: { ...item, answer: updated } }],
      optimisticMessages: [],
    });
    expect(after[0]?.id).toBe(before[0]?.id);
    expect(after[0]?.kind).toBe("matrix-answer");
    if (after[0]?.kind === "matrix-answer") expect(after[0].answer.revision).toBe(2);
  });
});
