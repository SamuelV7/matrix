import {
  MatrixResearchDataset,
  MatrixResearchQuery,
  type MatrixResearchMeasure,
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

export class WdiDataFailure extends Schema.TaggedError<WdiDataFailure>()("WdiDataFailure", {
  reason: Schema.Literals(["invalid_query", "unavailable", "upstream"]),
  source: Schema.Literals(["query", "worldbank", "dataset"]),
  category: Schema.Literals([
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
}) {
  override get message(): string {
    if (this.reason === "invalid_query") {
      return this.category === "range"
        ? "Choose an annual World Development Indicators range within 1960–2025 and a selected year inside that range."
        : "Search the World Development Indicators catalog and choose one to four distinct indicator codes, an included measure, and country codes available in the result.";
    }
    if (this.reason === "unavailable")
      return "The selected World Development Indicators have no non-null observations in this range. Choose different indicators or years; no substitute values were used.";
    if (this.category === "network" || this.category === "http")
      return "The World Bank API did not respond successfully within the request limit. Check source availability and try again later.";
    if (this.category === "metadata")
      return "World Bank source 2 metadata changed or could not be validated. The source adapter needs updating; no substitute source was used.";
    return `The World Bank API returned incomplete or invalid data (${this.category}). No partial dataset was used; try again after the source is corrected.`;
  }
}

const Code = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(80),
  Schema.isPattern(/^[a-zA-Z0-9_.-]+$/),
);
const Name = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));
const Unit = Schema.String.check(Schema.isMaxLength(200));
const Description = Schema.String.check(Schema.isMaxLength(4_000));
const CatalogIndicator = Schema.Struct({
  id: Code,
  name: Name,
  unit: Unit,
  description: Description,
  topics: Schema.Array(Name).check(Schema.isMaxLength(32)),
});
export const WdiCatalog = Schema.Struct({
  indicators: Schema.Array(CatalogIndicator).check(Schema.isMaxLength(40)),
  indicatorCount: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 20_000 })),
  page: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  pages: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
});
export type WdiCatalog = typeof WdiCatalog.Type;

export class WdiData extends Context.Service<
  WdiData,
  {
    readonly catalog: (input?: {
      readonly query?: string | undefined;
      readonly page?: number | undefined;
    }) => Effect.Effect<WdiCatalog, WdiDataFailure>;
    readonly query: (
      input: Extract<MatrixResearchQuery, { kind: "indicators" }>,
    ) => Effect.Effect<MatrixResearchDataset, WdiDataFailure>;
  }
>()("t3/matrix/WdiData") {}

const BASE = "https://api.worldbank.org/v2";
const METADATA_URL = `${BASE}/source/2/indicator?format=json&per_page=10000`;
const COUNTRY_URL = `${BASE}/country?format=json&per_page=1000`;
const TERMS_URL = "https://www.worldbank.org/ext/en/legal/terms-conditions/datasets";
const CACHE_MS = 6 * 60 * 60 * 1_000;
const MAX_BYTES = 12 * 1_024 * 1_024;
const MAX_DATASETS = 6;
const FROM_YEAR = 1960;
const TO_YEAR = 2025;
const CatalogInput = Schema.Struct({
  query: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
  page: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 }))),
});
const Pagination = Schema.Struct({
  page: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 8 })),
  pages: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 8 })),
  per_page: Schema.Union([Schema.Int, Schema.String.check(Schema.isPattern(/^\d{1,6}$/))]),
  total: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 40_000 })),
  sourceid: Schema.optional(Schema.String.check(Schema.isMaxLength(20))),
  lastupdated: Schema.optional(Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/))),
});
const Page = Schema.Tuple([
  Pagination,
  Schema.NullOr(Schema.Array(Schema.Unknown).check(Schema.isMaxLength(20_000))),
]);
const MetadataRows = Schema.Array(
  Schema.Struct({
    id: Code,
    name: Name,
    unit: Unit,
    source: Schema.Struct({
      id: Schema.Literal("2"),
      value: Schema.Literal("World Development Indicators"),
    }),
    sourceNote: Description,
    sourceOrganization: Schema.String.check(Schema.isMaxLength(4_000)),
    topics: Schema.Array(
      Schema.Struct({
        id: Schema.String.check(Schema.isMaxLength(20)),
        value: Schema.String.check(Schema.isMaxLength(200)),
      }),
    ).check(Schema.isMaxLength(32)),
  }),
).check(Schema.isMinLength(1), Schema.isMaxLength(20_000));
const CountryRows = Schema.Array(
  Schema.Struct({
    id: Schema.String.check(Schema.isPattern(/^[A-Z0-9]{3}$/)),
    name: Name,
    region: Schema.Struct({
      id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(10)),
    }),
  }),
).check(Schema.isMinLength(1), Schema.isMaxLength(350));
const ValueRows = Schema.Array(
  Schema.Struct({
    indicator: Schema.Struct({ id: Code }),
    countryiso3code: Schema.String.check(Schema.isPattern(/^(?:[A-Z0-9]{3})?$/)),
    date: Schema.String.check(Schema.isPattern(/^\d{4}$/)),
    value: Schema.NullOr(Schema.Finite),
    unit: Unit,
  }),
).check(Schema.isMaxLength(40_000));
const SeriesPage = Schema.Struct({
  page: Pagination.fields.page,
  pages: Pagination.fields.pages,
  per_page: Pagination.fields.per_page,
  total: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 256 })),
  source: Schema.Array(
    Schema.Struct({
      id: Schema.Literal("2"),
      concept: Schema.Array(
        Schema.Struct({
          id: Schema.Literal("Series"),
          variable: Schema.Array(
            Schema.Struct({
              id: Code,
              metatype: Schema.Array(
                Schema.Struct({
                  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80)),
                  value: Schema.String.check(Schema.isMaxLength(32_000)),
                }),
              ).check(Schema.isMaxLength(256)),
            }),
          ).check(Schema.isMinLength(1), Schema.isMaxLength(1)),
        }),
      ).check(Schema.isMinLength(1), Schema.isMaxLength(1)),
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(1)),
});
const isWdiDataFailure = Schema.is(WdiDataFailure);
const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodePage = Schema.decodeUnknownEffect(Page);
const decodeMetadataRows = Schema.decodeUnknownEffect(MetadataRows);
const decodeCountryRows = Schema.decodeUnknownEffect(CountryRows);
const decodeSeriesPage = Schema.decodeUnknownEffect(SeriesPage);
const decodeCatalogInput = Schema.decodeEffect(CatalogInput);
const decodeQuery = Schema.decodeEffect(MatrixResearchQuery);
const decodeValueRows = Schema.decodeUnknownEffect(ValueRows);
const decodeDataset = Schema.decodeEffect(MatrixResearchDataset);
type Metadata = typeof MetadataRows.Type;
type Country = (typeof CountryRows.Type)[number];
type CachedDataset = { dataset: MatrixResearchDataset; retrievedAt: number };
const rowKey = (entity: string, year: number) => `${entity}:${year}`;
const WARNINGS = [
  "Historical annual World Development Indicators, source 2, 1960–2025 only; coverage and reference periods vary by indicator and country. These are not current conditions or forecasts.",
  "World is the World Bank WLD aggregate, preserved as OWID_WRL, never a sum of countries. Other aggregates are excluded using World Bank country metadata (region.id = NA); historical country and territorial definitions follow the source.",
  "Independent indicators are joined by country code and exact calendar year. Missing values remain null; there is no interpolation, conversion, rescaling, or imputation. Some source observations may themselves be estimates or modeled values; observation status is mixed.",
  "The discovery and observation APIs often leave units empty. Requested indicators additionally use authoritative Series metadata units and definitions when supplied; an absent unit is explicitly disclosed, never inferred or transformed. Different indicators may use incompatible units.",
  "Comparing or correlating these histories does not establish causation. National annual indicators are not crop-specific exposure measures.",
  `Per-indicator licenses and license links are preserved from World Bank Series metadata when available. Dataset terms include additional terms and third-party exceptions; check the original provider before reuse: ${TERMS_URL}`,
];

const make = Effect.gen(function* () {
  const http = yield* HttpClient.HttpClient;
  const network = yield* Semaphore.make(3);
  const loads = yield* Semaphore.make(1);
  let metadataCache: { rows: Metadata; retrievedAt: number } | undefined;
  let countryCache: { rows: ReadonlyMap<string, Country>; retrievedAt: number } | undefined;
  const datasets = new Map<string, CachedDataset>();

  const fetchJson = Effect.fn("WdiData.fetchJson")(
    function* (url: string) {
      const response = yield* http.get(url).pipe(
        Effect.mapError(
          (cause) =>
            new WdiDataFailure({
              reason: "upstream",
              source: "worldbank",
              category: "network",
              cause,
            }),
        ),
      );
      if (response.status !== 200)
        return yield* new WdiDataFailure({
          reason: "upstream",
          source: "worldbank",
          category: "http",
        });
      const length = response.headers["content-length"];
      if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES))
        return yield* new WdiDataFailure({
          reason: "upstream",
          source: "worldbank",
          category: "limit",
        });
      let bytes = 0;
      const chunks: string[] = [];
      const decoder = new TextDecoder("utf-8", { fatal: true });
      yield* response.stream.pipe(
        Stream.runForEach((chunk) => {
          bytes += chunk.byteLength;
          if (bytes > MAX_BYTES)
            return Effect.fail(
              new WdiDataFailure({ reason: "upstream", source: "worldbank", category: "limit" }),
            );
          return Effect.try({
            try: () => {
              chunks.push(decoder.decode(chunk, { stream: true }));
            },
            catch: (cause) =>
              new WdiDataFailure({
                reason: "upstream",
                source: "worldbank",
                category: "payload",
                cause,
              }),
          });
        }),
        Effect.mapError((cause) =>
          isWdiDataFailure(cause)
            ? cause
            : new WdiDataFailure({
                reason: "upstream",
                source: "worldbank",
                category: "network",
                cause,
              }),
        ),
      );
      const value = yield* Effect.try({
        try: () => chunks.join("") + decoder.decode(),
        catch: (cause) =>
          new WdiDataFailure({
            reason: "upstream",
            source: "worldbank",
            category: "payload",
            cause,
          }),
      }).pipe(
        Effect.flatMap(decodeJson),
        Effect.mapError((cause) =>
          isWdiDataFailure(cause)
            ? cause
            : new WdiDataFailure({
                reason: "upstream",
                source: "worldbank",
                category: "payload",
                cause,
              }),
        ),
      );
      return { value, bytes };
    },
    Effect.timeout("20 seconds"),
    Effect.mapError((cause) =>
      isWdiDataFailure(cause)
        ? cause
        : new WdiDataFailure({
            reason: "upstream",
            source: "worldbank",
            category: "network",
            cause,
          }),
    ),
    network.withPermit,
  );

  const fetchPages = Effect.fn("WdiData.fetchPages")(function* (
    url: string,
    maxRows: number,
    maxPerPage: number,
    values = false,
  ) {
    let expected: typeof Pagination.Type | undefined;
    const rows: unknown[] = [];
    let bytes = 0;
    for (let page = 1; page <= (expected?.pages ?? 1); page++) {
      const raw = yield* fetchJson(`${url}&page=${page}`);
      bytes += raw.bytes;
      if (bytes > MAX_BYTES)
        return yield* new WdiDataFailure({
          reason: "upstream",
          source: "worldbank",
          category: "limit",
        });
      const [pagination, items] = yield* decodePage(raw.value).pipe(
        Effect.mapError(
          (cause) =>
            new WdiDataFailure({
              reason: "upstream",
              source: "worldbank",
              category: "payload",
              cause,
            }),
        ),
      );
      const perPage = Number(pagination.per_page);
      const pageCount = Math.max(1, Math.ceil(pagination.total / perPage));
      if (pagination.total > maxRows)
        return yield* new WdiDataFailure({
          reason: "upstream",
          source: "worldbank",
          category: "limit",
        });
      if (
        pagination.page !== page ||
        !Number.isInteger(perPage) ||
        perPage < 1 ||
        perPage > maxPerPage ||
        (pagination.pages !== pageCount && !(pagination.total === 0 && pagination.pages === 0)) ||
        (expected &&
          (pagination.pages !== expected.pages ||
            pagination.total !== expected.total ||
            perPage !== Number(expected.per_page) ||
            pagination.lastupdated !== expected.lastupdated ||
            pagination.sourceid !== expected.sourceid))
      ) {
        return yield* new WdiDataFailure({
          reason: "upstream",
          source: "worldbank",
          category: "pagination",
        });
      }
      if (values && (pagination.sourceid !== "2" || !pagination.lastupdated))
        return yield* new WdiDataFailure({
          reason: "upstream",
          source: "worldbank",
          category: "metadata",
        });
      const expectedRows = Math.min(perPage, pagination.total - (page - 1) * perPage);
      if ((items?.length ?? 0) !== expectedRows || (items === null && pagination.total !== 0))
        return yield* new WdiDataFailure({
          reason: "upstream",
          source: "worldbank",
          category: "pagination",
        });
      if (items) for (const item of items) rows.push(item);
      expected = pagination;
    }
    if (!expected || rows.length !== expected.total)
      return yield* new WdiDataFailure({
        reason: "upstream",
        source: "worldbank",
        category: "pagination",
      });
    return { rows, updatedAt: expected.lastupdated ?? null };
  });

  const loadMetadata = Effect.fn("WdiData.loadMetadata")(function* () {
    const now = yield* Clock.currentTimeMillis;
    if (metadataCache && now - metadataCache.retrievedAt < CACHE_MS) return metadataCache.rows;
    const result = yield* fetchPages(METADATA_URL, 20_000, 10_000);
    const rows = yield* decodeMetadataRows(result.rows).pipe(
      Effect.mapError(
        (cause) =>
          new WdiDataFailure({
            reason: "upstream",
            source: "worldbank",
            category: "metadata",
            cause,
          }),
      ),
    );
    const ids = new Set<string>();
    for (const row of rows) {
      if (ids.has(row.id))
        return yield* new WdiDataFailure({
          reason: "upstream",
          source: "worldbank",
          category: "conflict",
        });
      ids.add(row.id);
    }
    metadataCache = { rows, retrievedAt: yield* Clock.currentTimeMillis };
    return rows;
  });

  const loadCountries = Effect.fn("WdiData.loadCountries")(function* () {
    const now = yield* Clock.currentTimeMillis;
    if (countryCache && now - countryCache.retrievedAt < CACHE_MS) return countryCache.rows;
    const result = yield* fetchPages(COUNTRY_URL, 350, 1_000);
    const rows = yield* decodeCountryRows(result.rows).pipe(
      Effect.mapError(
        (cause) =>
          new WdiDataFailure({
            reason: "upstream",
            source: "worldbank",
            category: "metadata",
            cause,
          }),
      ),
    );
    const countries = new Map<string, Country>();
    for (const row of rows) {
      if (countries.has(row.id))
        return yield* new WdiDataFailure({
          reason: "upstream",
          source: "worldbank",
          category: "conflict",
        });
      countries.set(row.id, row);
    }
    const world = countries.get("WLD");
    if (!world || world.region.id !== "NA")
      return yield* new WdiDataFailure({
        reason: "upstream",
        source: "worldbank",
        category: "metadata",
      });
    countryCache = { rows: countries, retrievedAt: yield* Clock.currentTimeMillis };
    return countries;
  });

  const loadSeriesMetadata = Effect.fn("WdiData.loadSeriesMetadata")(function* (id: string) {
    const url = `${BASE}/sources/2/series/${encodeURIComponent(id)}/metadata?format=json&per_page=5000`;
    const attributes = new Map<string, string>();
    let expected: typeof SeriesPage.Type | undefined;
    let count = 0;
    let bytes = 0;
    for (let page = 1; page <= (expected?.pages ?? 1); page++) {
      const raw = yield* fetchJson(`${url}&page=${page}`);
      bytes += raw.bytes;
      if (bytes > MAX_BYTES)
        return yield* new WdiDataFailure({
          reason: "upstream",
          source: "worldbank",
          category: "limit",
        });
      const payload = yield* decodeSeriesPage(raw.value).pipe(
        Effect.mapError(
          (cause) =>
            new WdiDataFailure({
              reason: "upstream",
              source: "worldbank",
              category: "metadata",
              cause,
            }),
        ),
      );
      const perPage = Number(payload.per_page);
      if (
        payload.page !== page ||
        !Number.isInteger(perPage) ||
        perPage < 1 ||
        perPage > 5_000 ||
        payload.pages !== Math.ceil(payload.total / perPage) ||
        (expected &&
          (payload.total !== expected.total ||
            payload.pages !== expected.pages ||
            perPage !== Number(expected.per_page)))
      )
        return yield* new WdiDataFailure({
          reason: "upstream",
          source: "worldbank",
          category: "pagination",
        });
      let pageCount = 0;
      for (const source of payload.source)
        for (const concept of source.concept)
          for (const variable of concept.variable) {
            if (variable.id !== id)
              return yield* new WdiDataFailure({
                reason: "upstream",
                source: "worldbank",
                category: "metadata",
              });
            for (const attribute of variable.metatype) {
              if (attributes.has(attribute.id))
                return yield* new WdiDataFailure({
                  reason: "upstream",
                  source: "worldbank",
                  category: "conflict",
                });
              attributes.set(attribute.id, attribute.value);
              pageCount++;
            }
          }
      if (pageCount !== Math.min(perPage, payload.total - (page - 1) * perPage))
        return yield* new WdiDataFailure({
          reason: "upstream",
          source: "worldbank",
          category: "pagination",
        });
      count += pageCount;
      expected = payload;
    }
    if (
      !expected ||
      count !== expected.total ||
      (attributes.has("Periodicity") && attributes.get("Periodicity") !== "Annual")
    )
      return yield* new WdiDataFailure({
        reason: "upstream",
        source: "worldbank",
        category: "metadata",
      });
    const unit = attributes.get("Unitofmeasure") ?? "";
    const license = attributes.get("License_Type") ?? "";
    const licenseUrl = attributes.get("License_URL") ?? "";
    if (
      unit.length > 200 ||
      license.length > 200 ||
      licenseUrl.length > 1_000 ||
      (licenseUrl && !/^https?:\/\//.test(licenseUrl))
    )
      return yield* new WdiDataFailure({
        reason: "upstream",
        source: "worldbank",
        category: "metadata",
      });
    return { attributes, unit, license, licenseUrl, url: `${url}&page=1` };
  });

  const catalog = Effect.fn("WdiData.catalog")(
    function* (input?: {
      readonly query?: string | undefined;
      readonly page?: number | undefined;
    }) {
      const parsed = yield* decodeCatalogInput(input ?? {}).pipe(
        Effect.mapError(
          (cause) =>
            new WdiDataFailure({
              reason: "invalid_query",
              source: "query",
              category: "selection",
              cause,
            }),
        ),
      );
      const metadata = yield* loadMetadata();
      const terms = (parsed.query ?? "")
        .trim()
        .toLocaleLowerCase("en")
        .split(/\s+/)
        .filter(Boolean);
      const relevance = (indicator: Metadata[number]) => {
        if (!terms.length) return 0;
        const name = indicator.name.toLocaleLowerCase("en");
        const id = indicator.id.toLocaleLowerCase("en");
        const phrase = terms.join(" ");
        return (
          (id === phrase ? 1_000 : 0) +
          (name.includes(phrase) ? 100 : 0) +
          terms.reduce(
            (score, term) => score + (id.includes(term) ? 20 : 0) + (name.includes(term) ? 10 : 0),
            0,
          )
        );
      };
      const filtered = metadata
        .filter((indicator) => {
          const text =
            `${indicator.id} ${indicator.name} ${indicator.sourceNote} ${indicator.topics.map((topic) => topic.value).join(" ")}`.toLocaleLowerCase(
              "en",
            );
          return terms.every((term) => text.includes(term));
        })
        .sort((a, b) => relevance(b) - relevance(a) || a.id.localeCompare(b.id));
      const page = parsed.page ?? 1;
      const pages = Math.max(1, Math.ceil(filtered.length / 40));
      if (page > pages)
        return yield* new WdiDataFailure({
          reason: "invalid_query",
          source: "query",
          category: "range",
        });
      return WdiCatalog.make({
        indicators: filtered.slice((page - 1) * 40, page * 40).map((indicator) => ({
          id: indicator.id,
          name: indicator.name,
          unit: indicator.unit,
          description: indicator.sourceNote,
          topics: indicator.topics.map((topic) => topic.value.trim()).filter(Boolean),
        })),
        indicatorCount: filtered.length,
        page,
        pages,
      });
    },
    loads.withPermit,
    Effect.timeout("90 seconds"),
    Effect.mapError((cause) =>
      isWdiDataFailure(cause)
        ? cause
        : new WdiDataFailure({
            reason: "upstream",
            source: "worldbank",
            category: "network",
            cause,
          }),
    ),
  );

  const query = Effect.fn("WdiData.query")(
    function* (input: Extract<MatrixResearchQuery, { kind: "indicators" }>) {
      const parsed = yield* decodeQuery(input).pipe(
        Effect.mapError(
          (cause) =>
            new WdiDataFailure({
              reason: "invalid_query",
              source: "query",
              category: "selection",
              cause,
            }),
        ),
      );
      if (parsed.kind !== "indicators")
        return yield* new WdiDataFailure({
          reason: "invalid_query",
          source: "query",
          category: "selection",
        });
      const fromYear = parsed.fromYear ?? FROM_YEAR;
      const toYear = parsed.toYear ?? TO_YEAR;
      if (
        fromYear < FROM_YEAR ||
        toYear > TO_YEAR ||
        fromYear > toYear ||
        (parsed.year !== undefined && (parsed.year < fromYear || parsed.year > toYear))
      )
        return yield* new WdiDataFailure({
          reason: "invalid_query",
          source: "query",
          category: "range",
        });
      if (
        parsed.indicators.length < 1 ||
        parsed.indicators.length > 4 ||
        new Set(parsed.indicators).size !== parsed.indicators.length ||
        (parsed.entities && new Set(parsed.entities).size !== parsed.entities.length) ||
        (parsed.measure !== undefined && !parsed.indicators.includes(parsed.measure))
      )
        return yield* new WdiDataFailure({
          reason: "invalid_query",
          source: "query",
          category: "selection",
        });
      const cacheKey = `${parsed.indicators.join(";")}:${fromYear}:${toYear}:${parsed.measure ?? parsed.indicators[0]}`;
      const now = yield* Clock.currentTimeMillis;
      const cached = datasets.get(cacheKey);
      if (cached && now - cached.retrievedAt < CACHE_MS) {
        if (
          parsed.entities?.some((id) => !cached.dataset.entities.some((entity) => entity.id === id))
        )
          return yield* new WdiDataFailure({
            reason: "invalid_query",
            source: "query",
            category: "selection",
          });
        if (
          parsed.year !== undefined &&
          !cached.dataset.observations.some((row) => row.year === parsed.year)
        )
          return yield* new WdiDataFailure({
            reason: "invalid_query",
            source: "query",
            category: "range",
          });
        return { ...cached.dataset, id: parsed.id };
      }
      const metadata = yield* loadMetadata();
      const indicators: Metadata[number][] = [];
      for (const id of parsed.indicators) {
        const indicator = metadata.find((candidate) => candidate.id === id);
        if (!indicator)
          return yield* new WdiDataFailure({
            reason: "invalid_query",
            source: "query",
            category: "selection",
          });
        indicators.push(indicator);
      }
      const countries = yield* loadCountries();
      const histories = yield* Effect.all(
        indicators.map((indicator) =>
          Effect.gen(function* () {
            const url = `${BASE}/country/all/indicator/${encodeURIComponent(indicator.id)}?source=2&format=json&date=${fromYear}:${toYear}&per_page=20000`;
            const result = yield* fetchPages(url, 40_000, 20_000, true);
            const series = yield* loadSeriesMetadata(indicator.id);
            const values = yield* decodeValueRows(result.rows).pipe(
              Effect.mapError(
                (cause) =>
                  new WdiDataFailure({
                    reason: "upstream",
                    source: "worldbank",
                    category: "payload",
                    cause,
                  }),
              ),
            );
            return {
              indicator,
              values,
              series,
              url,
              updatedAt: result.updatedAt,
              retrievedAt: yield* Clock.currentTimeMillis,
            };
          }),
        ),
        { concurrency: 3 },
      );
      const rows = new Map<
        string,
        {
          entityId: string;
          year: number;
          values: Record<string, number | null>;
          status: MatrixResearchObservation["status"];
        }
      >();
      const present = new Set<string>();
      const sources: MatrixResearchSource[] = [];
      const measures: MatrixResearchMeasure[] = [];
      const metadataWarnings: string[] = [];
      let latestYear = 0;
      let latestSelectedYear = 0;
      for (const [index, history] of histories.entries()) {
        const { indicator } = history;
        const sourceId = `worldbank-${index + 1}`;
        const definition = history.series.attributes.get("Longdefinition") || indicator.sourceNote;
        const aggregation = history.series.attributes.get("Aggregationmethod");
        const referencePeriod = history.series.attributes.get("Referenceperiod");
        const limitations = history.series.attributes.get("Limitationsandexceptions");
        if (limitations)
          metadataWarnings.push(
            `${indicator.id} source limitations${limitations.length > 3_000 ? " (excerpt)" : ""}: ${limitations.slice(0, 3_000)} Full metadata: ${history.series.url}`,
          );
        if (!history.series.unit && !indicator.unit)
          metadataWarnings.push(
            `${indicator.id} has no explicit unit in the source metadata. Consult its label and definition; no unit conversion or inference was made.`,
          );
        if (!history.series.license)
          metadataWarnings.push(
            `${indicator.id} has no per-indicator license in Series metadata. The displayed World Bank default license remains subject to additional terms and third-party exceptions.`,
          );
        measures.push({
          id: indicator.id,
          label: indicator.name,
          unit: history.series.unit || indicator.unit || "Source-defined (see label)",
          description: `${definition.slice(0, 2_500)}${definition.length > 2_500 ? " [Definition excerpt.]" : ""}${aggregation ? ` Source aggregation: ${aggregation.slice(0, 200)}.` : ""}${referencePeriod ? ` Source reference period: ${referencePeriod.slice(0, 200)}.` : ""} Source values are unchanged. Full definition and methodology: ${history.series.url}`,
          sourceIds: [sourceId],
          derived: false,
          colorScale: history.values.some((value) => value.value !== null && value.value < 0)
            ? "diverging"
            : "sequential",
        });
        sources.push({
          id: sourceId,
          name: indicator.name,
          url: `https://data.worldbank.org/indicator/${encodeURIComponent(indicator.id)}`,
          downloadUrl: `${history.url}&page=1`,
          retrievedAt: DateTime.formatIso(DateTime.makeUnsafe(history.retrievedAt)),
          updatedAt: history.updatedAt,
          license: history.series.license || "World Bank default CC BY 4.0; third-party exceptions",
          description: `World Development Indicators, source 2; ${indicator.id}. Original provider: ${indicator.sourceOrganization.slice(0, 800)}. Series provider: ${(history.series.attributes.get("Source") ?? "not supplied").slice(0, 800)}. Unit: ${history.series.unit || indicator.unit || "not supplied; consult definition"}. License: ${history.series.licenseUrl || "not supplied; World Bank default applies with exceptions"}. Terms: ${TERMS_URL}. Full metadata and methodology: ${history.series.url}. Country classification: ${COUNTRY_URL}&page=1.`,
        });
        const seen = new Map<string, number | null>();
        for (const value of history.values) {
          const year = Number(value.date);
          if (
            value.indicator.id !== indicator.id ||
            value.unit !== indicator.unit ||
            year < fromYear ||
            year > toYear
          )
            return yield* new WdiDataFailure({
              reason: "upstream",
              source: "worldbank",
              category: "metadata",
            });
          if (!value.countryiso3code) continue;
          const country = countries.get(value.countryiso3code);
          if (!country)
            return yield* new WdiDataFailure({
              reason: "upstream",
              source: "worldbank",
              category: "metadata",
            });
          const key = rowKey(country.id, year);
          if (seen.has(key)) {
            if (seen.get(key) !== value.value)
              return yield* new WdiDataFailure({
                reason: "upstream",
                source: "worldbank",
                category: "conflict",
              });
            continue;
          }
          seen.set(key, value.value);
          if (country.id !== "WLD" && country.region.id === "NA") continue;
          if (country.id !== "WLD" && !/^[A-Z]{3}$/.test(country.id)) continue;
          const entityId = country.id === "WLD" ? "OWID_WRL" : country.id;
          const joinedKey = rowKey(entityId, year);
          let row = rows.get(joinedKey);
          if (!row) {
            const values: Record<string, number | null> = {};
            for (const item of indicators) values[item.id] = null;
            row = { entityId, year, values, status: "mixed" };
            rows.set(joinedKey, row);
          }
          row.values[indicator.id] = value.value;
          present.add(entityId);
          if (value.value !== null) {
            latestYear = Math.max(latestYear, year);
            if (indicator.id === (parsed.measure ?? parsed.indicators[0]))
              latestSelectedYear = Math.max(latestSelectedYear, year);
          }
        }
      }
      if (!latestYear)
        return yield* new WdiDataFailure({
          reason: "unavailable",
          source: "dataset",
          category: "empty",
        });
      if (rows.size > 30_000 || present.size > 350)
        return yield* new WdiDataFailure({
          reason: "upstream",
          source: "dataset",
          category: "limit",
        });
      if (parsed.entities?.some((id) => !present.has(id)))
        return yield* new WdiDataFailure({
          reason: "invalid_query",
          source: "query",
          category: "selection",
        });
      const entities = [...present].sort().map((id) => ({
        id,
        name: countries.get(id === "OWID_WRL" ? "WLD" : id)!.name,
        iso3: id === "OWID_WRL" ? null : id,
      }));
      const observations = [...rows.values()].sort(
        (a, b) => a.entityId.localeCompare(b.entityId) || a.year - b.year,
      );
      if (parsed.year !== undefined && !observations.some((row) => row.year === parsed.year))
        return yield* new WdiDataFailure({
          reason: "invalid_query",
          source: "query",
          category: "range",
        });
      const dataset = yield* decodeDataset({
        id: parsed.id,
        title: `World Development Indicators: ${indicators.length} selected ${indicators.length === 1 ? "indicator" : "indicators"}`,
        frequency: "annual",
        geography: "country",
        timeBasis:
          "Annual source observations joined on the exact source calendar year; reference periods and historical geography follow each indicator definition.",
        defaultYear: latestSelectedYear || latestYear,
        entities,
        measures,
        observations,
        sources,
        warnings: [
          ...WARNINGS,
          ...metadataWarnings,
          ...(latestSelectedYear
            ? []
            : [
                "The selected measure has no non-null observations in this range. The default year is the latest non-null year of another selected indicator; missing values remain null.",
              ]),
        ],
      }).pipe(
        Effect.mapError(
          (cause) =>
            new WdiDataFailure({
              reason: "upstream",
              source: "dataset",
              category: "payload",
              cause,
            }),
        ),
      );
      datasets.delete(cacheKey);
      if (datasets.size >= MAX_DATASETS) datasets.delete(datasets.keys().next().value!);
      datasets.set(cacheKey, { dataset, retrievedAt: yield* Clock.currentTimeMillis });
      return dataset;
    },
    loads.withPermit,
    Effect.timeout("90 seconds"),
    Effect.mapError((cause) =>
      isWdiDataFailure(cause)
        ? cause
        : new WdiDataFailure({ reason: "upstream", source: "dataset", category: "network", cause }),
    ),
  );

  return WdiData.of({ catalog, query });
});

export const layer = Layer.effect(WdiData, make);
