import {
  MatrixAnswerError,
  MatrixAnswerSpec,
  type MatrixAnswerCompany,
  type MatrixAnswerMetric,
  type MatrixMetricId,
  type MatrixSecCompany,
  type MatrixAnswer,
  type MatrixResearchDataset,
  type MatrixResearchView,
} from "@t3tools/contracts";
import { selectAnnualTrend } from "@t3tools/shared/matrixAnnualTrend";
import { matrixDiagramLayout } from "@t3tools/shared/matrixAnswerLayout";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

type Observation = MatrixSecCompany["metrics"][number]["observations"][number];
const labels: Record<MatrixMetricId, string> = {
  revenue: "Revenue",
  netIncome: "Net income",
  operatingCashFlow: "Operating cash flow",
  capex: "Capital expenditures",
  assets: "Assets",
  liabilities: "Liabilities",
  netMargin: "Net margin",
  operatingCashFlowMargin: "Operating cash flow margin",
};
const reportedIds = [
  "revenue",
  "netIncome",
  "operatingCashFlow",
  "capex",
  "assets",
  "liabilities",
] as const;
const decodeAnswerSpec = Schema.decodeUnknownEffect(MatrixAnswerSpec);

export const decodeSpec = Effect.fn("MatrixAnswer.decodeSpec")(function* (input: unknown) {
  const spec = yield* decodeAnswerSpec(input).pipe(
    Effect.mapError((cause) => new MatrixAnswerError({ reason: "invalid_request", cause })),
  );
  const symbols = spec.symbols.map((symbol) => symbol.trim().toUpperCase());
  const blockIds = new Set(spec.blocks.map((block) => block.id));
  const sectionBlockIds = spec.sections?.flatMap((section) => section.blockIds) ?? [];
  const queries = spec.queries ?? [];
  const queryIds = new Set(queries.map((query) => query.id));
  const prompts = spec.blocks.flatMap((block) => (block.kind === "actions" ? block.prompts : []));
  if (
    new Set(symbols).size !== symbols.length ||
    queryIds.size !== queries.length ||
    queries.some(
      (query) =>
        (query.fromYear !== undefined &&
          query.toYear !== undefined &&
          query.fromYear > query.toYear) ||
        (query.year !== undefined &&
          ((query.fromYear !== undefined && query.year < query.fromYear) ||
            (query.toYear !== undefined && query.year > query.toYear))) ||
        (query.entities !== undefined && new Set(query.entities).size !== query.entities.length),
    ) ||
    spec.blocks.some((block) => "dataset" in block && !queryIds.has(block.dataset)) ||
    blockIds.size !== spec.blocks.length ||
    (symbols.length === 0 &&
      spec.blocks.some((block) =>
        ["company", "metric", "chart", "table", "filings"].includes(block.kind),
      )) ||
    (spec.sections !== undefined &&
      (new Set(spec.sections.map((section) => section.id)).size !== spec.sections.length ||
        sectionBlockIds.length !== spec.blocks.length ||
        new Set(sectionBlockIds).size !== spec.blocks.length ||
        sectionBlockIds.some((id) => !blockIds.has(id)))) ||
    new Set(prompts).size !== prompts.length ||
    spec.blocks.some(
      (block) =>
        (block.kind === "table" && new Set(block.metrics).size !== block.metrics.length) ||
        (block.kind === "diagram" && matrixDiagramLayout(block) === null),
    ) ||
    symbols.some(
      (symbol) =>
        !/^(?:[A-Z][A-Z0-9.-]{0,19}|(?:CIK:)?[0-9]{1,10})$/.test(symbol) ||
        (/^(?:CIK:)?[0-9]+$/.test(symbol) && Number(symbol.replace(/^CIK:/, "")) === 0),
    )
  ) {
    return yield* new MatrixAnswerError({ reason: "invalid_request" });
  }
  return { ...spec, symbols };
});

export function validResearchView(
  dataset: MatrixResearchDataset,
  view: MatrixResearchView,
): boolean {
  return (
    new Set(view.entities).size === view.entities.length &&
    view.entities.every((id) => dataset.entities.some((entity) => entity.id === id)) &&
    (view.measure === null || dataset.measures.some((measure) => measure.id === view.measure)) &&
    (view.year === null || dataset.observations.some((point) => point.year === view.year))
  );
}

/** Validate references even for internal event-log writes, not just public presentation. */
export const validateResearchAnswer = Effect.fn("MatrixAnswer.validateResearchAnswer")(function* (
  answer: Pick<MatrixAnswer, "spec" | "datasets" | "views" | "researchFocus">,
) {
  const datasets = answer.datasets ?? [];
  const queries = answer.spec.queries ?? [];
  const views = answer.views ?? [];
  let valid =
    datasets.length === queries.length &&
    new Set(datasets.map((dataset) => dataset.id)).size === datasets.length &&
    new Set(views.map((entry) => entry.datasetId)).size === views.length;
  for (const dataset of datasets) {
    const query = queries.find((query) => query.id === dataset.id);
    const entities = new Set(dataset.entities.map((entity) => entity.id));
    const measures = new Set(dataset.measures.map((measure) => measure.id));
    const sources = new Set(dataset.sources.map((source) => source.id));
    const observationKeys = new Set<string>();
    valid &&=
      query !== undefined &&
      entities.size === dataset.entities.length &&
      measures.size === dataset.measures.length &&
      sources.size === dataset.sources.length &&
      dataset.measures.every((measure) => measure.sourceIds.every((id) => sources.has(id))) &&
      dataset.observations.some((point) => point.year === dataset.defaultYear);
    if (query !== undefined) {
      valid &&= validResearchView(dataset, {
        entities: query.entities ?? [],
        year: query.year ?? null,
        measure: query.measure ?? null,
      });
    }
    for (const point of dataset.observations) {
      const key = `${point.entityId}:${point.year}`;
      valid &&=
        !observationKeys.has(key) &&
        entities.has(point.entityId) &&
        Object.keys(point.values).every((id) => measures.has(id)) &&
        (query?.fromYear === undefined || point.year >= query.fromYear) &&
        (query?.toYear === undefined || point.year <= query.toYear);
      observationKeys.add(key);
    }
  }
  for (const block of answer.spec.blocks) {
    if (!("dataset" in block)) continue;
    const dataset = datasets.find((candidate) => candidate.id === block.dataset);
    const ids =
      "measure" in block
        ? [block.measure]
        : "measures" in block
          ? block.measures
          : [block.xMeasure, block.yMeasure];
    valid &&=
      dataset !== undefined &&
      (!("measures" in block) || new Set(ids).size === ids.length) &&
      ids.every((id) => dataset.measures.some((measure) => measure.id === id));
  }
  valid &&= views.every((entry) => {
    const dataset = datasets.find((candidate) => candidate.id === entry.datasetId);
    return dataset !== undefined && validResearchView(dataset, entry.view);
  });
  if (answer.researchFocus !== undefined) {
    const focus = answer.researchFocus.entities;
    valid &&=
      datasets.length > 0 &&
      new Set(focus).size === focus.length &&
      focus.every((id) =>
        datasets.some((dataset) => dataset.entities.some((entity) => entity.id === id)),
      );
  }
  if (!valid) return yield* new MatrixAnswerError({ reason: "invalid_request" });
});

export function requestedMetrics(spec: MatrixAnswerSpec): MatrixMetricId[] {
  return [
    ...new Set(
      spec.blocks.flatMap((block) =>
        block.kind === "metric" || block.kind === "chart"
          ? [block.metric]
          : block.kind === "table"
            ? block.metrics
            : [],
      ),
    ),
  ];
}

export function isSecUrl(value: string): boolean {
  const url = URL.parse(value);
  return (
    url !== null &&
    url.protocol === "https:" &&
    ["sec.gov", "www.sec.gov", "data.sec.gov"].includes(url.hostname) &&
    !url.username &&
    !url.password &&
    !url.port
  );
}

function isDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = DateTime.make(value);
  return Option.isSome(parsed) && DateTime.formatIso(parsed.value).slice(0, 10) === value;
}

function supported(point: Observation, instant: boolean): boolean {
  if (
    !Number.isFinite(point.value) ||
    !isDate(point.end) ||
    !isDate(point.filed) ||
    point.filed < point.end ||
    !/^(10-K|20-F|40-F)(\/A)?$/.test(point.form) ||
    !/^\d{10}-\d{2}-\d{6}$/.test(point.accession) ||
    !point.tag.trim() ||
    !isSecUrl(point.url)
  )
    return false;
  if (instant) return point.start === null;
  if (point.start === null || !isDate(point.start)) return false;
  const days = (Date.parse(point.end) - Date.parse(point.start)) / 86_400_000;
  return days >= 300 && days <= 400;
}

const source = (point: Observation) => ({
  url: point.url,
  accession: point.accession,
  tag: point.tag,
  filed: point.filed,
});

export function normalizeCompany(
  symbol: string,
  company: MatrixSecCompany,
  requested: readonly MatrixMetricId[],
): MatrixAnswerCompany {
  const warnings = [...company.warnings];
  const selected = new Map<MatrixMetricId, Observation[]>();
  for (const id of reportedIds) {
    const candidates = company.metrics.filter((metric) => metric.id === id);
    const points = candidates
      .filter((metric) => metric.unit === "USD")
      .flatMap((metric) => metric.observations);
    const valid = points.filter((point) =>
      supported(point, id === "assets" || id === "liabilities"),
    );
    const disclosures = selectAnnualTrend(points);
    const trend = disclosures.filter((point) =>
      supported(point, id === "assets" || id === "liabilities"),
    );
    if (valid.length !== points.length || candidates.some((metric) => metric.unit !== "USD")) {
      warnings.push(
        `${labels[id]}: unsupported units, unsafe sources or invalid annual observations were omitted; no substitute values were used.`,
      );
    }
    if (new Set(points.map((point) => point.end)).size !== disclosures.length) {
      warnings.push(`${labels[id]}: conflicting same-day disclosures were omitted.`);
    }
    selected.set(id, trend);
  }
  const metrics: MatrixAnswerMetric[] = requested.map((id) => {
    const derived = id === "netMargin" || id === "operatingCashFlowMargin";
    let observations: MatrixAnswerMetric["observations"];
    if (derived) {
      const numerator = selected.get(id === "netMargin" ? "netIncome" : "operatingCashFlow") ?? [];
      const revenue = selected.get("revenue") ?? [];
      observations = numerator.flatMap((point) => {
        const denominator = revenue.find(
          (candidate) =>
            candidate.start === point.start &&
            candidate.end === point.end &&
            candidate.accession === point.accession &&
            candidate.filed === point.filed,
        );
        if (!denominator || denominator.value === 0) return [];
        const value = (point.value / denominator.value) * 100;
        return Number.isFinite(value)
          ? [
              {
                start: point.start,
                end: point.end,
                value,
                sources: [source(point), source(denominator)],
              },
            ]
          : [];
      });
      warnings.push(
        `${labels[id]} is calculated as 100 × ${id === "netMargin" ? "net income" : "operating cash flow"} / revenue, using identical annual dates and filing accession. Missing, conflicting, nonfinite or zero-denominator periods are omitted, not zero.`,
      );
    } else {
      observations = (selected.get(id) ?? []).map((point) => ({
        start: point.start,
        end: point.end,
        value: point.value,
        sources: [source(point)],
      }));
    }
    if (observations.length > 20)
      warnings.push(`${labels[id]} is limited to the 20 most recent supported annual periods.`);
    if (observations.length === 0)
      warnings.push(
        `${labels[id]}: no supported observations available. Missing values are not zero.`,
      );
    return {
      id,
      label: labels[id],
      unit: derived ? "percent" : "USD",
      description: derived
        ? "Server-calculated ratio, not an SEC-reported fact. Both exact filing sources are attached to every value."
        : "Reported annual USD fact selected from stockpricer-normalized SEC disclosures. Exact dates, reported signs and filing sources are retained; no FX conversion.",
      observations: observations.slice(-20),
    };
  });
  const filings = company.filings.filter((filing) => isSecUrl(filing.url));
  const sources = company.sources.filter((entry) => isSecUrl(entry.url));
  if (filings.length !== company.filings.length || sources.length !== company.sources.length)
    warnings.push("Non-SEC or unsafe source links were omitted.");
  warnings.push(
    "Summary, explanations and qualitative diagrams are model interpretation, not reported facts or sourced allocations. Historical annual USD data is not live pricing or investment advice. Different company fiscal dates are not aligned or interpolated. Values use JSON floating-point precision.",
  );
  return {
    symbol,
    cik: company.company.cik,
    name: company.company.name,
    profile: company.company,
    metrics,
    filings,
    sources,
    warnings,
  };
}
