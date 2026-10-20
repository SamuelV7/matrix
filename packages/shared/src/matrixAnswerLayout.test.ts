import { describe, expect, it } from "vite-plus/test";
import type {
  MatrixAnswerBlock,
  MatrixAnswerCompany,
  MatrixAnswerMetric,
  MatrixAnswerSpec,
} from "@t3tools/contracts";
import {
  matrixAnswerSections,
  matrixAnswerPeriodWindow,
  matrixDiagramLayout,
} from "./matrixAnswerLayout.ts";

type Diagram = Extract<MatrixAnswerBlock, { kind: "diagram" }>;
const diagram: Diagram = {
  id: "business",
  kind: "diagram",
  title: "How the business works",
  nodes: [
    { id: "products", label: "Products", detail: "Devices sold to customers" },
    { id: "services", label: "Services", detail: "Recurring services" },
    { id: "sales", label: "Revenue", detail: "Reported sales, not a segment estimate" },
    { id: "costs", label: "Operating costs", detail: "Costs of running the business" },
    { id: "profit", label: "Profit", detail: "What remains after costs" },
  ],
  edges: [
    { from: "products", to: "sales" },
    { from: "services", to: "sales" },
    { from: "sales", to: "costs" },
    { from: "costs", to: "profit" },
    { from: "sales", to: "profit", label: "After all expenses" },
  ],
};

describe("adaptive answer layout", () => {
  it("keeps every block in old saved answers reachable exactly once", () => {
    const spec: MatrixAnswerSpec = {
      title: "Saved report",
      summary: "Interpretation",
      level: "guided",
      symbols: ["AAPL"],
      blocks: [
        { id: "note", kind: "explanation", title: "Meaning", text: "Historical only" },
        { id: "sales", kind: "metric", metric: "revenue" },
        { id: "trend", kind: "chart", metric: "revenue", chartType: "line" },
        { id: "cash", kind: "metric", metric: "operatingCashFlow" },
        { id: "table", kind: "table", metrics: ["revenue", "operatingCashFlow"] },
        { id: "filings", kind: "filings", title: "Disclosures" },
      ],
    };
    const sections = matrixAnswerSections(spec);
    const ids = sections.flatMap((section) => section.blockIds);
    expect(ids.toSorted()).toEqual(spec.blocks.map((block) => block.id).toSorted());
    expect(new Set(ids).size).toBe(ids.length);
    const metrics = sections.find((section) => section.blockIds.includes("sales"))!;
    expect(metrics.blockIds).toContain("cash");
    expect(metrics.blockIds).not.toContain("filings");
    expect(spec.sections).toBeUndefined();
  });

  it("keeps all geographic research blocks reachable when an agent omits authored sections", () => {
    const spec: MatrixAnswerSpec = {
      title: "Economic comparison",
      summary: "Sourced annual histories",
      level: "guided",
      symbols: [],
      queries: [
        { id: "economy", kind: "indicators", indicators: ["NY.GDP.MKTP.KD.ZG", "FP.CPI.TOTL.ZG"] },
      ],
      blocks: [
        { id: "next", kind: "actions", title: "Explore", prompts: ["Compare inflation too"] },
        {
          id: "map",
          kind: "map",
          dataset: "economy",
          measure: "NY.GDP.MKTP.KD.ZG",
        },
        {
          id: "history",
          kind: "series",
          dataset: "economy",
          measure: "NY.GDP.MKTP.KD.ZG",
          chartType: "line",
        },
        {
          id: "table",
          kind: "data-table",
          dataset: "economy",
          measures: ["NY.GDP.MKTP.KD.ZG"],
        },
        {
          id: "metrics",
          kind: "data-metrics",
          dataset: "economy",
          measures: ["NY.GDP.MKTP.KD.ZG"],
        },
        {
          id: "relationship",
          kind: "scatter",
          dataset: "economy",
          xMeasure: "NY.GDP.MKTP.KD.ZG",
          yMeasure: "FP.CPI.TOTL.ZG",
        },
      ],
    };
    const sections = matrixAnswerSections(spec);
    const ids = sections.flatMap((section) => section.blockIds);
    expect([...ids].sort()).toEqual(spec.blocks.map((block) => block.id).sort());
    expect(new Set(ids).size).toBe(spec.blocks.length);
    expect(sections[0]!.blockIds).toContain("map");
  });

  it("limits each company's own exact periods without filling gaps or hiding missing metric cells", () => {
    const observation = (year: number, month: string) => ({
      start: `${year}-01-01`,
      end: `${year}-${month}-28`,
      value: year,
      sources: [
        {
          url: "https://www.sec.gov/Archives/report.htm",
          accession: "filing",
          tag: "Revenues",
          filed: "2026-08-01",
        },
      ],
    });
    const metric = (
      id: "revenue" | "netIncome",
      years: number[],
      month: string,
    ): MatrixAnswerMetric => ({
      id,
      label: id,
      description: id,
      unit: "USD",
      observations: years.map((year) => observation(year, month)),
    });
    const company = (symbol: string, metrics: MatrixAnswerMetric[]): MatrixAnswerCompany => ({
      symbol,
      cik: "1",
      name: symbol,
      metrics,
      filings: [],
      sources: [],
      warnings: [],
    });
    const input = [
      company("AAA", [
        metric("revenue", [2026, 2021, 2025], "09"),
        metric("netIncome", [2021], "09"),
      ]),
      company("BBB", [metric("revenue", [2024, 2026, 2023], "06")]),
      company("MISSING", [metric("revenue", [], "12")]),
    ];
    const window = matrixAnswerPeriodWindow(input, ["revenue", "netIncome"], 2);
    expect(window[0]!.metrics[0]!.observations.map((value) => value.end).toSorted()).toEqual([
      "2025-09-28",
      "2026-09-28",
    ]);
    expect(window[0]!.metrics[1]!.observations).toEqual([]);
    expect(window[1]!.metrics[0]!.observations.map((value) => value.end).toSorted()).toEqual([
      "2024-06-28",
      "2026-06-28",
    ]);
    expect(window[2]!.metrics[0]!.observations).toEqual([]);
    expect(window[0]!.metrics[0]!.observations[0]).toBe(input[0]!.metrics[0]!.observations[0]);
    expect(matrixAnswerPeriodWindow(input, ["revenue"], undefined)).toBe(input);
    expect(input[0]!.metrics[0]!.observations.map((value) => value.end)).toEqual([
      "2026-09-28",
      "2021-09-28",
      "2025-09-28",
    ]);
  });

  it("lays out real dependencies in order with separate peer nodes and connected endpoints", () => {
    const layout = matrixDiagramLayout(diagram)!;
    const positions = new Map(layout.nodes.map((node) => [node.id, node]));
    const products = positions.get("products")!;
    const services = positions.get("services")!;
    expect(products.y).toBe(services.y);
    expect(products.x + products.width).toBeLessThan(services.x);
    for (const [index, edge] of diagram.edges.entries()) {
      const from = positions.get(edge.from)!;
      const to = positions.get(edge.to)!;
      expect(to.y).toBeGreaterThan(from.y + from.height);
      expect(layout.edges[index]!.from).toEqual({
        x: from.x + from.width / 2,
        y: from.y + from.height,
      });
      expect(layout.edges[index]!.to).toEqual({ x: to.x + to.width / 2, y: to.y });
    }
    for (const node of layout.nodes) {
      expect(node.x).toBeGreaterThanOrEqual(0);
      expect(node.x + node.width).toBeLessThanOrEqual(layout.width);
      expect(node.y + node.height).toBeLessThanOrEqual(layout.height);
    }
  });

  it("rejects cycles, dangling references and duplicate relationships rather than drawing a false flow", () => {
    for (const edges of [
      [...diagram.edges, { from: "profit", to: "sales" }],
      [...diagram.edges, { from: "unknown", to: "sales" }],
      [...diagram.edges, { from: "sales", to: "sales" }],
      [...diagram.edges, diagram.edges[0]!],
    ])
      expect(matrixDiagramLayout({ ...diagram, edges })).toBeNull();
    expect(
      matrixDiagramLayout({ ...diagram, nodes: [...diagram.nodes, diagram.nodes[0]!] }),
    ).toBeNull();
  });
});
