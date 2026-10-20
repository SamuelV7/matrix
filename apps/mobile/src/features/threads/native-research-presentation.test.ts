import {
  RunId,
  ThreadId,
  TurnItemId,
  type MatrixAnswer,
  type MatrixResearchDataset,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  nativeResearchColor,
  nativeResearchCompare,
  nativeResearchFocus,
  nativeResearchPage,
  nativeResearchRows,
  nativeResearchSourceUrl,
  nativeResearchView,
} from "./native-research-presentation";

const dataset: MatrixResearchDataset = {
  id: "corn",
  title: "Corn",
  frequency: "annual",
  geography: "country",
  timeBasis: "Calendar year",
  defaultYear: 2023,
  entities: [
    { id: "missing", name: "Missing", iso3: "MIS" },
    { id: "negative", name: "Negative", iso3: "NEG" },
    { id: "zero", name: "Zero", iso3: "ZER" },
    { id: "small", name: "Small", iso3: "SML" },
    { id: "large", name: "Large", iso3: "LRG" },
    { id: "OWID_WRL", name: "World", iso3: null },
  ],
  measures: [
    {
      id: "production",
      label: "Production",
      unit: "tonnes",
      description: "Source production",
      sourceIds: ["fao"],
      derived: false,
      colorScale: "sequential",
    },
  ],
  observations: [
    { entityId: "missing", year: 2022, values: { production: 900, droughtIndex: 0 } },
    { entityId: "negative", year: 2023, values: { production: -2, droughtIndex: -2 } },
    { entityId: "zero", year: 2023, values: { production: 0, droughtIndex: null } },
    { entityId: "small", year: 2023, values: { production: 9, droughtIndex: 0 } },
    { entityId: "large", year: 2023, values: { production: 100, droughtIndex: 1 } },
    { entityId: "OWID_WRL", year: 2023, values: { production: 500, droughtIndex: null } },
  ],
  sources: [
    {
      id: "fao",
      name: "FAO",
      url: "https://www.fao.org/",
      downloadUrl: "https://api.ourworldindata.org/v1/indicators/1198621.data.json",
      retrievedAt: "2026-10-20",
      updatedAt: null,
      license: "Source terms",
      description: "Fixture source metadata",
    },
  ],
  warnings: [],
};

describe("native linked research selection", () => {
  it("moves map and table country focus to the first series without duplicating or losing comparisons", () => {
    const selected = ["USA", "BRA", "OWID_WRL"];
    expect(nativeResearchFocus(selected, "BRA")).toEqual(["BRA", "USA", "OWID_WRL"]);
    expect(nativeResearchFocus(selected, "FRA")).toEqual(["FRA", "USA", "BRA", "OWID_WRL"]);
    expect(selected).toEqual(["USA", "BRA", "OWID_WRL"]);
    expect(nativeResearchFocus(["A", "B", "C", "D", "E", "F"], "G")).toEqual([
      "G",
      "A",
      "B",
      "C",
      "D",
      "E",
    ]);
  });

  it("retains at least one series and caps comparisons at the saved-view contract limit", () => {
    expect(nativeResearchCompare(["BRA"], "BRA")).toEqual(["BRA"]);
    expect(nativeResearchCompare(["BRA", "USA"], "BRA")).toEqual(["USA"]);
    expect(nativeResearchCompare(["BRA"], "OWID_WRL")).toEqual(["BRA", "OWID_WRL"]);
    expect(nativeResearchCompare(["A", "B", "C", "D", "E", "F"], "G")).toEqual([
      "A",
      "B",
      "C",
      "D",
      "E",
      "F",
    ]);
  });

  it("preserves saved focus through pinning and same-run enrichment and accepts authored focus on a new presentation", () => {
    const answer: MatrixAnswer = {
      id: TurnItemId.make("research-answer"),
      threadId: ThreadId.make("research-thread"),
      revision: 1,
      pinned: false,
      createdAt: "2026-10-20T12:00:00Z",
      updatedAt: "2026-10-20T12:00:00Z",
      lastPresentedRunId: RunId.make("first-run"),
      spec: {
        title: "Corn production",
        summary: "Source observations",
        level: "guided",
        symbols: [],
        queries: [{ id: "corn", kind: "crop", crop: "corn", entities: ["small"], year: 2023 }],
        blocks: [{ id: "map", kind: "map", dataset: "corn", measure: "production" }],
      },
      companies: [],
      datasets: [dataset],
      views: [
        {
          datasetId: "corn",
          view: { entities: ["large", "OWID_WRL"], year: 2022, measure: "production" },
        },
      ],
    };
    expect(nativeResearchView(answer, dataset)).toEqual({
      entities: ["large", "OWID_WRL"],
      year: 2022,
      measure: "production",
    });
    const enriched = {
      ...answer,
      revision: 2,
      pinned: true,
      datasets: [{ ...dataset, warnings: ["Original source flags are unavailable."] }],
    };
    expect(nativeResearchView(enriched, enriched.datasets[0]!)).toEqual(
      nativeResearchView(answer, dataset),
    );
    const presented = {
      ...enriched,
      revision: 3,
      lastPresentedRunId: RunId.make("second-run"),
      views: [],
    };
    expect(nativeResearchView(presented, dataset)).toEqual({
      entities: ["small"],
      year: 2023,
      measure: "production",
    });
    expect(presented.spec).toBe(answer.spec);
    expect(
      nativeResearchView(
        {
          ...answer,
          views: [{ datasetId: "corn", view: { entities: [], year: null, measure: null } }],
        },
        dataset,
      ).entities,
    ).toEqual([]);
  });

  it("seeds the authored map measure ahead of a generic query while keeping reader selections", () => {
    const withYield: MatrixResearchDataset = {
      ...dataset,
      measures: [
        ...dataset.measures,
        { ...dataset.measures[0]!, id: "yield", label: "Yield", unit: "tonnes per hectare" },
      ],
    };
    const answer: MatrixAnswer = {
      id: TurnItemId.make("answer"),
      threadId: ThreadId.make("thread"),
      revision: 1,
      pinned: false,
      createdAt: "2026-10-20T12:00:00Z",
      updatedAt: "2026-10-20T12:00:00Z",
      spec: {
        title: "Yield",
        summary: "",
        level: "guided",
        symbols: [],
        blocks: [{ id: "yield", kind: "map", dataset: "corn", measure: "yield" }],
      },
      companies: [],
    };
    expect(nativeResearchView(answer, withYield).measure).toBe("yield");
    expect(
      nativeResearchView(
        {
          ...answer,
          views: [
            { datasetId: "corn", view: { entities: ["small"], year: null, measure: "production" } },
          ],
        },
        withYield,
      ).measure,
    ).toBe("production");
    expect(
      nativeResearchView(
        {
          ...answer,
          spec: {
            ...answer.spec,
            queries: [{ id: "corn", kind: "crop", crop: "corn", measure: "production" }],
          },
        },
        withYield,
      ).measure,
    ).toBe("yield");
    const indicatorDataset: MatrixResearchDataset = {
      ...dataset,
      measures: [
        { ...dataset.measures[0]!, id: "NY.GDP.MKTP.KD.ZG", label: "GDP growth", unit: "percent" },
      ],
      observations: [
        { entityId: "small", year: 2023, values: { "NY.GDP.MKTP.KD.ZG": 2 } },
        { entityId: "large", year: 2023, values: { "NY.GDP.MKTP.KD.ZG": 10 } },
      ],
    };
    const indicatorsAnswer: MatrixAnswer = {
      ...answer,
      spec: {
        ...answer.spec,
        queries: [
          {
            id: dataset.id,
            kind: "indicators",
            indicators: ["NY.GDP.MKTP.KD.ZG"],
            measure: "NY.GDP.MKTP.KD.ZG",
          },
        ],
      },
    };
    expect(nativeResearchView(indicatorsAnswer, indicatorDataset).measure).toBe(
      "NY.GDP.MKTP.KD.ZG",
    );
    expect(
      nativeResearchRows(indicatorDataset, 2023, { measure: "NY.GDP.MKTP.KD.ZG", descending: true })
        .slice(0, 2)
        .map((row) => row.entity.id),
    ).toEqual(["large", "small"]);
  });

  it("sorts exact-year country and World values numerically with missing values last in either direction", () => {
    const descending = nativeResearchRows(dataset, 2023, {
      measure: "production",
      descending: true,
    });
    expect(descending.map((row) => row.entity.id)).toEqual([
      "OWID_WRL",
      "large",
      "small",
      "zero",
      "negative",
      "missing",
    ]);
    const ascending = nativeResearchRows(dataset, 2023, {
      measure: "production",
      descending: false,
    });
    expect(ascending.map((row) => row.entity.id)).toEqual([
      "negative",
      "zero",
      "small",
      "large",
      "OWID_WRL",
      "missing",
    ]);
    expect(descending[5]?.observation).toBeUndefined();
    expect(dataset.entities[0]?.id).toBe("missing");
  });

  it("bounds native table pages without hiding source rows and filters before counting or paging", () => {
    const countries: MatrixResearchDataset = {
      ...dataset,
      entities: Array.from({ length: 205 }, (_, index) => ({
        id: `country${index}`,
        name: `Country ${String(index).padStart(3, "0")}`,
        iso3: null,
      })),
      observations: Array.from({ length: 205 }, (_, index) => ({
        entityId: `country${index}`,
        year: 2023,
        values: { production: index },
      })),
    };
    const rows = nativeResearchRows(countries, 2023, { measure: "production", descending: true });
    const first = nativeResearchPage(rows, { search: "", entities: null, page: 0 });
    expect(first).toMatchObject({ first: 1, last: 20, total: 205, page: 0, pageCount: 11 });
    const pages = Array.from({ length: first.pageCount }, (_, page) =>
      nativeResearchPage(rows, { search: "", entities: null, page }),
    );
    expect(pages.every((page) => page.rows.length <= 20)).toBe(true);
    expect(pages.flatMap((page) => page.rows.map((row) => row.entity.id))).toEqual(
      rows.map((row) => row.entity.id),
    );
    expect(nativeResearchPage(rows, { search: "", entities: null, page: 999 })).toMatchObject({
      page: 10,
      first: 201,
      last: 205,
    });
    const searched = nativeResearchPage(rows, { search: " country 20 ", entities: null, page: 0 });
    expect(searched).toMatchObject({ total: 5, pageCount: 1, first: 1, last: 5 });
    expect(nativeResearchPage(rows, { search: "", entities: [], page: 0 })).toMatchObject({
      total: 0,
      first: 0,
      last: 0,
      rows: [],
    });
    expect(
      nativeResearchPage(rows, {
        search: "",
        entities: ["country3", "country1"],
        page: 0,
      }).rows.map((row) => row.entity.id),
    ).toEqual(["country3", "country1"]);
  });

  it("never derives a global drought value or fills unavailable climate cells with prior years", () => {
    const rows = nativeResearchRows(dataset, 2023, { measure: "droughtIndex", descending: true });
    expect(
      rows.find((row) => row.entity.id === "OWID_WRL")?.observation?.values.droughtIndex,
    ).toBeNull();
    expect(rows.find((row) => row.entity.id === "missing")?.observation).toBeUndefined();
    expect(rows.find((row) => row.entity.id === "small")?.observation?.values.droughtIndex).toBe(0);
    expect(nativeResearchColor(null, [-2, 1], true)).not.toBe(
      nativeResearchColor(0, [-2, 1], true),
    );
    expect(nativeResearchColor(-2, [-2, 1], true)).not.toBe(nativeResearchColor(1, [-2, 1], true));
    expect(nativeResearchColor(0, null, true)).toBe(nativeResearchColor(null, [-2, 1], true));
  });

  it.each([
    ["https://api.ourworldindata.org/v1/indicators/1198621.data.json", true],
    ["https://api.worldbank.org/v2/country/all/indicator/EN.CLC.SPEI.XD", true],
    ["https://www.naturalearthdata.com/", true],
    ["https://name:password@example.org/", false],
    ["http://example.org", false],
    ["javascript:alert(1)", false],
    ["not a URL", false],
  ])(
    "permits source HTTPS links without weakening the SEC-only financial link policy: %s",
    (url, allowed) => {
      expect(nativeResearchSourceUrl(url)).toBe(allowed);
    },
  );
});
