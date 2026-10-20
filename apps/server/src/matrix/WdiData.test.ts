import { describe, expect, it } from "@effect/vitest";
import type { MatrixResearchDataset, MatrixResearchQuery } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as WdiData from "./WdiData.ts";

const GDP = "NY.GDP.MKTP.KD.ZG";
const POPULATION = "SP.POP.TOTL";
const ENERGY = "EG.USE.PCAP.KG.OE";
const FOREST = "AG.LND.FRST.ZS";
const metadataPath = "/v2/source/2/indicator";
const countryPath = "/v2/country";
const valuePath = (code: string) => `/v2/country/all/indicator/${code}`;
const seriesPath = (code: string) => `/v2/sources/2/series/${code}/metadata`;
const metadata = (id: string, name: string, topic: string, sourceNote: string) => ({
  id,
  name,
  unit: "",
  source: { id: "2", value: "World Development Indicators" },
  sourceNote,
  sourceOrganization: "Original statistical provider",
  topics: [{ id: "1", value: ` ${topic} ` }],
});
const indicators = [
  metadata(
    GDP,
    "GDP growth (annual %)",
    "Economy & Growth",
    "Annual percentage growth rate of GDP at market prices based on constant 2015 U.S. dollars.",
  ),
  metadata(
    POPULATION,
    "Population, total",
    "Health",
    "Total population counts all residents regardless of legal status or citizenship.",
  ),
  metadata(
    ENERGY,
    "Energy use (kg of oil equivalent per capita)",
    "Energy & Mining",
    "Use of primary energy before transformation to other end-use fuels.",
  ),
  metadata(
    FOREST,
    "Forest area (% of land area)",
    "Environment",
    "Land under natural or planted stands of trees.",
  ),
];
const seriesAttributes = (code: string) => [
  {
    id: "Unitofmeasure",
    value: code === POPULATION ? "Unit" : code === ENERGY ? "kg of oil equivalent per capita" : "%",
  },
  { id: "Periodicity", value: "Annual" },
  { id: "License_Type", value: "CC BY-4.0" },
  { id: "License_URL", value: "https://datacatalog.worldbank.org/public-licenses#cc-by" },
  {
    id: "Longdefinition",
    value: indicators.find((indicator) => indicator.id === code)!.sourceNote,
  },
  { id: "Aggregationmethod", value: code === GDP ? "Weighted average" : "Sum" },
  { id: "Referenceperiod", value: "1960-2025" },
];
const seriesPage = (
  code: string,
  url: URL,
  attributes = seriesAttributes(code),
  perPage = 5_000,
) => {
  const number = Number(url.searchParams.get("page") ?? 1);
  return {
    page: number,
    pages: Math.ceil(attributes.length / perPage),
    per_page: String(perPage),
    total: attributes.length,
    source: [
      {
        id: "2",
        concept: [
          {
            id: "Series",
            variable: [
              { id: code, metatype: attributes.slice((number - 1) * perPage, number * perPage) },
            ],
          },
        ],
      },
    ],
  };
};
type FixtureValue = {
  indicator: { id: string };
  countryiso3code: string;
  date: string;
  value: number | null;
  unit: string;
  obs_status: string;
  decimal: number;
};
const countries = [
  { id: "BRA", name: "Brazil", region: { id: "LCN" } },
  { id: "USA", name: "United States", region: { id: "NAC" } },
  { id: "WLD", name: "World", region: { id: "NA" } },
  { id: "EAS", name: "East Asia & Pacific", region: { id: "NA" } },
];
const value = (code: string, countryiso3code: string, date: string, amount: number | null) => ({
  indicator: { id: code },
  countryiso3code,
  date,
  value: amount,
  unit: "",
  obs_status: "",
  decimal: 1,
});
const values: Record<string, FixtureValue[]> = {
  [GDP]: [
    value(GDP, "BRA", "2023", 3.2),
    value(GDP, "BRA", "2024", 3.4),
    value(GDP, "USA", "2025", 2.16138195623856),
    value(GDP, "USA", "2024", 2.79318715363841),
    value(GDP, "USA", "2023", 2.93436322440155),
    value(GDP, "WLD", "2024", 2.8),
    value(GDP, "EAS", "2024", 99),
    value(GDP, "", "2024", 100),
  ],
  [POPULATION]: [
    value(POPULATION, "WLD", "2024", 8_100),
    value(POPULATION, "USA", "2024", 340),
    value(POPULATION, "BRA", "2023", 210),
    value(POPULATION, "BRA", "2024", null),
  ],
  [ENERGY]: [value(ENERGY, "BRA", "2024", 1_400)],
  [FOREST]: [value(FOREST, "BRA", "2024", 59)],
};
const page = (items: readonly unknown[], url: URL, perPage: number, data = false) => {
  const number = Number(url.searchParams.get("page") ?? 1);
  return [
    {
      page: number,
      pages: Math.max(1, Math.ceil(items.length / perPage)),
      per_page: data ? perPage : String(perPage),
      total: items.length,
      ...(data ? { sourceid: "2", lastupdated: "2026-10-08" } : {}),
    },
    items.slice((number - 1) * perPage, number * perPage),
  ];
};
const query: Extract<MatrixResearchQuery, { kind: "indicators" }> = {
  id: "development-history",
  kind: "indicators",
  indicators: [GDP, POPULATION],
  fromYear: 2023,
  toYear: 2025,
};
const observation = (dataset: MatrixResearchDataset, entityId: string, year: number) => {
  const row = dataset.observations.find((item) => item.entityId === entityId && item.year === year);
  expect(row).toBeDefined();
  return row!;
};
function fixture() {
  const requests: URL[] = [];
  const overrides = new Map<string, (url: URL) => Response>();
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      const url = new URL(request.url);
      requests.push(url);
      const override = overrides.get(url.pathname);
      if (override) return HttpClientResponse.fromWeb(request, override(url));
      if (url.pathname === metadataPath)
        return HttpClientResponse.fromWeb(request, Response.json(page(indicators, url, 10_000)));
      if (url.pathname === countryPath)
        return HttpClientResponse.fromWeb(request, Response.json(page(countries, url, 1_000)));
      const seriesCode = /^\/v2\/sources\/2\/series\/([^/]+)\/metadata$/.exec(url.pathname)?.[1];
      if (seriesCode)
        return HttpClientResponse.fromWeb(request, Response.json(seriesPage(seriesCode, url)));
      const code = url.pathname.split("/").at(-1)!;
      const rows = values[code];
      if (!rows || url.hostname !== "api.worldbank.org" || url.searchParams.get("source") !== "2")
        throw new Error(`Unexpected fixture URL: ${url}`);
      const [from, to] = url.searchParams.get("date")!.split(":").map(Number);
      return HttpClientResponse.fromWeb(
        request,
        Response.json(
          page(
            rows.filter((row) => Number(row.date) >= from! && Number(row.date) <= to!),
            url,
            20_000,
            true,
          ),
        ),
      );
    }),
  );
  return {
    requests,
    http,
    override: (path: string, response: (url: URL) => Response) => {
      overrides.set(path, response);
    },
    clear: (path: string) => {
      overrides.delete(path);
    },
    layer: WdiData.layer.pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, http))),
  };
}

describe("WdiData", () => {
  it.effect(
    "discovers economy, population, energy and environment from actual source-2 metadata, not a whitelist",
    () => {
      const f = fixture();
      return Effect.gen(function* () {
        const service = yield* WdiData.WdiData;
        const catalog = yield* service.catalog();
        expect(catalog.indicatorCount).toBe(4);
        expect(new Set(catalog.indicators.map((item) => item.id))).toEqual(
          new Set([FOREST, ENERGY, GDP, POPULATION]),
        );
        expect(yield* service.catalog({ query: "energy mining" })).toMatchObject({
          indicatorCount: 1,
          indicators: [{ id: ENERGY }],
        });
        expect(yield* service.catalog({ query: "residents citizenship" })).toMatchObject({
          indicatorCount: 1,
          indicators: [{ id: POPULATION }],
        });
        expect(yield* service.catalog({ query: GDP.toLowerCase() })).toMatchObject({
          indicatorCount: 1,
          indicators: [{ id: GDP }],
        });
        expect(yield* service.catalog({ query: "no-such-indicator" })).toEqual({
          indicators: [],
          indicatorCount: 0,
          page: 1,
          pages: 1,
        });
        expect(f.requests).toHaveLength(1);
      }).pipe(Effect.provide(f.layer));
    },
  );

  it.effect("discovers and queries lowercase source identifiers without normalizing them", () => {
    const f = fixture();
    const code = "per_allsp.adq_pop_tot";
    const item = metadata(
      code,
      "Adequacy of social protection (% of welfare)",
      "Social Protection",
      "Transfer amounts as a share of beneficiary household welfare.",
    );
    f.override(metadataPath, (url) => Response.json(page([item], url, 10_000)));
    f.override(valuePath(code), (url) =>
      Response.json(page([value(code, "BRA", "2024", 12.5)], url, 20_000, true)),
    );
    const attributes = seriesAttributes(GDP).map((attribute) =>
      attribute.id === "Longdefinition" ? { ...attribute, value: item.sourceNote } : attribute,
    );
    f.override(seriesPath(code), (url) => Response.json(seriesPage(code, url, attributes)));
    return Effect.gen(function* () {
      const service = yield* WdiData.WdiData;
      expect((yield* service.catalog({ query: "social protection" })).indicators[0]?.id).toBe(code);
      const result = yield* service.query({ ...query, indicators: [code] });
      expect(result.measures[0]?.id).toBe(code);
      expect(observation(result, "BRA", 2024).values[code]).toBe(12.5);
    }).pipe(Effect.provide(f.layer));
  });

  it.effect("ranks direct indicator-name matches before incidental definition mentions", () => {
    const f = fixture();
    const incidental = metadata(
      "AA.INDIRECT",
      "Unrelated annual measure",
      "Economy & Growth",
      "An input used to compare GDP growth.",
    );
    const perCapita = metadata(
      "AA.PER.CAPITA",
      "GDP per capita growth (annual %)",
      "Economy & Growth",
      "Real income per resident.",
    );
    f.override(metadataPath, (url) =>
      Response.json(page([incidental, perCapita, indicators[0]], url, 10_000)),
    );
    return Effect.gen(function* () {
      const service = yield* WdiData.WdiData;
      const result = yield* service.catalog({ query: "gdp growth" });
      expect(result.indicators.map((item) => item.id)).toEqual([
        GDP,
        "AA.PER.CAPITA",
        "AA.INDIRECT",
      ]);
    }).pipe(Effect.provide(f.layer));
  });

  it.effect("searches every metadata page and bounds catalog output to forty indicators", () => {
    const f = fixture();
    const rows = Array.from({ length: 45 }, (_, index) =>
      metadata(
        `TEST.CODE.${String(index).padStart(2, "0")}`,
        `Fixture indicator ${index}`,
        "Fixture topic",
        "Fixture definition",
      ),
    );
    f.override(metadataPath, (url) => Response.json(page(rows, url, 20)));
    return Effect.gen(function* () {
      const service = yield* WdiData.WdiData;
      expect(yield* service.catalog()).toMatchObject({ indicatorCount: 45, page: 1, pages: 2 });
      expect((yield* service.catalog()).indicators).toHaveLength(40);
      expect((yield* service.catalog({ page: 2 })).indicators).toHaveLength(5);
      expect(yield* service.catalog({ query: "TEST.CODE.44" })).toMatchObject({
        indicatorCount: 1,
        indicators: [{ id: "TEST.CODE.44" }],
      });
    }).pipe(Effect.provide(f.layer));
  });

  it.effect(
    "joins independent indicator rows by country and year, keeps all history, and preserves source World aggregates",
    () => {
      const f = fixture();
      return Effect.gen(function* () {
        const service = yield* WdiData.WdiData;
        const result = yield* service.query({
          ...query,
          entities: ["BRA"],
          year: 2023,
          measure: GDP,
        });
        expect(result.entities.map((entity) => entity.id)).toEqual(["BRA", "OWID_WRL", "USA"]);
        expect(result.entities.find((entity) => entity.id === "OWID_WRL")).toEqual({
          id: "OWID_WRL",
          name: "World",
          iso3: null,
        });
        expect(observation(result, "USA", 2024).values).toEqual({
          [GDP]: 2.79318715363841,
          [POPULATION]: 340,
        });
        expect(observation(result, "BRA", 2024).values[POPULATION]).toBeNull();
        expect(observation(result, "USA", 2023).values[POPULATION]).toBeNull();
        expect(observation(result, "USA", 2025).values).toEqual({
          [GDP]: 2.16138195623856,
          [POPULATION]: null,
        });
        expect(observation(result, "OWID_WRL", 2024).values[POPULATION]).toBe(8_100);
        expect(result.defaultYear).toBe(2025);
        expect(result.observations.every((row) => row.status === "mixed")).toBe(true);
        expect(result.measures.map((measure) => measure.id)).toEqual([GDP, POPULATION]);
        expect(result.measures[0]).toMatchObject({
          label: "GDP growth (annual %)",
          unit: "%",
          derived: false,
        });
        expect(result.measures[1]?.unit).toBe("Unit");
      }).pipe(Effect.provide(f.layer));
    },
  );

  it.effect(
    "defaults to the latest non-null selected measure year, not another series or an all-null recent year",
    () => {
      const f = fixture();
      return Effect.gen(function* () {
        const service = yield* WdiData.WdiData;
        expect((yield* service.query({ ...query, measure: POPULATION })).defaultYear).toBe(2024);
        expect((yield* service.query({ ...query, measure: GDP })).defaultYear).toBe(2025);
      }).pipe(Effect.provide(f.layer));
    },
  );

  it.effect(
    "bounds concurrent indicator requests to three without dropping the fourth indicator",
    () => {
      const f = fixture();
      return Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let active = 0;
        let maximum = 0;
        let started = 0;
        const http = HttpClient.make((request) =>
          Effect.gen(function* () {
            const observationRequest = request.url.includes("/country/all/indicator/");
            if (observationRequest) {
              active++;
              started++;
              maximum = Math.max(maximum, active);
              if (started === 3) yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
            }
            const response = yield* f.http.execute(request);
            if (observationRequest) active--;
            return response;
          }),
        );
        const pending = yield* Effect.gen(function* () {
          const service = yield* WdiData.WdiData;
          return yield* service.query({ ...query, indicators: [GDP, POPULATION, ENERGY, FOREST] });
        }).pipe(
          Effect.provide(
            WdiData.layer.pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, http))),
          ),
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Deferred.await(entered);
        expect(started).toBe(3);
        yield* Deferred.succeed(release, undefined);
        expect((yield* Fiber.join(pending)).measures).toHaveLength(4);
        expect(started).toBe(4);
        expect(maximum).toBe(3);
      });
    },
  );

  it.effect("follows country and observation pagination before exposing results", () => {
    const f = fixture();
    f.override(countryPath, (url) => Response.json(page(countries, url, 2)));
    f.override(valuePath(GDP), (url) =>
      Response.json(page([...values[GDP]!, value(GDP, "BRA", "2025", 3.1)], url, 3, true)),
    );
    return Effect.gen(function* () {
      const service = yield* WdiData.WdiData;
      const result = yield* service.query(query);
      expect(observation(result, "USA", 2023).values[GDP]).toBe(2.93436322440155);
      expect(observation(result, "BRA", 2025).values[GDP]).toBe(3.1);
      expect(observation(result, "OWID_WRL", 2024).values[GDP]).toBe(2.8);
    }).pipe(Effect.provide(f.layer));
  });

  it.effect(
    "retains zero and negative source values and accepts identical duplicates without summing",
    () => {
      const f = fixture();
      const rows = [
        value(GDP, "BRA", "2023", -2),
        value(GDP, "BRA", "2023", -2),
        value(GDP, "BRA", "2024", 0),
      ];
      f.override(valuePath(GDP), (url) => Response.json(page(rows, url, 20_000, true)));
      return Effect.gen(function* () {
        const service = yield* WdiData.WdiData;
        const result = yield* service.query({ ...query, indicators: [GDP] });
        expect(result.observations).toHaveLength(2);
        expect(observation(result, "BRA", 2023).values[GDP]).toBe(-2);
        expect(observation(result, "BRA", 2024).values[GDP]).toBe(0);
        expect(result.measures[0]?.colorScale).toBe("diverging");
      }).pipe(Effect.provide(f.layer));
    },
  );

  it.effect(
    "caches validated datasets independently of answer id and focus, expires after six hours, and does not mask refresh failures",
    () => {
      const f = fixture();
      return Effect.gen(function* () {
        const service = yield* WdiData.WdiData;
        yield* service.query(query);
        f.override(metadataPath, () => new Response("Unavailable", { status: 503 }));
        const cached = yield* service.query({ ...query, id: "another-answer", entities: ["USA"] });
        expect(cached.id).toBe("another-answer");
        expect(observation(cached, "USA", 2024).values[GDP]).toBe(2.79318715363841);
        yield* TestClock.adjust("6 hours");
        expect(yield* Effect.flip(service.query(query))).toMatchObject({
          reason: "upstream",
          category: "http",
        });
        f.clear(metadataPath);
        const changed = values[GDP]!.map((row) =>
          row.countryiso3code === "USA" && row.date === "2024" ? { ...row, value: 4.5 } : row,
        );
        f.override(valuePath(GDP), (url) => Response.json(page(changed, url, 20_000, true)));
        expect(observation(yield* service.query(query), "USA", 2024).values[GDP]).toBe(4.5);
        f.override(valuePath(GDP), () => new Response("Unavailable", { status: 503 }));
        expect(observation(yield* service.query(query), "USA", 2024).values[GDP]).toBe(4.5);
      }).pipe(Effect.provide(f.layer));
    },
  );

  it.effect(
    "bounds successful query cache entries instead of retaining every requested year range",
    () => {
      const f = fixture();
      return Effect.gen(function* () {
        const service = yield* WdiData.WdiData;
        for (let fromYear = 1960; fromYear <= 1966; fromYear++)
          yield* service.query({ ...query, fromYear });
        const changed = values[GDP]!.map((row) =>
          row.countryiso3code === "USA" && row.date === "2024" ? { ...row, value: 4.5 } : row,
        );
        f.override(valuePath(GDP), (url) => Response.json(page(changed, url, 20_000, true)));
        expect(
          observation(yield* service.query({ ...query, fromYear: 1960 }), "USA", 2024).values[GDP],
        ).toBe(4.5);
      }).pipe(Effect.provide(f.layer));
    },
  );

  it.effect(
    "rejects conflicting duplicates and retries after failure rather than caching a partial dataset",
    () => {
      const f = fixture();
      const rows = [value(GDP, "BRA", "2024", 1), value(GDP, "BRA", "2024", 2)];
      f.override(valuePath(GDP), (url) => Response.json(page(rows, url, 20_000, true)));
      return Effect.gen(function* () {
        const service = yield* WdiData.WdiData;
        expect(yield* Effect.flip(service.query(query))).toMatchObject({
          reason: "upstream",
          category: "conflict",
        });
        f.clear(valuePath(GDP));
        expect(observation(yield* service.query(query), "USA", 2024).values[GDP]).toBe(
          2.79318715363841,
        );
      }).pipe(Effect.provide(f.layer));
    },
  );

  it.effect(
    "returns unavailable for all-null histories, not fabricated zeros or fake empty success",
    () => {
      const f = fixture();
      f.override(valuePath(GDP), (url) =>
        Response.json(page([value(GDP, "USA", "2024", null)], url, 20_000, true)),
      );
      return Effect.gen(function* () {
        const service = yield* WdiData.WdiData;
        expect(yield* Effect.flip(service.query({ ...query, indicators: [GDP] }))).toMatchObject({
          reason: "unavailable",
          category: "empty",
        });
        f.clear(valuePath(GDP));
        expect(
          observation(yield* service.query({ ...query, indicators: [GDP] }), "USA", 2024).values[
            GDP
          ],
        ).toBe(2.79318715363841);
      }).pipe(Effect.provide(f.layer));
    },
  );

  it.effect(
    "retains an all-null indicator alongside other observations and explains default-year fallback",
    () => {
      const f = fixture();
      f.override(valuePath(GDP), (url) =>
        Response.json(page([value(GDP, "USA", "2025", null)], url, 20_000, true)),
      );
      return Effect.gen(function* () {
        const service = yield* WdiData.WdiData;
        const result = yield* service.query(query);
        expect(result.defaultYear).toBe(2024);
        expect(result.observations.every((row) => row.values[GDP] === null)).toBe(true);
        expect((yield* service.query({ ...query, year: 2025 })).defaultYear).toBe(2024);
      }).pipe(Effect.provide(f.layer));
    },
  );

  it.effect.each([
    ["unknown country", [value(GDP, "ZZZ", "2024", 1)], "metadata"],
    ["wrong indicator", [value(POPULATION, "USA", "2024", 1)], "metadata"],
    ["out-of-range year", [value(GDP, "USA", "2022", 1)], "metadata"],
    ["changed unit", [{ ...value(GDP, "USA", "2024", 1), unit: "percent" }], "metadata"],
    ["numeric strings", [{ ...value(GDP, "USA", "2024", 1), value: "1" }], "payload"],
  ] as const)(
    "rejects %s without silently substituting or dropping data",
    ([_name, rows, category]) => {
      const f = fixture();
      f.override(valuePath(GDP), (url) => Response.json(page(rows, url, 20_000, true)));
      return Effect.gen(function* () {
        const service = yield* WdiData.WdiData;
        expect(yield* Effect.flip(service.query(query))).toMatchObject({
          reason: "upstream",
          category,
        });
      }).pipe(Effect.provide(f.layer));
    },
  );

  it.effect.each([
    [
      "repeated metadata pages",
      metadataPath,
      (url: URL) => {
        const repeated = new URL(url);
        repeated.searchParams.set("page", "1");
        return page(indicators, repeated, 2);
      },
      "pagination",
    ],
    [
      "incomplete country metadata",
      countryPath,
      () => [{ page: 1, pages: 1, per_page: "1000", total: 4 }, countries.slice(0, 2)],
      "pagination",
    ],
    [
      "wrong source metadata",
      metadataPath,
      (url: URL) =>
        page([{ ...indicators[0], source: { id: "75", value: "Another dataset" } }], url, 10_000),
      "metadata",
    ],
    [
      "duplicate metadata codes",
      metadataPath,
      (url: URL) => page([indicators[0], indicators[0]], url, 10_000),
      "conflict",
    ],
    [
      "missing World classification",
      countryPath,
      (url: URL) => page(countries.slice(0, 2), url, 1_000),
      "metadata",
    ],
    [
      "wrong observation source",
      valuePath(GDP),
      () => [
        {
          page: 1,
          pages: 1,
          per_page: 20_000,
          total: 1,
          sourceid: "75",
          lastupdated: "2026-10-08",
        },
        [value(GDP, "USA", "2024", 1)],
      ],
      "metadata",
    ],
  ] as const)("rejects %s before publishing results", ([_name, path, response, category]) => {
    const f = fixture();
    f.override(path, (url) => Response.json(response(url)));
    return Effect.gen(function* () {
      const service = yield* WdiData.WdiData;
      expect(yield* Effect.flip(service.query(query))).toMatchObject({
        reason: "upstream",
        category,
      });
      f.clear(path);
      expect(observation(yield* service.query(query), "USA", 2024).values[GDP]).toBe(
        2.79318715363841,
      );
    }).pipe(Effect.provide(f.layer));
  });

  it.effect("follows authoritative metadata pages when units arrive on the last page", () => {
    const f = fixture();
    const attributes = [
      ...seriesAttributes(GDP).filter((attribute) => attribute.id !== "Unitofmeasure"),
      { id: "Limitationsandexceptions", value: "Source caveat. ".repeat(500) },
      { id: "Unitofmeasure", value: "%" },
    ];
    f.override(seriesPath(GDP), (url) => Response.json(seriesPage(GDP, url, attributes, 3)));
    return Effect.gen(function* () {
      const service = yield* WdiData.WdiData;
      const result = yield* service.query(query);
      expect(result.measures[0]?.unit).toBe("%");
      expect(observation(result, "USA", 2024).values[GDP]).toBe(2.79318715363841);
    }).pipe(Effect.provide(f.layer));
  });

  it.effect("discloses absent authoritative units and licenses rather than inventing them", () => {
    const f = fixture();
    const attributes = seriesAttributes(GDP).filter(
      (attribute) => !["Unitofmeasure", "License_Type", "License_URL"].includes(attribute.id),
    );
    f.override(seriesPath(GDP), (url) => Response.json(seriesPage(GDP, url, attributes)));
    return Effect.gen(function* () {
      const service = yield* WdiData.WdiData;
      const result = yield* service.query(query);
      expect(result.measures[0]?.unit).not.toBe("%");
      expect(observation(result, "USA", 2024).values[GDP]).toBe(2.79318715363841);
    }).pipe(Effect.provide(f.layer));
  });

  it.effect("does not cache failed authoritative metadata or silently use source defaults", () => {
    const f = fixture();
    f.override(seriesPath(GDP), () => new Response("Unavailable", { status: 503 }));
    return Effect.gen(function* () {
      const service = yield* WdiData.WdiData;
      expect(yield* Effect.flip(service.query(query))).toMatchObject({
        reason: "upstream",
        category: "http",
      });
      f.clear(seriesPath(GDP));
      expect((yield* service.query(query)).measures[0]?.unit).toBe("%");
    }).pipe(Effect.provide(f.layer));
  });

  it.effect(
    "rejects a missing focused year even within bounds, on both fresh and cached datasets",
    () => {
      const f = fixture();
      return Effect.gen(function* () {
        const service = yield* WdiData.WdiData;
        expect(
          yield* Effect.flip(service.query({ ...query, fromYear: 1960, year: 1960 })),
        ).toMatchObject({ reason: "invalid_query", category: "range" });
        yield* service.query({ ...query, fromYear: 1960 });
        expect(
          yield* Effect.flip(service.query({ ...query, fromYear: 1960, year: 1960 })),
        ).toMatchObject({ reason: "invalid_query", category: "range" });
        expect((yield* service.query({ ...query, fromYear: 1960, year: 2025 })).defaultYear).toBe(
          2025,
        );
      }).pipe(Effect.provide(f.layer));
    },
  );

  it.effect.each([
    [
      "duplicate authoritative attributes",
      [...seriesAttributes(GDP), { id: "Unitofmeasure", value: "%" }],
      "conflict",
    ],
    [
      "non-annual periodicity",
      seriesAttributes(GDP).map((attribute) =>
        attribute.id === "Periodicity" ? { ...attribute, value: "Monthly" } : attribute,
      ),
      "metadata",
    ],
  ] as const)("rejects %s", ([_name, attributes, category]) => {
    const f = fixture();
    f.override(seriesPath(GDP), (url) => Response.json(seriesPage(GDP, url, [...attributes])));
    return Effect.gen(function* () {
      const service = yield* WdiData.WdiData;
      expect(yield* Effect.flip(service.query(query))).toMatchObject({
        reason: "upstream",
        category,
      });
    }).pipe(Effect.provide(f.layer));
  });

  it.effect.each([
    { ...query, indicators: [] },
    { ...query, indicators: [GDP, GDP] },
    { ...query, indicators: [GDP, POPULATION, ENERGY, FOREST, "FIFTH.CODE"] },
    { ...query, indicators: ["MISSING.CODE"] },
    { ...query, measure: ENERGY },
    { ...query, fromYear: 1959 },
    { ...query, toYear: 2026 },
    { ...query, fromYear: 2025, toYear: 2023 },
    { ...query, year: 2022 },
    { ...query, entities: ["BRA", "BRA"] },
    { ...query, entities: ["EAS"] },
    { ...query, entities: ["ZZZ"] },
  ])("rejects invalid query %j", (input) => {
    const f = fixture();
    return Effect.gen(function* () {
      const service = yield* WdiData.WdiData;
      expect((yield* Effect.flip(service.query(input))).reason).toBe("invalid_query");
    }).pipe(Effect.provide(f.layer));
  });

  it.effect.each([{ page: 0 }, { page: 2 }, { query: "x".repeat(201) }])(
    "rejects invalid catalog selection %j",
    (input) => {
      const f = fixture();
      return Effect.gen(function* () {
        const service = yield* WdiData.WdiData;
        expect((yield* Effect.flip(service.catalog(input))).reason).toBe("invalid_query");
      }).pipe(Effect.provide(f.layer));
    },
  );

  it.effect.each([
    ["HTTP failure", () => new Response("Unavailable", { status: 503 }), "http"],
    ["malformed JSON", () => new Response("not JSON"), "payload"],
    [
      "non-finite source value",
      () =>
        new Response(
          '[{"page":1,"pages":1,"per_page":20000,"total":1,"sourceid":"2","lastupdated":"2026-10-08"},[{"indicator":{"id":"NY.GDP.MKTP.KD.ZG"},"countryiso3code":"USA","date":"2024","value":1e999,"unit":""}]]',
        ),
      "payload",
    ],
    [
      "declared oversized response",
      () => new Response("[]", { headers: { "content-length": String(12 * 1024 * 1024 + 1) } }),
      "limit",
    ],
    ["streamed oversized response", () => new Response(" ".repeat(12 * 1024 * 1024 + 1)), "limit"],
  ] as const)("bounds %s with a typed failure", ([_name, response, category]) => {
    const f = fixture();
    f.override(valuePath(GDP), response);
    return Effect.gen(function* () {
      const service = yield* WdiData.WdiData;
      expect(yield* Effect.flip(service.query(query))).toMatchObject({
        reason: "upstream",
        category,
      });
    }).pipe(Effect.provide(f.layer));
  });

  it.effect("times out a stalled source with actionable typed failure", () => {
    const http = HttpClient.make(() => Effect.never);
    return Effect.gen(function* () {
      const service = yield* WdiData.WdiData;
      const pending = yield* Effect.flip(service.catalog()).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* TestClock.adjust("20 seconds");
      const error = yield* Fiber.join(pending);
      expect(error).toMatchObject({ reason: "upstream", category: "network" });
    }).pipe(
      Effect.provide(WdiData.layer.pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, http)))),
    );
  });
});
