import type { MatrixAnswerCompany, MatrixAnswerMetric, MatrixAnswerSpec } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  matrixCardColumns,
  matrixVisibleSection,
  matrixComparisonPeriods,
  matrixComparisonRows,
  matrixExactValue,
  matrixOrderedObservations,
  matrixPeriodKey,
  matrixPeriodLabel,
  matrixSafeSourceUrl,
  type MatrixObservation,
} from "./matrix-answer-presentation";

const source = {
  url: "https://www.sec.gov/Archives/edgar/data/1/report.htm",
  accession: "0001-25-01",
  tag: "Revenues",
  filed: "2025-02-01",
};
const annual: MatrixObservation = {
  start: "2024-01-01",
  end: "2024-12-31",
  value: 100,
  sources: [source],
};
const quarter: MatrixObservation = { ...annual, start: "2024-10-01", value: 30 };

function company(symbol: string, observations: readonly MatrixObservation[]): MatrixAnswerCompany {
  return {
    symbol,
    cik: "1",
    name: symbol,
    metrics: [
      {
        id: "revenue",
        label: "Revenue",
        description: "Reported revenue",
        unit: "USD",
        observations,
      },
    ],
    filings: [],
    sources: [],
    warnings: [],
  };
}

describe("native financial answer presentation", () => {
  it("keeps annual, quarter, and instant periods distinct even with the same end date", () => {
    const instant: MatrixObservation = { ...annual, start: null };
    const companies = [company("AAA", [annual]), company("BBB", [quarter, instant])];
    const periods = matrixComparisonPeriods(companies, ["revenue"]);
    expect(periods).toHaveLength(3);
    expect(new Set(periods.map(matrixPeriodKey)).size).toBe(3);
    expect(matrixPeriodLabel(instant)).toBe("As of 2024-12-31");
    expect(matrixPeriodLabel(annual)).toBe("2024-01-01 – 2024-12-31");
    const rows = matrixComparisonRows(companies, ["revenue"], matrixPeriodKey(annual), null);
    expect(rows[0]?.cells[0]?.observation).toBe(annual);
    expect(rows[1]?.cells[0]?.observation).toBeUndefined();
  });

  it("shows each company's latest reported value by default without forcing unrelated fiscal calendars to match", () => {
    const apple: MatrixObservation = {
      ...annual,
      start: "2023-10-01",
      end: "2024-09-28",
      value: 391035000000,
    };
    const microsoft: MatrixObservation = {
      ...annual,
      start: "2023-07-01",
      end: "2024-06-30",
      value: 245122000000,
    };
    const priorApple: MatrixObservation = {
      ...apple,
      start: "2022-10-01",
      end: "2023-09-30",
      value: 383285000000,
    };
    const companies = [
      company("AAPL", [apple, priorApple]),
      company("MSFT", [microsoft]),
      company("MISSING", []),
    ];
    const latest = matrixComparisonRows(companies, ["revenue"], null, null);
    expect(latest[0]?.cells[0]?.observation).toBe(apple);
    expect(latest[1]?.cells[0]?.observation).toBe(microsoft);
    expect(latest[2]?.cells[0]?.observation).toBeUndefined();
    expect(matrixPeriodLabel(latest[0]!.cells[0]!.observation!)).toBe("2023-10-01 – 2024-09-28");
    expect(matrixPeriodLabel(latest[1]!.cells[0]!.observation!)).toBe("2023-07-01 – 2024-06-30");
    expect(latest[0]?.cells[0]?.metric?.unit).toBe("USD");
    expect(latest[1]?.cells[0]?.observation?.sources).toBe(microsoft.sources);
    const exact = matrixComparisonRows(companies, ["revenue"], matrixPeriodKey(apple), null);
    expect(exact[0]?.cells[0]?.observation).toBe(apple);
    expect(exact[1]?.cells[0]?.observation).toBeUndefined();
  });

  it("renders year-by-year rows on each company's own calendar and sorts them without filling missing periods", () => {
    const prior = { ...annual, start: "2022-01-01", end: "2022-12-31", value: -10 };
    const offset = { ...annual, start: "2023-07-01", end: "2024-06-30", value: 20 };
    const rows = matrixComparisonRows(
      [company("AAA", [annual, prior]), company("BBB", [offset]), company("MISSING", [])],
      ["revenue"],
      "all",
      { metric: "revenue", descending: true },
    );
    expect(rows.map((row) => [row.company.symbol, row.cells[0]?.observation?.value])).toEqual([
      ["AAA", 100],
      ["BBB", 20],
      ["AAA", -10],
      ["MISSING", undefined],
    ]);
    expect(new Set(rows.map((row) => `${row.company.symbol}:${row.periodKey}`)).size).toBe(4);
    expect(rows[1]?.cells[0]?.observation).toBe(offset);
  });

  it("sorts only values from the selected exact period and leaves missing rows last without substituting zero", () => {
    const companies = [
      company("MISSING", [quarter]),
      company("LOSS", [{ ...annual, value: -50 }]),
      company("ZERO", [{ ...annual, value: 0 }]),
    ];
    const descending = matrixComparisonRows(companies, ["revenue"], matrixPeriodKey(annual), {
      metric: "revenue",
      descending: true,
    });
    expect(descending.map((row) => row.company.symbol)).toEqual(["ZERO", "LOSS", "MISSING"]);
    const ascending = matrixComparisonRows(companies, ["revenue"], matrixPeriodKey(annual), {
      metric: "revenue",
      descending: false,
    });
    expect(ascending.map((row) => row.company.symbol)).toEqual(["LOSS", "ZERO", "MISSING"]);
    expect(ascending[2]?.cells[0]?.observation).toBeUndefined();
    expect(companies.map((entry) => entry.symbol)).toEqual(["MISSING", "LOSS", "ZERO"]);
  });

  it("preserves finite server values, ratio precision, signed values, and observation provenance", () => {
    expect(matrixExactValue(123456789012, "USD")).toBe("123456789012 USD");
    expect(matrixExactValue(-3.3333333333333335, "percent")).toBe("-3.3333333333333335 %");
    const ratio: MatrixAnswerMetric = {
      id: "netMargin",
      label: "Net margin",
      description: "Net income / revenue",
      unit: "percent",
      observations: [
        { ...annual, sources: [source, { ...source, tag: "NetIncomeLoss" }] },
        { ...annual, start: "2023-01-01", end: "2023-12-31" },
      ],
    };
    const ordered = matrixOrderedObservations(ratio);
    expect(ordered[0]?.end).toBe("2023-12-31");
    expect(ordered[1]?.sources).toBe(ratio.observations[0]?.sources);
    expect(ordered[1]?.sources.map((entry) => entry.tag)).toEqual(["Revenues", "NetIncomeLoss"]);
    expect(ratio.observations[0]?.end).toBe("2024-12-31");
  });

  it("returns explicit empty comparison cells and periods when data is missing", () => {
    const companies = [company("AAA", [])];
    expect(matrixComparisonPeriods(companies, ["assets"])).toEqual([]);
    expect(matrixComparisonRows(companies, ["assets"], null, null)[0]?.cells[0]).toEqual({
      id: "assets",
      metric: undefined,
      observation: undefined,
    });
  });

  it.each([
    ["https://www.sec.gov/Archives/report.htm", true],
    ["https://data.sec.gov/api/xbrl/companyfacts/CIK1.json", true],
    ["https://sec.gov/Archives/report.htm", true],
    ["https://www.sec.gov.evil.test/report", false],
    ["https://evil.test/?url=https://www.sec.gov/report", false],
    ["https://user:secret@www.sec.gov/report", false],
    ["javascript:alert(1)", false],
    ["http://www.sec.gov/report", false],
    ["invalid", false],
  ])("validates SEC source URL %s", (url, expected) => {
    expect(matrixSafeSourceUrl(url)).toBe(expected);
  });
});

describe("native adaptive answer navigation", () => {
  const spec: MatrixAnswerSpec = {
    title: "How the business works",
    summary: "A company overview",
    level: "guided",
    symbols: ["AAPL"],
    blocks: [
      { id: "identity", kind: "company" },
      {
        id: "model",
        kind: "diagram",
        title: "Business model",
        nodes: [{ id: "products", label: "Products", detail: "Interpretation" }],
        edges: [],
      },
      { id: "revenue", kind: "metric", metric: "revenue" },
      { id: "next", kind: "actions", title: "Explore", prompts: ["What are the risks?"] },
    ],
    sections: [
      { id: "business", label: "Business", columns: 2, blockIds: ["identity", "model"] },
      { id: "numbers", label: "Numbers", columns: 3, blockIds: ["revenue", "next"] },
    ],
  };

  it("preserves question-authored grouping and selection rather than sorting by block kind", () => {
    const result = matrixVisibleSection(spec, "numbers");
    expect(result.sections.map((section) => section.label)).toEqual(["Business", "Numbers"]);
    expect(result.selected?.blockIds).toEqual(["revenue", "next"]);
    expect(result.sections.flatMap((section) => section.blockIds)).toEqual(
      spec.blocks.map((block) => block.id),
    );
  });

  it("keeps all details reachable when a live revision removes the selected section", () => {
    const updated: MatrixAnswerSpec = {
      ...spec,
      sections: [
        {
          id: "overview",
          label: "Overview",
          columns: 1,
          blockIds: spec.blocks.map((block) => block.id),
        },
      ],
    };
    const result = matrixVisibleSection(updated, "numbers");
    expect(result.selected?.id).toBe("overview");
    expect(result.selected?.blockIds).toHaveLength(4);
    expect(matrixVisibleSection(spec, null).selected?.id).toBe("business");
  });

  it("makes every legacy flat block navigable without rewriting stored reports", () => {
    const { sections: _, ...legacy } = spec;
    const result = matrixVisibleSection(legacy, "obsolete");
    expect(result.selected).toBeDefined();
    expect(result.sections.flatMap((section) => section.blockIds).sort()).toEqual(
      legacy.blocks.map((block) => block.id).sort(),
    );
    expect(legacy).not.toHaveProperty("sections");
  });

  it("uses readable native cards at narrow widths and honors authored column limits", () => {
    expect(matrixCardColumns(240, 3)).toBe(1);
    expect(matrixCardColumns(540, 3)).toBe(2);
    expect(matrixCardColumns(840, 3)).toBe(3);
    expect(matrixCardColumns(840, 1)).toBe(1);
    expect(matrixCardColumns(840, 2)).toBe(2);
  });
});
