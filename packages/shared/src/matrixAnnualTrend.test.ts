import { describe, expect, it } from "vite-plus/test";
import { selectAnnualTrend } from "./matrixAnnualTrend.ts";

const original = {
  start: "2022-01-01",
  end: "2022-12-31",
  value: 100,
  filed: "2023-02-01",
  form: "10-K",
  accession: "0000000001-23-000001",
  tag: "us-gaap:Revenues",
  url: "https://www.sec.gov/Archives/edgar/data/1/000000000123000001/",
};

describe("selectAnnualTrend", () => {
  it("uses a later restatement without summing or mutating evidence", () => {
    const restated = {
      ...original,
      value: 90,
      filed: "2024-02-01",
      accession: "0000000001-24-000001",
    };
    const next = { ...restated, start: "2023-01-01", end: "2023-12-31", value: 110 };
    const evidence = [next, restated, original];
    expect(selectAnnualTrend(evidence)).toEqual([restated, next]);
    expect(evidence).toEqual([next, restated, original]);
  });

  it("omits conflicting same-day filings rather than choosing a convenient value", () => {
    const conflict = { ...original, value: 150, accession: "0000000001-23-000002" };
    expect(selectAnnualTrend([original, conflict, original])).toEqual([]);
    expect(selectAnnualTrend([conflict, original])).toEqual([]);
  });

  it("does not equate different duration contexts ending on the same day", () => {
    expect(selectAnnualTrend([original, { ...original, start: "2022-02-01" }])).toEqual([]);
  });

  it("lets a newer unambiguous filing resolve an earlier same-day conflict", () => {
    const corrected = { ...original, value: 95, filed: "2023-03-01" };
    expect(selectAnnualTrend([original, { ...original, value: 80 }, corrected])).toEqual([
      corrected,
    ]);
  });
});
