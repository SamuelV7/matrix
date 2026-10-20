import { describe, expect, it } from "vite-plus/test";
import type { MatrixResearchDataset } from "@t3tools/contracts";
import {
  formatResearchValue,
  formatResearchDifference,
  researchChange,
  researchBlockTitle,
  researchObservation,
  researchRanking,
  researchSeries,
  researchSeriesSegments,
  resolveResearchView,
} from "./matrixResearch.ts";

const dataset: MatrixResearchDataset = {
  id: "crop",
  title: "Annual corn",
  frequency: "annual",
  geography: "country",
  timeBasis: "Calendar-year production; historical country SPEI is not crop-area-weighted.",
  defaultYear: 2023,
  entities: [
    { id: "OWID_WRL", name: "World", iso3: null },
    { id: "BRA", name: "Brazil", iso3: "BRA" },
    { id: "USA", name: "United States", iso3: "USA" },
    { id: "OWID_SAM", name: "South America", iso3: null },
  ],
  measures: [
    {
      id: "production",
      label: "Production",
      unit: "tonnes",
      description: "Dry grain",
      sourceIds: ["fao"],
      derived: false,
      colorScale: "sequential",
    },
    {
      id: "droughtIndex",
      label: "SPEI",
      unit: "index",
      description: "Negative is drier",
      sourceIds: ["climate"],
      derived: false,
      colorScale: "diverging",
    },
  ],
  observations: [
    { entityId: "BRA", year: 2024, values: { production: 114953304, droughtIndex: null } },
    { entityId: "BRA", year: 2021, values: { production: 90, droughtIndex: 0 } },
    { entityId: "BRA", year: 2023, values: { production: 131949710, droughtIndex: -2.3095 } },
    { entityId: "USA", year: 2023, values: { production: 389694460, droughtIndex: 0.1948 } },
    { entityId: "OWID_WRL", year: 2023, values: { production: 1238582500, droughtIndex: null } },
    { entityId: "OWID_SAM", year: 2023, values: { production: 400000000, droughtIndex: null } },
  ],
  sources: [
    {
      id: "fao",
      name: "FAO via OWID",
      url: "https://ourworldindata.org/grapher/maize-production",
      downloadUrl: "https://api.ourworldindata.org/v1/indicators/1198621.data.json",
      retrievedAt: "2026-10-20T00:00:00Z",
      updatedAt: "2026-02-25",
      license: "Source terms apply",
      description: "Annual crop statistics",
    },
    {
      id: "climate",
      name: "World Bank",
      url: "https://data.worldbank.org/indicator/EN.CLC.SPEI.XD",
      downloadUrl: "https://api.worldbank.org/v2/country/all/indicator/EN.CLC.SPEI.XD?format=json",
      retrievedAt: "2026-10-20T00:00:00Z",
      updatedAt: "2026-06-24",
      license: "CC BY 4.0",
      description: "Country annual SPEI",
    },
  ],
  warnings: [],
};

describe("linked research semantics", () => {
  it("honors saved country/year/measure focus without substituting a neighboring year's observation", () => {
    const view = resolveResearchView(
      dataset,
      { id: "crop", kind: "crop", crop: "corn", entities: ["USA"], year: 2023 },
      { entities: ["BRA", "BRA", "USA"], year: 2024, measure: "droughtIndex" },
    );
    expect(view).toEqual({ entities: ["BRA", "USA"], year: 2024, measure: "droughtIndex" });
    expect(researchObservation(dataset, "BRA", view.year)?.values.droughtIndex).toBeNull();
    expect(researchObservation(dataset, "USA", view.year)).toBeUndefined();
  });

  it("keeps an explicitly cleared comparison empty instead of silently selecting World", () => {
    expect(
      resolveResearchView(dataset, undefined, {
        entities: [],
        year: 2023,
        measure: "production",
      }).entities,
    ).toEqual([]);
  });

  it("seeds a new map from its declared measure while preserving saved reader focus", () => {
    expect(resolveResearchView(dataset, undefined, undefined, "droughtIndex").measure).toBe(
      "droughtIndex",
    );
    const query = { id: "crop", kind: "crop", crop: "corn", measure: "production" } as const;
    expect(resolveResearchView(dataset, query, undefined, "droughtIndex").measure).toBe(
      "droughtIndex",
    );
    expect(
      resolveResearchView(
        dataset,
        query,
        { entities: ["BRA"], year: 2023, measure: "droughtIndex" },
        "production",
      ).measure,
    ).toBe("droughtIndex");
  });

  it("keeps map headings on the selected measure while history headings retain their fixed series measure", () => {
    const view = { measure: "droughtIndex" };
    const map = { id: "map", kind: "map", dataset: dataset.id, measure: "production" } as const;
    const series = {
      id: "history",
      kind: "series",
      dataset: dataset.id,
      measure: "production",
      chartType: "line",
    } as const;
    expect(researchBlockTitle(dataset, map, view)).toContain(dataset.measures[1]!.label);
    expect(researchBlockTitle(dataset, map, view)).not.toContain(dataset.measures[0]!.label);
    expect(researchBlockTitle(dataset, series, view)).toContain(dataset.measures[0]!.label);
    expect(researchBlockTitle(dataset, series, view)).not.toContain(dataset.measures[1]!.label);
  });

  it("retains real zero drought observations, omits nulls and breaks chart lines across missing years", () => {
    const series = researchSeries(dataset, "BRA", "droughtIndex");
    expect(series).toEqual([
      { year: 2021, value: 0 },
      { year: 2023, value: -2.3095 },
    ]);
    expect(researchSeriesSegments(series)).toEqual([[series[0]], [series[1]]]);
    const production = researchSeries(dataset, "BRA", "production");
    expect(
      researchSeriesSegments(production).map((points) => points.map((point) => point.year)),
    ).toEqual([[2021], [2023, 2024]]);
  });

  it("ranks countries numerically without double counting World or regional aggregates", () => {
    const ranking = researchRanking(dataset, 2023, "production");
    expect(ranking.map((row) => [row.entity.id, row.value])).toEqual([
      ["USA", 389694460],
      ["BRA", 131949710],
    ]);
    expect(researchRanking(dataset, 2024, "droughtIndex")).toEqual([]);
    expect(researchSeries(dataset, "OWID_WRL", "droughtIndex")).toEqual([]);
  });

  it("computes growth from the exact previous year and leaves missing or zero baselines unavailable", () => {
    const change = researchChange(dataset, "BRA", "production", 2024)!;
    expect(change.absolute).toBe(-16996406);
    expect(change.percent).toBeCloseTo(-12.88097261, 6);
    expect(researchChange(dataset, "BRA", "production", 2023)).toBeNull();
    const zeroBaseline: MatrixResearchDataset = {
      ...dataset,
      observations: [
        { entityId: "BRA", year: 2023, values: { production: 0 } },
        { entityId: "BRA", year: 2024, values: { production: 12 } },
      ],
    };
    expect(researchChange(zeroBaseline, "BRA", "production", 2024)).toEqual({
      absolute: 12,
      percent: null,
    });
  });

  it("keeps percentage units already scaled and distinguishes unavailable from a meaningful zero", () => {
    expect(formatResearchValue(-12.88, "%")).toBe("-12.88%");
    expect(formatResearchValue(0, "index")).toBe("0");
    expect(formatResearchValue(null, "tonnes")).toBe("Not available");
    expect(formatResearchValue(5.4257007, "tonnes per hectare", true)).toBe("5.43 t/ha");
    expect(formatResearchValue(114953304, "tonnes", false)).toBe("114,953,304 t");
  });

  it("formats large economic and population quantities without rescaling percentage observations", () => {
    expect(formatResearchValue(1_000_000_000_000, "current US$", true)).toBe("1T current US$");
    expect(formatResearchValue(338_000_000, "Unit", true)).toBe("338M Unit");
    expect(formatResearchValue(1_234, "annual %", true)).toBe("1,234 annual %");
    expect(formatResearchValue(2.16138195623856, "%")).toBe("2.16138195623856%");
  });

  it("distinguishes percentage-point differences from percentage levels and percentile ranks", () => {
    expect(formatResearchValue(5, "%")).toBe("5%");
    expect(formatResearchDifference(5 - 4, "%")).toBe("1 percentage points");
    expect(formatResearchDifference(-1.25, "% of GDP")).toBe("-1.25 percentage points");
    expect(formatResearchDifference(3, "Percentile rank")).toBe("3 Percentile rank");
    expect(formatResearchDifference(0, "tonnes")).toBe("0 t");
  });
});
