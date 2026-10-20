import { describe, expect, it } from "vite-plus/test";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { MatrixAnswerObservation, MatrixAnswerSource, MatrixAnswerSpec } from "./matrixAnswer.ts";

const decodeSpec = Schema.decodeUnknownExit(MatrixAnswerSpec);
const decodeObservation = Schema.decodeUnknownExit(MatrixAnswerObservation);
const decodeSource = Schema.decodeUnknownExit(MatrixAnswerSource);
const source = {
  url: "https://www.sec.gov/Archives/edgar/data/320193/filing-index.html",
  accession: "0000320193-25-000079",
  tag: "us-gaap:NetIncomeLoss",
  filed: "2025-10-31",
};
const spec = {
  title: "Apple profitability",
  summary: "Reported evidence",
  level: "guided",
  symbols: ["AAPL"],
  blocks: [{ id: "income", kind: "chart", metric: "netIncome", chartType: "line" }],
};

describe("Matrix presentation boundaries", () => {
  it("rejects executable layouts and invented financial measures", () => {
    expect(
      Exit.isFailure(
        decodeSpec({
          ...spec,
          blocks: [{ id: "code", kind: "html", html: "<script>alert(1)</script>" }],
        }),
      ),
    ).toBe(true);
    expect(
      Exit.isFailure(
        decodeSpec({
          ...spec,
          blocks: [{ id: "price", kind: "metric", metric: "liveStockPrice" }],
        }),
      ),
    ).toBe(true);
    expect(Exit.isFailure(decodeSpec({ ...spec, symbols: ["A", "B", "C", "D", "E"] }))).toBe(true);
    expect(Exit.isSuccess(decodeSpec(spec))).toBe(true);
  });

  it("bounds authored navigation and interactions without admitting executable components", () => {
    const diagram = {
      id: "business",
      kind: "diagram",
      title: "Business model",
      nodes: [{ id: "sales", label: "Sales", detail: "A qualitative explanation" }],
      edges: [],
    };
    const authored = {
      ...spec,
      blocks: [
        diagram,
        {
          id: "followups",
          kind: "actions",
          title: "Explore",
          prompts: ["Compare Apple with Microsoft"],
        },
      ],
      sections: [
        { id: "business", label: "How it works", columns: 1, blockIds: ["business", "followups"] },
      ],
    };
    expect(Exit.isSuccess(decodeSpec(authored))).toBe(true);
    expect(
      Exit.isFailure(
        decodeSpec({ ...authored, sections: [{ ...authored.sections[0], columns: 4 }] }),
      ),
    ).toBe(true);
    expect(
      Exit.isFailure(
        decodeSpec({
          ...authored,
          blocks: [
            {
              ...diagram,
              nodes: Array.from({ length: 9 }, (_, i) => ({
                id: `n${i}`,
                label: "Node",
                detail: "",
              })),
            },
          ],
        }),
      ),
    ).toBe(true);
    expect(
      Exit.isFailure(
        decodeSpec({
          ...authored,
          blocks: [{ id: "actions", kind: "actions", title: "Explore", prompts: [] }],
        }),
      ),
    ).toBe(true);
    expect(
      Exit.isFailure(
        decodeSpec({
          ...authored,
          blocks: [{ id: "code", kind: "component", code: "document.cookie" }],
        }),
      ),
    ).toBe(true);
  });

  it("accepts bounded reported-period windows and rejects invalid or unbounded requests", () => {
    for (const block of [
      { id: "trend", kind: "chart", metric: "revenue", chartType: "line" },
      { id: "history", kind: "table", metrics: ["revenue"] },
    ]) {
      expect(Exit.isSuccess(decodeSpec({ ...spec, blocks: [{ ...block, periods: 5 }] }))).toBe(
        true,
      );
      for (const periods of [0, -1, 1.5, 21, Infinity])
        expect(Exit.isFailure(decodeSpec({ ...spec, blocks: [{ ...block, periods }] }))).toBe(true);
    }
  });

  it("keeps non-finite calculations out of renderable observations", () => {
    const observation = { start: "2024-09-29", end: "2025-09-27", value: 0, sources: [source] };
    expect(Exit.isSuccess(decodeObservation(observation))).toBe(true);
    for (const value of [NaN, Infinity, -Infinity]) {
      expect(Exit.isFailure(decodeObservation({ ...observation, value }))).toBe(true);
    }
    expect(Exit.isFailure(decodeObservation({ ...observation, sources: [] }))).toBe(true);
  });

  it("only accepts HTTPS SEC provenance, not executable or lookalike URLs", () => {
    for (const url of [
      "javascript:alert(1)",
      "https://www.sec.gov.evil.test/a",
      "http://www.sec.gov/a",
      "https://attacker@www.sec.gov/a",
    ]) {
      expect(Exit.isFailure(decodeSource({ ...source, url }))).toBe(true);
    }
    expect(Exit.isSuccess(decodeSource(source))).toBe(true);
    expect(
      Exit.isSuccess(
        decodeSource({
          ...source,
          url: "https://data.sec.gov/api/xbrl/companyfacts/CIK0000320193.json",
        }),
      ),
    ).toBe(true);
  });
});
