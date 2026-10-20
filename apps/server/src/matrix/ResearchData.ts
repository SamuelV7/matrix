import {
  MatrixResearchDataset,
  MatrixResearchMeasure,
  MatrixResearchQuery,
  type MatrixResearchObservation,
  type MatrixResearchSource,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/http";
import * as WdiData from "./WdiData.ts";

export class ResearchDataFailure extends Schema.TaggedError<ResearchDataFailure>()(
  "ResearchDataFailure",
  {
    reason: Schema.Literals(["invalid_query", "unavailable", "upstream"]),
    source: Schema.Literals(["query", "fao", "worldbank", "dataset"]),
    category: Schema.Literals([
      "unsupported_crop",
      "range",
      "selection",
      "network",
      "http",
      "payload",
      "metadata",
      "conflict",
      "pagination",
      "limit",
      "empty",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "invalid_query":
        return "Choose a supported crop or actual indicator codes from the research catalog; check the measure, entity and year range.";
      case "unavailable":
        return "No matching historical observations are available for this selection. Choose another entity, indicator or year range.";
      case "upstream": {
        if (this.category === "metadata")
          return `The ${this.source} metadata, version or units changed. The source adapter needs updating; no substitute data was used.`;
        if (this.category === "network" || this.category === "http")
          return `The ${this.source} source did not respond successfully within the request limit. Check source availability and try again later.`;
        return `The ${this.source} source returned incomplete or invalid data (${this.category}). No partial dataset was used; try again after the source is corrected.`;
      }
    }
  }
}

const Text = Schema.String.check(Schema.isMaxLength(4_000));
export const ResearchCatalog = Schema.Struct({
  ...WdiData.WdiCatalog.fields,
  crops: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      description: Text,
      fromYear: Schema.Int,
      toYear: Schema.Int,
    }),
  ),
  measures: Schema.Array(MatrixResearchMeasure),
  sources: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      url: Schema.String,
      description: Text,
    }),
  ),
  limitations: Schema.Array(Text),
});
export type ResearchCatalog = typeof ResearchCatalog.Type;

export class ResearchData extends Context.Service<
  ResearchData,
  {
    readonly catalog: (input?: {
      readonly query?: string | undefined;
      readonly page?: number | undefined;
    }) => Effect.Effect<ResearchCatalog, ResearchDataFailure>;
    readonly query: (
      input: MatrixResearchQuery,
    ) => Effect.Effect<MatrixResearchDataset, ResearchDataFailure>;
  }
>()("t3/matrix/ResearchData") {}

const CROPS = [
  {
    id: "corn",
    name: "Corn (maize)",
    item: "Maize",
    description: "Maize harvested for dry grain; excludes green maize, silage, hay and grazing.",
    production: 1198621,
    harvestedArea: 1198618,
    yield: 1198624,
  },
  {
    id: "wheat",
    name: "Wheat",
    item: "Wheat",
    description: "Wheat harvested for dry grain, from the same FAO crop production dataset.",
    production: 1199532,
    harvestedArea: 1199529,
    yield: 1199535,
  },
] as const;
const FROM_YEAR = 1961;
const TO_YEAR = 2024;
const CACHE_MS = 6 * 60 * 60 * 1_000;
const MAX_BYTES = 4 * 1_024 * 1_024;
const MAX_ROWS = 30_000;
const WB_URL =
  "https://api.worldbank.org/v2/country/all/indicator/EN.CLC.SPEI.XD?format=json&date=2000:2024&per_page=20000";
const FAO_URL = "https://www.fao.org/faostat/en/#data/QCL";
const LICENSE_WARNING =
  "OWID's FAO origin metadata identifies CC BY-NC-SA 3.0 IGO, while the current FAO catalog/database terms identify CC BY 4.0 with third-party exceptions. This discrepancy is preserved; check applicable source terms before reuse. Terms: https://www.fao.org/contact-us/terms/db-terms-of-use/en/ ; catalog: https://data.fao.org/catalog/dataset/d24a448b-3b62-4c09-8c1d-4a39bb599876";
const LIMITATIONS = [
  "Annual calendar-year FAO crop history, 1961–2024; individual country coverage varies. Current conditions and forecasts are not provided.",
  "Harvested area is the source series, not production divided by yield. It excludes failed/unharvested area and can count successive harvests on the same parcel more than once; it is not unique physical cropland footprint.",
  "The OWID payload omits original FAO observation flags. Values may include official statistics, estimates and imputations; observation status is mixed, not reported-only.",
  "Only three-letter country codes and the source World aggregate are included. Other regional aggregates and non-ISO-coded historical entities are excluded. World is the source series, never a sum of countries.",
  "SPEI is a dimensionless national historical 12-month annual drought/climate index; negative means drier. It is not crop-area-weighted exposure, current crop conditions, or proof of causality. Coverage is 2000–2024 with missing values, including 2024. Rows without a source ISO3 code cannot be joined and are excluded, not merged. No World SPEI is available or computed.",
  "Growth is percent change from the preceding exact calendar year; a missing or zero predecessor yields null, not a multi-year change.",
  LICENSE_WARNING,
];
const MEASURES: ReadonlyArray<MatrixResearchMeasure> = [
  {
    id: "production",
    label: "Production",
    unit: "tonnes",
    description: "FAO annual harvested crop production.",
    sourceIds: ["fao-production"],
    derived: false,
    colorScale: "sequential",
  },
  {
    id: "harvestedArea",
    label: "Harvested area",
    unit: "hectares",
    description: "FAO area harvested; successive harvests may count the same land more than once.",
    sourceIds: ["fao-harvestedArea"],
    derived: false,
    colorScale: "sequential",
  },
  {
    id: "yield",
    label: "Yield",
    unit: "tonnes per hectare",
    description:
      "FAO production per harvested area; source values preserved without recomputation.",
    sourceIds: ["fao-yield"],
    derived: false,
    colorScale: "sequential",
  },
  {
    id: "productionGrowth",
    label: "Production growth",
    unit: "%",
    description:
      "Percent change from the preceding exact calendar year; null for missing or zero predecessor.",
    sourceIds: ["fao-production"],
    derived: true,
    colorScale: "diverging",
  },
  {
    id: "yieldGrowth",
    label: "Yield growth",
    unit: "%",
    description:
      "Percent change in yield from the preceding exact calendar year; null for missing or zero predecessor.",
    sourceIds: ["fao-yield"],
    derived: true,
    colorScale: "diverging",
  },
  {
    id: "droughtIndex",
    label: "Drought (SPEI)",
    unit: "SPEI",
    description:
      "Dimensionless national 12-month annual SPEI; negative is drier, positive wetter. Not crop-specific exposure.",
    sourceIds: ["worldbank-spei"],
    derived: false,
    colorScale: "diverging",
  },
];
const CATALOG = {
  crops: CROPS.map(({ id, name, description }) => ({
    id,
    name,
    description,
    fromYear: FROM_YEAR,
    toYear: TO_YEAR,
  })),
  measures: MEASURES,
  sources: [
    {
      id: "fao",
      name: "FAO (2025), processed by Our World in Data",
      url: FAO_URL,
      description:
        "Production: Crops and livestock products, OWID dataset 7391/version 2026-02-25; per-indicator metadata and original license retained. " +
        LICENSE_WARNING,
    },
    {
      id: "worldbank-spei",
      name: "World Bank historical SPEI",
      url: "https://data.worldbank.org/indicator/EN.CLC.SPEI.XD",
      description:
        "Source 75, 12-month-scale SPEIbase annual national index, CC BY 4.0. No World aggregate; country-year availability varies.",
    },
    {
      id: "worldbank-wdi",
      name: "World Bank World Development Indicators",
      url: "https://data.worldbank.org/",
      description:
        "Search the actual source-2 indicator catalog across economics, population, health, energy, environment and more. Coverage, definitions, units and original producers vary by indicator; observations are historical, may be revised and are not live conditions or causal evidence.",
    },
  ],
  limitations: [
    ...LIMITATIONS,
    "World Development Indicators discovery is dynamic and searchable. Each code keeps its source definition, producer, unit disclosure and actual country/year coverage. Do not combine unlike units or interpret association as causation; missing observations remain unavailable.",
  ],
};

const BoundedName = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));
const Year = Schema.Int.check(Schema.isBetween({ minimum: FROM_YEAR, maximum: TO_YEAR }));
const NumericId = Schema.Int.check(Schema.isGreaterThan(0));
const Metadata = Schema.Struct({
  id: NumericId,
  name: BoundedName,
  unit: BoundedName,
  timespan: Schema.Literal("1961-2024"),
  datasetId: Schema.Literal(7391),
  datasetVersion: Schema.Literal("2026-02-25"),
  dimensions: Schema.Struct({
    entities: Schema.Struct({
      values: Schema.Array(
        Schema.Struct({
          id: NumericId,
          name: BoundedName,
          code: Schema.NullOr(Schema.String.check(Schema.isMaxLength(80))),
        }),
      ).check(Schema.isMinLength(1), Schema.isMaxLength(500)),
    }),
  }),
  origins: Schema.Array(
    Schema.Struct({
      producer: BoundedName,
      title: BoundedName,
      datePublished: Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/)),
      license: Schema.Struct({ name: BoundedName }),
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(4)),
});
const IndicatorData = Schema.Struct({
  values: Schema.Array(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_ROWS),
  ),
  years: Schema.Array(Year).check(Schema.isMaxLength(MAX_ROWS)),
  entities: Schema.Array(NumericId).check(Schema.isMaxLength(MAX_ROWS)),
});
const Pagination = Schema.Struct({
  page: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 8 })),
  pages: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 8 })),
  per_page: Schema.Union([Schema.Int, Schema.String]),
  total: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20_000 })),
  sourceid: Schema.Literal("75"),
  lastupdated: Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/)),
});
const DroughtRow = Schema.Struct({
  indicator: Schema.Struct({ id: Schema.Literal("EN.CLC.SPEI.XD") }),
  countryiso3code: Schema.String.check(Schema.isPattern(/^(?:[A-Z]{3})?$/)),
  date: Schema.String.check(Schema.isPattern(/^(?:200\d|201\d|202[0-4])$/)),
  value: Schema.NullOr(Schema.Finite),
  unit: Schema.Literal(""),
});
const DroughtPage = Schema.Tuple([
  Pagination,
  Schema.Array(DroughtRow).check(Schema.isMaxLength(20_000)),
]);
const isResearchDataFailure = Schema.is(ResearchDataFailure);
const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeMetadata = Schema.decodeUnknownEffect(Metadata);
const decodeIndicatorData = Schema.decodeUnknownEffect(IndicatorData);
const decodeDroughtPage = Schema.decodeUnknownEffect(DroughtPage);
const decodeQuery = Schema.decodeEffect(MatrixResearchQuery);
const decodeDataset = Schema.decodeEffect(MatrixResearchDataset);
type Entity = MatrixResearchDataset["entities"][number];
type CropRow = {
  entityId: string;
  year: number;
  values: Record<string, number | null>;
  status: "mixed";
};
type CropData = {
  entities: ReadonlyArray<Entity>;
  rows: ReadonlyMap<string, CropRow>;
  sources: ReadonlyArray<MatrixResearchSource>;
  retrievedAt: number;
};
type DroughtData = {
  values: ReadonlyMap<string, number | null>;
  updatedAt: string;
  retrievedAt: number;
};
const key = (entity: string, year: number) => `${entity}:${year}`;
const growth = (value: number | null | undefined, previous: number | null | undefined) => {
  if (value == null || previous == null || previous === 0) return null;
  const result = ((value - previous) / previous) * 100;
  return Number.isFinite(result) ? result : null;
};

const make = Effect.gen(function* () {
  const http = yield* HttpClient.HttpClient;
  const wdi = yield* WdiData.WdiData;
  const network = yield* Semaphore.make(3);
  const loads = yield* Semaphore.make(1);
  const crops = new Map<string, CropData>();
  let drought: DroughtData | undefined;

  const fetchJson = Effect.fn("ResearchData.fetchJson")(
    function* (url: string, source: "fao" | "worldbank") {
      const response = yield* http
        .get(url)
        .pipe(
          Effect.mapError(
            (cause) =>
              new ResearchDataFailure({ reason: "upstream", source, category: "network", cause }),
          ),
        );
      if (response.status !== 200)
        return yield* new ResearchDataFailure({ reason: "upstream", source, category: "http" });
      const declared = response.headers["content-length"];
      if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > MAX_BYTES)) {
        return yield* new ResearchDataFailure({ reason: "upstream", source, category: "limit" });
      }
      let size = 0;
      const chunks: string[] = [];
      const decoder = new TextDecoder("utf-8", { fatal: true });
      yield* response.stream.pipe(
        Stream.runForEach((chunk) => {
          size += chunk.byteLength;
          if (size > MAX_BYTES)
            return Effect.fail(
              new ResearchDataFailure({ reason: "upstream", source, category: "limit" }),
            );
          return Effect.try({
            try: () => {
              chunks.push(decoder.decode(chunk, { stream: true }));
            },
            catch: (cause) =>
              new ResearchDataFailure({ reason: "upstream", source, category: "payload", cause }),
          });
        }),
        Effect.mapError((cause) =>
          isResearchDataFailure(cause)
            ? cause
            : new ResearchDataFailure({ reason: "upstream", source, category: "network", cause }),
        ),
      );
      return yield* Effect.try({
        try: () => chunks.join("") + decoder.decode(),
        catch: (cause) =>
          new ResearchDataFailure({ reason: "upstream", source, category: "payload", cause }),
      }).pipe(
        Effect.flatMap(decodeJson),
        Effect.mapError((cause) =>
          isResearchDataFailure(cause)
            ? cause
            : new ResearchDataFailure({ reason: "upstream", source, category: "payload", cause }),
        ),
      );
    },
    Effect.timeout("20 seconds"),
    Effect.mapError((cause) =>
      isResearchDataFailure(cause)
        ? cause
        : new ResearchDataFailure({
            reason: "upstream",
            source: "dataset",
            category: "network",
            cause,
          }),
    ),
    network.withPermit,
  );

  const loadCrop = Effect.fn("ResearchData.loadCrop")(function* (crop: (typeof CROPS)[number]) {
    const now = yield* Clock.currentTimeMillis;
    const cached = crops.get(crop.id);
    if (cached && now - cached.retrievedAt < CACHE_MS) return cached;
    const entities = new Map<string, Entity>();
    const entityCodes = new Map<number, string | null>();
    const codeIds = new Map<string, number>();
    const rows = new Map<string, CropRow>();
    const sources: MatrixResearchSource[] = [];
    for (const metric of ["production", "harvestedArea", "yield"] as const) {
      const id = crop[metric];
      const base = `https://api.ourworldindata.org/v1/indicators/${id}`;
      const [rawMetadata, rawData] = yield* Effect.all(
        [fetchJson(`${base}.metadata.json`, "fao"), fetchJson(`${base}.data.json`, "fao")],
        { concurrency: 2 },
      );
      const metadata = yield* decodeMetadata(rawMetadata).pipe(
        Effect.mapError(
          (cause) =>
            new ResearchDataFailure({
              reason: "upstream",
              source: "fao",
              category: "metadata",
              cause,
            }),
        ),
      );
      const data = yield* decodeIndicatorData(rawData).pipe(
        Effect.mapError(
          (cause) =>
            new ResearchDataFailure({
              reason: "upstream",
              source: "fao",
              category: "payload",
              cause,
            }),
        ),
      );
      const unit =
        metric === "production"
          ? "tonnes"
          : metric === "harvestedArea"
            ? "hectares"
            : "tonnes per hectare";
      if (
        metadata.id !== id ||
        !metadata.name.startsWith(`${crop.item} |`) ||
        metadata.unit !== unit ||
        !metadata.origins.every(
          (origin) =>
            origin.producer === "Food and Agriculture Organization of the United Nations" &&
            origin.title === "Production: Crops and livestock products",
        )
      ) {
        return yield* new ResearchDataFailure({
          reason: "upstream",
          source: "fao",
          category: "metadata",
        });
      }
      if (data.values.length !== data.years.length || data.values.length !== data.entities.length)
        return yield* new ResearchDataFailure({
          reason: "upstream",
          source: "fao",
          category: "payload",
        });
      const numericEntities = new Map<number, string | null>();
      for (const entity of metadata.dimensions.entities.values) {
        if (numericEntities.has(entity.id))
          return yield* new ResearchDataFailure({
            reason: "upstream",
            source: "fao",
            category: "conflict",
          });
        const code = entity.code;
        if (entityCodes.has(entity.id) && entityCodes.get(entity.id) !== code)
          return yield* new ResearchDataFailure({
            reason: "upstream",
            source: "fao",
            category: "conflict",
          });
        entityCodes.set(entity.id, code);
        const supported = code !== null && (/^[A-Z]{3}$/.test(code) || code === "OWID_WRL");
        numericEntities.set(entity.id, supported ? code : null);
        if (!supported || code === null) continue;
        if (codeIds.has(code) && codeIds.get(code) !== entity.id)
          return yield* new ResearchDataFailure({
            reason: "upstream",
            source: "fao",
            category: "conflict",
          });
        codeIds.set(code, entity.id);
        const existing = entities.get(code);
        if (existing && existing.name !== entity.name)
          return yield* new ResearchDataFailure({
            reason: "upstream",
            source: "fao",
            category: "conflict",
          });
        entities.set(code, {
          id: code,
          name: entity.name,
          iso3: code === "OWID_WRL" ? null : code,
        });
      }
      const seen = new Map<string, number>();
      for (let index = 0; index < data.values.length; index++) {
        const numericId = data.entities[index]!;
        if (!numericEntities.has(numericId))
          return yield* new ResearchDataFailure({
            reason: "upstream",
            source: "fao",
            category: "metadata",
          });
        const year = data.years[index]!;
        const value = data.values[index]!;
        const rawKey = key(String(numericId), year);
        if (seen.has(rawKey) && seen.get(rawKey) !== value)
          return yield* new ResearchDataFailure({
            reason: "upstream",
            source: "fao",
            category: "conflict",
          });
        seen.set(rawKey, value);
        const entityId = numericEntities.get(numericId);
        if (!entityId) continue;
        const rowKey = key(entityId, year);
        const row = rows.get(rowKey) ?? {
          entityId,
          year,
          values: { production: null, harvestedArea: null, yield: null },
          status: "mixed" as const,
        };
        row.values[metric] = value;
        rows.set(rowKey, row);
      }
      sources.push({
        id: `fao-${metric}`,
        name: `FAO ${metric}, via Our World in Data`,
        url: `${base}.metadata.json`,
        downloadUrl: `${base}.data.json`,
        retrievedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
        updatedAt: metadata.origins[0]!.datePublished,
        license: metadata.origins[0]!.license.name,
        description: `FAO Production: Crops and livestock products (2025), processed by OWID; indicator ${id}, dataset 7391/version 2026-02-25. ${crop.description} Original FAO observation flags are not exposed; values may include estimates and imputations. ${LICENSE_WARNING}`,
      });
    }
    if (rows.size === 0)
      return yield* new ResearchDataFailure({
        reason: "upstream",
        source: "fao",
        category: "empty",
      });
    if (rows.size > MAX_ROWS || entities.size > 350)
      return yield* new ResearchDataFailure({
        reason: "upstream",
        source: "fao",
        category: "limit",
      });
    const result: CropData = {
      entities: [...entities.values()].sort((a, b) => a.id.localeCompare(b.id)),
      rows,
      sources,
      retrievedAt: now,
    };
    crops.set(crop.id, result);
    return result;
  });

  const loadDrought = Effect.fn("ResearchData.loadDrought")(function* () {
    const now = yield* Clock.currentTimeMillis;
    if (drought && now - drought.retrievedAt < CACHE_MS) return drought;
    const values = new Map<string, number | null>();
    let expected: typeof Pagination.Type | undefined;
    let count = 0;
    let finiteCount = 0;
    for (let page = 1; page <= (expected?.pages ?? 1); page++) {
      const raw = yield* fetchJson(`${WB_URL}&page=${page}`, "worldbank");
      const [pagination, rows] = yield* decodeDroughtPage(raw).pipe(
        Effect.mapError(
          (cause) =>
            new ResearchDataFailure({
              reason: "upstream",
              source: "worldbank",
              category: "payload",
              cause,
            }),
        ),
      );
      const perPage = Number(pagination.per_page);
      if (
        pagination.page !== page ||
        !Number.isInteger(perPage) ||
        perPage <= 0 ||
        perPage > 20_000 ||
        Math.ceil(pagination.total / perPage) !== pagination.pages ||
        (expected &&
          (pagination.pages !== expected.pages ||
            pagination.total !== expected.total ||
            pagination.per_page !== expected.per_page ||
            pagination.lastupdated !== expected.lastupdated))
      ) {
        return yield* new ResearchDataFailure({
          reason: "upstream",
          source: "worldbank",
          category: "pagination",
        });
      }
      expected = pagination;
      const expectedRows =
        page === pagination.pages ? pagination.total - perPage * (page - 1) : perPage;
      if (rows.length !== expectedRows)
        return yield* new ResearchDataFailure({
          reason: "upstream",
          source: "worldbank",
          category: "pagination",
        });
      count += rows.length;
      for (const row of rows) {
        // The API leaves unrelated territories and aggregates uncoded; an empty code is not one entity.
        if (!row.countryiso3code) continue;
        const rowKey = key(row.countryiso3code, Number(row.date));
        if (values.has(rowKey)) {
          if (values.get(rowKey) !== row.value)
            return yield* new ResearchDataFailure({
              reason: "upstream",
              source: "worldbank",
              category: "conflict",
            });
          continue;
        }
        values.set(rowKey, row.value);
        if (row.value !== null) finiteCount++;
      }
    }
    if (!expected || count !== expected.total || finiteCount === 0)
      return yield* new ResearchDataFailure({
        reason: "upstream",
        source: "worldbank",
        category: "empty",
      });
    drought = { values, updatedAt: expected.lastupdated, retrievedAt: now };
    return drought;
  });

  const query = Effect.fn("ResearchData.query")(
    function* (input: MatrixResearchQuery) {
      const parsed = yield* decodeQuery(input).pipe(
        Effect.mapError(
          (cause) =>
            new ResearchDataFailure({
              reason: "invalid_query",
              source: "query",
              category: "selection",
              cause,
            }),
        ),
      );
      if (parsed.kind === "indicators")
        return yield* wdi.query(parsed).pipe(
          Effect.mapError(
            (cause) =>
              new ResearchDataFailure({
                reason: cause.reason,
                source: "worldbank",
                category: cause.category,
                cause,
              }),
          ),
        );
      const crop = CROPS.find((candidate) => candidate.id === parsed.crop);
      if (!crop)
        return yield* new ResearchDataFailure({
          reason: "invalid_query",
          source: "query",
          category: "unsupported_crop",
        });
      const fromYear = parsed.fromYear ?? FROM_YEAR;
      const toYear = parsed.toYear ?? TO_YEAR;
      if (
        fromYear < FROM_YEAR ||
        toYear > TO_YEAR ||
        fromYear > toYear ||
        (parsed.year !== undefined && (parsed.year < fromYear || parsed.year > toYear))
      )
        return yield* new ResearchDataFailure({
          reason: "invalid_query",
          source: "query",
          category: "range",
        });
      if (parsed.entities && new Set(parsed.entities).size !== parsed.entities.length)
        return yield* new ResearchDataFailure({
          reason: "invalid_query",
          source: "query",
          category: "selection",
        });
      const measures = MEASURES.filter(
        (measure) => measure.id !== "droughtIndex" || parsed.includeDrought,
      );
      if (
        parsed.measure !== undefined &&
        !measures.some((measure) => measure.id === parsed.measure)
      )
        return yield* new ResearchDataFailure({
          reason: "invalid_query",
          source: "query",
          category: "selection",
        });
      const base = yield* loads.withPermit(loadCrop(crop));
      const spei = parsed.includeDrought ? yield* loads.withPermit(loadDrought()) : undefined;
      const observations: MatrixResearchObservation[] = [];
      const present = new Set<string>();
      let latestProduction = 0;
      let latestPair = 0;
      for (const row of base.rows.values()) {
        if (row.year < fromYear || row.year > toYear) continue;
        const previous = base.rows.get(key(row.entityId, row.year - 1));
        const droughtValue =
          row.entityId === "OWID_WRL"
            ? null
            : (spei?.values.get(key(row.entityId, row.year)) ?? null);
        observations.push({
          ...row,
          values: {
            ...row.values,
            productionGrowth: growth(row.values.production, previous?.values.production),
            yieldGrowth: growth(row.values.yield, previous?.values.yield),
            ...(spei ? { droughtIndex: droughtValue } : {}),
          },
        });
        present.add(row.entityId);
        if (row.values.production != null) {
          latestProduction = Math.max(latestProduction, row.year);
          if (row.entityId !== "OWID_WRL" && droughtValue !== null)
            latestPair = Math.max(latestPair, row.year);
        }
      }
      const defaultYear = spei && latestPair ? latestPair : latestProduction;
      if (!defaultYear)
        return yield* new ResearchDataFailure({
          reason: "unavailable",
          source: "dataset",
          category: "empty",
        });
      const entities = base.entities.filter((entity) => present.has(entity.id));
      if (parsed.entities?.some((entity) => !present.has(entity)))
        return yield* new ResearchDataFailure({
          reason: "invalid_query",
          source: "query",
          category: "selection",
        });
      observations.sort((a, b) => a.entityId.localeCompare(b.entityId) || a.year - b.year);
      const sources = [...base.sources];
      if (spei)
        sources.push({
          id: "worldbank-spei",
          name: "World Bank national historical SPEI",
          url: "https://data.worldbank.org/indicator/EN.CLC.SPEI.XD",
          downloadUrl: WB_URL,
          retrievedAt: DateTime.formatIso(DateTime.makeUnsafe(spei.retrievedAt)),
          updatedAt: spei.updatedAt,
          license: "CC BY 4.0",
          description:
            "World Bank source 75, EN.CLC.SPEI.XD, derived from 12-month-scale SPEIbase. Dimensionless annual national index; negative is drier. Not crop-area exposure, current conditions or causal evidence. No World SPEI is provided.",
        });
      return yield* decodeDataset({
        id: parsed.id,
        title: `${crop.name}: production, harvested area and yield`,
        frequency: "annual",
        geography: "country",
        timeBasis:
          "FAO annual calendar-year crop history; dry-grain cereals. Growth uses the previous exact calendar year, including a predecessor outside the requested range. Drought, when requested, is historical national 12-month annual SPEI.",
        defaultYear,
        entities,
        measures,
        observations,
        sources,
        warnings: spei
          ? [
              ...LIMITATIONS,
              ...(latestPair
                ? []
                : [
                    "No paired country production and drought observations are available in this year range; the default year is the latest production year.",
                  ]),
            ]
          : LIMITATIONS.filter((warning) => !warning.startsWith("SPEI")),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ResearchDataFailure({
              reason: "upstream",
              source: "dataset",
              category: "payload",
              cause,
            }),
        ),
      );
    },
    Effect.timeout("90 seconds"),
    Effect.mapError((cause) =>
      isResearchDataFailure(cause)
        ? cause
        : new ResearchDataFailure({
            reason: "upstream",
            source: "dataset",
            category: "network",
            cause,
          }),
    ),
  );
  const catalog = Effect.fn("ResearchData.catalog")(function* (input?: {
    readonly query?: string | undefined;
    readonly page?: number | undefined;
  }) {
    const indicators = yield* wdi.catalog(input).pipe(
      Effect.mapError(
        (cause) =>
          new ResearchDataFailure({
            reason: cause.reason,
            source: "worldbank",
            category: cause.category,
            cause,
          }),
      ),
    );
    return { ...CATALOG, ...indicators };
  });
  return ResearchData.of({ catalog, query });
});

export const layer = Layer.effect(ResearchData, make);
