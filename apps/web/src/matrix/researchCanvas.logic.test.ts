import { describe, expect, it } from "vite-plus/test";
import {
  researchFill,
  researchScale,
  sortResearchRows,
  toggleResearchEntity,
  researchTablePage,
  type ResearchYearRow,
} from "./researchCanvas.logic";

const rows: ResearchYearRow[] = [
  {
    entity: { id: "A", name: "A", iso3: "AAA" },
    observation: { entityId: "A", year: 2023, values: { production: 9 } },
  },
  {
    entity: { id: "B", name: "B", iso3: "BBB" },
    observation: { entityId: "B", year: 2023, values: { production: 100 } },
  },
  {
    entity: { id: "C", name: "C", iso3: "CCC" },
    observation: { entityId: "C", year: 2023, values: { production: null } },
  },
  {
    entity: { id: "D", name: "D", iso3: "DDD" },
    observation: { entityId: "D", year: 2023, values: { production: 0 } },
  },
  { entity: { id: "E", name: "E", iso3: "EEE" }, observation: undefined },
];

describe("research canvas comparisons", () => {
  it("replaces the World aggregate on country selection and resets to World explicitly", () => {
    expect(toggleResearchEntity(["OWID_WRL"], "BRA")).toEqual(["BRA"]);
    expect(toggleResearchEntity(["BRA", "USA"], "OWID_WRL")).toEqual(["OWID_WRL"]);
    expect(toggleResearchEntity(["BRA"], "BRA")).toEqual([]);
    expect(toggleResearchEntity(["OWID_WRL"], "OWID_WRL")).toEqual([]);
  });

  it("caps comparison at six without dropping an existing selection", () => {
    const six = ["BRA", "USA", "ARG", "CHN", "IND", "MEX"];
    expect(toggleResearchEntity(six, "FRA")).toEqual(six);
    expect(toggleResearchEntity(six, "USA")).toEqual(["BRA", "ARG", "CHN", "IND", "MEX"]);
  });

  it("sorts by numeric observations with zero distinct from missing in both directions", () => {
    expect(sortResearchRows(rows, "production", "desc").map((row) => row.entity.id)).toEqual([
      "B",
      "A",
      "D",
      "C",
      "E",
    ]);
    expect(sortResearchRows(rows, "production", "asc").map((row) => row.entity.id)).toEqual([
      "D",
      "A",
      "B",
      "C",
      "E",
    ]);
  });

  it("treats dotted World Bank indicator codes as complete measure identifiers", () => {
    const indicator = "NY.GDP.MKTP.KD.ZG";
    const indicatorRows = rows.map((row) => ({
      ...row,
      observation: row.observation
        ? {
            ...row.observation,
            values: { [indicator]: row.observation.values.production ?? null },
          }
        : undefined,
    }));
    expect(sortResearchRows(indicatorRows, indicator, "desc").map((row) => row.entity.id)).toEqual([
      "B",
      "A",
      "D",
      "C",
      "E",
    ]);
  });
});

describe("research table pagination", () => {
  it("bounds displayed rows to twenty while keeping every row reachable in source sort order", () => {
    const values = Array.from({ length: 47 }, (_, index) => index);
    const first = researchTablePage(values, 0);
    const second = researchTablePage(values, 1);
    const last = researchTablePage(values, 2);
    expect(first.rows).toHaveLength(20);
    expect(second.rows).toHaveLength(20);
    expect(last.rows).toHaveLength(7);
    expect([first.start, first.end, first.total, first.pageCount]).toEqual([1, 20, 47, 3]);
    expect([last.start, last.end]).toEqual([41, 47]);
    expect([...first.rows, ...second.rows, ...last.rows]).toEqual(values);
  });

  it("clamps pages after filtering and reports an empty result without phantom rows", () => {
    expect(researchTablePage([1, 2, 3], 12)).toMatchObject({
      rows: [1, 2, 3],
      page: 0,
      pageCount: 1,
      start: 1,
      end: 3,
    });
    expect(researchTablePage([], 2)).toMatchObject({
      rows: [],
      total: 0,
      start: 0,
      end: 0,
      page: 0,
    });
    expect(researchTablePage([1], -2).page).toBe(0);
  });
});

describe("research map legends", () => {
  it("uses a zero-centered symmetric diverging scale for dry and wet years", () => {
    const scale = researchScale([-2.3095, 0.1948], { colorScale: "diverging" });
    expect(scale).toEqual({ min: -2.3095, max: 2.3095, diverging: true });
    expect(researchFill(0, scale)).toBe("rgb(226,232,240)");
    expect(researchFill(-2.3095, scale)).toBe("rgb(180,83,9)");
    expect(researchFill(2.3095, scale)).toBe("rgb(14,116,144)");
  });

  it("keeps missingness distinct from zero and does not invent a domain for no data", () => {
    const scale = researchScale([0, 100], { colorScale: "sequential" });
    expect(researchScale([], { colorScale: "sequential" })).toBeNull();
    expect(researchFill(null, scale)).toBe("#475569");
    expect(researchFill(0, scale)).not.toBe(researchFill(null, scale));
    expect(researchScale([0], { colorScale: "sequential" })).toEqual({
      min: 0,
      max: 0,
      diverging: false,
    });
    expect(researchFill(0, researchScale([0], { colorScale: "diverging" }))).toBe(
      "rgb(226,232,240)",
    );
  });
});
