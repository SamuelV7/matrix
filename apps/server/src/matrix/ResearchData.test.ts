import { describe, expect, it } from "@effect/vitest";
import type { MatrixResearchDataset, MatrixResearchQuery } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as ResearchData from "./ResearchData.ts";
import * as WdiData from "./WdiData.ts";

const ENTITIES = [
  { id: 37, name: "Brazil", code: "BRA" },
  { id: 13, name: "United States", code: "USA" },
  { id: 355, name: "World", code: "OWID_WRL" },
  { id: 330401, name: "Africa (FAO)", code: null },
];
const INDICATORS: Record<number, { crop: string; metric: string; unit: string }> = {
  1198621: { crop: "Maize", metric: "production", unit: "tonnes" },
  1198618: { crop: "Maize", metric: "harvestedArea", unit: "hectares" },
  1198624: { crop: "Maize", metric: "yield", unit: "tonnes per hectare" },
  1199532: { crop: "Wheat", metric: "production", unit: "tonnes" },
  1199529: { crop: "Wheat", metric: "harvestedArea", unit: "hectares" },
  1199535: { crop: "Wheat", metric: "yield", unit: "tonnes per hectare" },
};
type IndicatorRows = { values: number[]; years: number[]; entities: number[] };
const data = (metric: string): IndicatorRows => {
  switch (metric) {
    case "production":
      return {
        entities: [37, 37, 13, 13, 355, 355, 330401],
        years: [2023, 2024, 2023, 2024, 2023, 2024, 2024],
        values: [131949710, 114953304, 389694460, 377632700, 1238582500, 1218205600, 100],
      };
    case "harvestedArea":
      return {
        entities: [355, 13, 37, 37],
        years: [2024, 2024, 2024, 2023],
        values: [209954368, 33547180, 21186816, 22315010],
      };
    default:
      return {
        entities: [13, 355, 37, 13, 37],
        years: [2024, 2024, 2023, 2023, 2024],
        values: [11.256801, 5.8022003, 5.913, 11.1306, 5.4257007],
      };
  }
};
const metadata = (id: number) => ({
  id,
  name: `${INDICATORS[id]!.crop} | FAO annual observations`,
  unit: INDICATORS[id]!.unit,
  timespan: "1961-2024",
  datasetId: 7391,
  datasetVersion: "2026-02-25",
  dimensions: { entities: { values: ENTITIES } },
  origins: [
    {
      producer: "Food and Agriculture Organization of the United Nations",
      title: "Production: Crops and livestock products",
      datePublished: "2025-12-31",
      license: { name: "CC BY-NC-SA 3.0 IGO" },
    },
  ],
});
const droughtRow = (countryiso3code: string, date: string, value: number | null) => ({
  indicator: { id: "EN.CLC.SPEI.XD" },
  countryiso3code,
  date,
  value,
  unit: "",
});
const droughtRows = [
  droughtRow("BRA", "2023", -2.3095),
  droughtRow("BRA", "2024", null),
  droughtRow("USA", "2023", 0.1948),
  droughtRow("USA", "2024", null),
  droughtRow("", "2023", null),
  droughtRow("", "2024", null),
];
const droughtPage = (page: number, perPage = 20_000, rows = droughtRows) => [
  {
    page,
    pages: Math.ceil(rows.length / perPage),
    per_page: perPage,
    total: rows.length,
    sourceid: "75",
    lastupdated: "2026-06-24",
  },
  rows.slice((page - 1) * perPage, page * perPage),
];
const query: MatrixResearchQuery = {
  id: "corn-history",
  kind: "crop",
  crop: "corn",
  fromYear: 2023,
  toYear: 2024,
};
const observation = (dataset: MatrixResearchDataset, entityId: string, year: number) => {
  const result = dataset.observations.find((row) => row.entityId === entityId && row.year === year);
  expect(result).toBeDefined();
  return result!;
};

function fixture() {
  const requests: URL[] = [];
  const overrides = new Map<string, () => Response>();
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      const url = new URL(request.url);
      requests.push(url);
      const override = overrides.get(url.pathname);
      if (url.pathname === "/v2/source/2/indicator") {
        return HttpClientResponse.fromWeb(
          request,
          Response.json([
            { page: 1, pages: 1, per_page: "10000", total: 1 },
            [
              {
                id: "SP.POP.TOTL",
                name: "Population, total",
                unit: "",
                source: { id: "2", value: "World Development Indicators" },
                sourceNote: "Total population.",
                sourceOrganization: "United Nations",
                topics: [{ id: "19", value: "Population" }],
              },
            ],
          ]),
        );
      }
      if (override) return HttpClientResponse.fromWeb(request, override());
      if (url.hostname === "api.worldbank.org") {
        return HttpClientResponse.fromWeb(
          request,
          Response.json(droughtPage(Number(url.searchParams.get("page") ?? 1))),
        );
      }
      const match = /\/(\d+)\.(metadata|data)\.json$/.exec(url.pathname);
      if (!match || !INDICATORS[Number(match[1])])
        throw new Error(`Unexpected fixture URL: ${url}`);
      const id = Number(match[1]);
      return HttpClientResponse.fromWeb(
        request,
        Response.json(match[2] === "metadata" ? metadata(id) : data(INDICATORS[id]!.metric)),
      );
    }),
  );
  return {
    http,
    requests,
    override: (path: string, response: () => Response) => {
      overrides.set(path, response);
    },
    clear: (path: string) => {
      overrides.delete(path);
    },
    layer: ResearchData.layer.pipe(
      Layer.provide(WdiData.layer),
      Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
    ),
  };
}
const indicatorPath = (id: number, kind = "data") => `/v1/indicators/${id}.${kind}.json`;
const droughtPath = "/v2/country/all/indicator/EN.CLC.SPEI.XD";

describe("ResearchData", () => {
  it.effect(
    "joins independently ordered indicators by entity/year and retains country history beyond selected focus",
    () => {
      const f = fixture();
      return Effect.gen(function* () {
        const service = yield* ResearchData.ResearchData;
        const result = yield* service.query({
          ...query,
          entities: ["BRA"],
          year: 2023,
          measure: "production",
        });
        expect(observation(result, "BRA", 2024).values).toMatchObject({
          production: 114953304,
          harvestedArea: 21186816,
          yield: 5.4257007,
        });
        expect(observation(result, "OWID_WRL", 2024).values.production).toBe(1218205600);
        expect(observation(result, "USA", 2024).values.harvestedArea).toBe(33547180);
        expect(observation(result, "USA", 2023).values.harvestedArea).toBeNull();
        expect(result.entities.map((entity) => entity.id)).toEqual(["BRA", "OWID_WRL", "USA"]);
        expect(result.entities.find((entity) => entity.id === "OWID_WRL")?.iso3).toBeNull();
        expect(result.defaultYear).toBe(2024);
        expect(result.observations.every((row) => row.status === "mixed")).toBe(true);
        expect(result.sources).toHaveLength(3);
        expect(result.sources.every((source) => source.license === "CC BY-NC-SA 3.0 IGO")).toBe(
          true,
        );
        expect(result.measures.some((measure) => measure.id === "droughtIndex")).toBe(false);
      }).pipe(Effect.provide(f.layer));
    },
  );

  it.effect(
    "computes exact prior-year growth using the predecessor outside requested bounds",
    () => {
      const f = fixture();
      return Effect.gen(function* () {
        const service = yield* ResearchData.ResearchData;
        const result = yield* service.query({ ...query, fromYear: 2024 });
        expect(result.observations.every((row) => row.year === 2024)).toBe(true);
        const brazil = observation(result, "BRA", 2024);
        expect(brazil.values.productionGrowth).toBeCloseTo((114953304 / 131949710 - 1) * 100, 10);
        expect(brazil.values.yieldGrowth).toBeCloseTo((5.4257007 / 5.913 - 1) * 100, 10);
        expect(observation(result, "OWID_WRL", 2024).values.yieldGrowth).toBeNull();
      }).pipe(Effect.provide(f.layer));
    },
  );

  it.effect(
    "does not treat missing or zero predecessor as zero growth or bridge a multi-year gap",
    () => {
      const f = fixture();
      f.override(indicatorPath(1198621), () =>
        Response.json({
          entities: [37, 37, 13, 13],
          years: [2023, 2024, 2022, 2024],
          values: [0, 10, 20, 30],
        }),
      );
      return Effect.gen(function* () {
        const service = yield* ResearchData.ResearchData;
        const result = yield* service.query({ ...query, fromYear: 2024 });
        expect(observation(result, "BRA", 2024).values.productionGrowth).toBeNull();
        expect(observation(result, "USA", 2024).values.productionGrowth).toBeNull();
      }).pipe(Effect.provide(f.layer));
    },
  );

  it.effect(
    "uses verified FAO-only wheat indicators rather than the mixed-source wheat-yield chart",
    () => {
      const f = fixture();
      f.override(indicatorPath(1199532), () =>
        Response.json({ entities: [37], years: [2024], values: [10] }),
      );
      f.override(indicatorPath(1199529), () =>
        Response.json({ entities: [37], years: [2024], values: [4] }),
      );
      f.override(indicatorPath(1199535), () =>
        Response.json({ entities: [37], years: [2024], values: [2.5] }),
      );
      return Effect.gen(function* () {
        const service = yield* ResearchData.ResearchData;
        const result = yield* service.query({ ...query, crop: "wheat" });
        expect(observation(result, "BRA", 2024).values).toMatchObject({
          production: 10,
          harvestedArea: 4,
          yield: 2.5,
        });
      }).pipe(Effect.provide(f.layer));
    },
  );

  it.effect(
    "joins historical SPEI by ISO3, preserves 2024 nulls and defaults to the latest paired country year",
    () => {
      const f = fixture();
      return Effect.gen(function* () {
        const service = yield* ResearchData.ResearchData;
        const result = yield* service.query({ ...query, includeDrought: true });
        expect(result.defaultYear).toBe(2023);
        expect(observation(result, "BRA", 2023).values.droughtIndex).toBe(-2.3095);
        expect(observation(result, "USA", 2023).values.droughtIndex).toBe(0.1948);
        expect(observation(result, "BRA", 2024).values.droughtIndex).toBeNull();
        expect(
          result.observations
            .filter((row) => row.entityId === "OWID_WRL")
            .every((row) => row.values.droughtIndex === null),
        ).toBe(true);
        expect(result.sources.find((source) => source.id === "worldbank-spei")).toMatchObject({
          updatedAt: "2026-06-24",
          license: "CC BY 4.0",
        });
      }).pipe(Effect.provide(f.layer));
    },
  );

  it.effect(
    "does not collapse distinct uncoded territories and World into a conflicting climate entity",
    () => {
      const f = fixture();
      const rows = [
        ...droughtRows,
        { ...droughtRow("", "2023", 0.3225), country: { id: "", value: "American Samoa" } },
        { ...droughtRow("", "2023", -0.4), country: { id: "", value: "Aruba" } },
      ];
      f.override(droughtPath, () => Response.json(droughtPage(1, 20_000, rows)));
      return Effect.gen(function* () {
        const service = yield* ResearchData.ResearchData;
        const result = yield* service.query({ ...query, includeDrought: true });
        expect(observation(result, "BRA", 2023).values.droughtIndex).toBe(-2.3095);
        expect(observation(result, "USA", 2023).values.droughtIndex).toBe(0.1948);
        expect(observation(result, "OWID_WRL", 2023).values.droughtIndex).toBeNull();
      }).pipe(Effect.provide(f.layer));
    },
  );

  it.effect(
    "keeps real production data when the requested range has no paired drought coverage",
    () => {
      const f = fixture();
      return Effect.gen(function* () {
        const service = yield* ResearchData.ResearchData;
        const result = yield* service.query({ ...query, fromYear: 2024, includeDrought: true });
        expect(result.defaultYear).toBe(2024);
        expect(observation(result, "BRA", 2024).values.production).toBe(114953304);
        expect(observation(result, "BRA", 2024).values.droughtIndex).toBeNull();
      }).pipe(Effect.provide(f.layer));
    },
  );

  it.effect("follows validated pagination before exposing any drought result", () => {
    const f = fixture();
    let page = 0;
    const rows = [
      ...droughtRows.filter((row) => row.countryiso3code !== "USA"),
      ...droughtRows.filter((row) => row.countryiso3code === "USA"),
    ];
    f.override(droughtPath, () => Response.json(droughtPage(++page, 2, rows)));
    return Effect.gen(function* () {
      const service = yield* ResearchData.ResearchData;
      const result = yield* service.query({ ...query, includeDrought: true });
      expect(observation(result, "USA", 2023).values.droughtIndex).toBe(0.1948);
    }).pipe(Effect.provide(f.layer));
  });

  it.effect("rejects repeated drought pages instead of accepting partial coverage", () => {
    const f = fixture();
    f.override(droughtPath, () => Response.json(droughtPage(1, 2)));
    return Effect.gen(function* () {
      const service = yield* ResearchData.ResearchData;
      const error = yield* Effect.flip(service.query({ ...query, includeDrought: true }));
      expect(error).toMatchObject({
        reason: "upstream",
        source: "worldbank",
        category: "pagination",
      });
    }).pipe(Effect.provide(f.layer));
  });

  it.effect(
    "rejects conflicting duplicate crop observations and recovers without caching failure",
    () => {
      const f = fixture();
      f.override(indicatorPath(1198621), () =>
        Response.json({ entities: [37, 37], years: [2024, 2024], values: [10, 11] }),
      );
      return Effect.gen(function* () {
        const service = yield* ResearchData.ResearchData;
        const error = yield* Effect.flip(service.query(query));
        expect(error).toMatchObject({ reason: "upstream", category: "conflict" });
        f.clear(indicatorPath(1198621));
        const recovered = yield* service.query(query);
        expect(observation(recovered, "BRA", 2024).values.production).toBe(114953304);
      }).pipe(Effect.provide(f.layer));
    },
  );

  it.effect(
    "rejects conflicting duplicate SPEI observations without caching a partial response",
    () => {
      const f = fixture();
      const rows = [droughtRow("BRA", "2023", -2), droughtRow("BRA", "2023", 0)];
      f.override(droughtPath, () => Response.json(droughtPage(1, 20_000, rows)));
      return Effect.gen(function* () {
        const service = yield* ResearchData.ResearchData;
        const error = yield* Effect.flip(service.query({ ...query, includeDrought: true }));
        expect(error).toMatchObject({ source: "worldbank", category: "conflict" });
        f.clear(droughtPath);
        const result = yield* service.query({ ...query, includeDrought: true });
        expect(observation(result, "BRA", 2023).values.droughtIndex).toBe(-2.3095);
      }).pipe(Effect.provide(f.layer));
    },
  );

  it.effect(
    "caches validated success for six hours, then refreshes rather than serving stale success on failure",
    () => {
      const f = fixture();
      return Effect.gen(function* () {
        const service = yield* ResearchData.ResearchData;
        yield* service.query(query);
        f.override(indicatorPath(1198621), () =>
          Response.json({ error: "temporarily unavailable" }, { status: 503 }),
        );
        const fresh = yield* service.query({ ...query, id: "another-id", entities: ["USA"] });
        expect(observation(fresh, "BRA", 2024).values.production).toBe(114953304);
        yield* TestClock.adjust("6 hours");
        const error = yield* Effect.flip(service.query(query));
        expect(error).toMatchObject({ reason: "upstream", category: "http" });
        f.clear(indicatorPath(1198621));
        const recovered = yield* service.query(query);
        expect(observation(recovered, "BRA", 2024).values.production).toBe(114953304);
        f.override(indicatorPath(1198621), () => new Response("unavailable", { status: 503 }));
        const cachedRecovery = yield* service.query(query);
        expect(observation(cachedRecovery, "BRA", 2024).values.production).toBe(114953304);
      }).pipe(Effect.provide(f.layer));
    },
  );

  it.effect.each([
    ["different source version", () => ({ ...metadata(1198621), datasetVersion: "2027-01-01" })],
    ["wrong units", () => ({ ...metadata(1198621), unit: "kilograms" })],
    ["different crop", () => ({ ...metadata(1198621), name: "Rice | Production" })],
    [
      "conflicting entity mapping",
      () => ({
        ...metadata(1198621),
        dimensions: {
          entities: { values: [...ENTITIES, { id: 99, name: "Brazil", code: "BRA" }] },
        },
      }),
    ],
  ] as const)("rejects %s in source metadata", ([_name, body]) => {
    const f = fixture();
    f.override(indicatorPath(1198621, "metadata"), () => Response.json(body()));
    return Effect.gen(function* () {
      const service = yield* ResearchData.ResearchData;
      const error = yield* Effect.flip(service.query(query));
      expect(error.reason).toBe("upstream");
      expect(error.source).toBe("fao");
    }).pipe(Effect.provide(f.layer));
  });

  it.effect.each([
    ["misaligned arrays", { entities: [37], years: [2024, 2023], values: [10] }],
    ["non-finite/null observations", { entities: [37], years: [2024], values: [null] }],
    ["negative crop values", { entities: [37], years: [2024], values: [-1] }],
    ["unknown entity IDs", { entities: [999], years: [2024], values: [10] }],
    ["empty responses", { entities: [], years: [], values: [] }],
  ] as const)("rejects %s instead of creating empty or misleading datasets", ([_name, body]) => {
    const f = fixture();
    f.override(indicatorPath(1198621), () => Response.json(body));
    return Effect.gen(function* () {
      const service = yield* ResearchData.ResearchData;
      const error = yield* Effect.flip(service.query(query));
      expect(error.reason).toBe("upstream");
    }).pipe(Effect.provide(f.layer));
  });

  it.effect("bounds streamed body size even without a content-length header", () => {
    const f = fixture();
    f.override(indicatorPath(1198621), () => new Response(" ".repeat(4 * 1024 * 1024 + 1)));
    return Effect.gen(function* () {
      const service = yield* ResearchData.ResearchData;
      const error = yield* Effect.flip(service.query(query));
      expect(error).toMatchObject({ reason: "upstream", category: "limit" });
    }).pipe(Effect.provide(f.layer));
  });

  it.effect("times out a stalled source request with a typed actionable failure", () => {
    const f = fixture();
    let stalled = true;
    const http = HttpClient.make((request) => (stalled ? Effect.never : f.http.execute(request)));
    return Effect.gen(function* () {
      const service = yield* ResearchData.ResearchData;
      const pending = yield* Effect.flip(service.query(query)).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* TestClock.adjust("20 seconds");
      const error = yield* Fiber.join(pending);
      expect(error).toMatchObject({ reason: "upstream", category: "network" });
      stalled = false;
      const recovered = yield* service.query(query);
      expect(observation(recovered, "BRA", 2024).values.production).toBe(114953304);
    }).pipe(
      Effect.provide(
        ResearchData.layer.pipe(
          Layer.provide(WdiData.layer),
          Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
        ),
      ),
    );
  });

  it.effect.each([
    { ...query, crop: "rice" },
    { ...query, fromYear: 1960 },
    { ...query, fromYear: 2024, toYear: 2023 },
    { ...query, year: 2022 },
    { ...query, measure: "droughtIndex" },
    { ...query, entities: ["BRA", "BRA"] },
  ])("rejects unsupported query %j before fetching", (input) => {
    const f = fixture();
    return Effect.gen(function* () {
      const service = yield* ResearchData.ResearchData;
      const error = yield* Effect.flip(service.query(input));
      expect(error.reason).toBe("invalid_query");
      expect(f.requests).toHaveLength(0);
    }).pipe(Effect.provide(f.layer));
  });
});
