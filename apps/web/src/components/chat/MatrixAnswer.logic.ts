import type { MatrixAnswerCompany, MatrixAnswerMetric, MatrixMetricId } from "@t3tools/contracts";

export type Observation = MatrixAnswerMetric["observations"][number];
export const METRIC_LABELS: Record<MatrixMetricId, string> = {
  revenue: "Revenue",
  netIncome: "Net income",
  operatingCashFlow: "Operating cash flow",
  capex: "Capital expenditures",
  assets: "Assets",
  liabilities: "Liabilities",
  netMargin: "Net margin",
  operatingCashFlowMargin: "Operating cash flow margin",
};

/** A short first glance without losing any of the authored interpretation. */
export function matrixSummaryPreview(summary: string): string {
  if (summary.length <= 220) return summary;
  const prefix = summary.slice(0, 217);
  const boundary = prefix.lastIndexOf(" ");
  return `${prefix.slice(0, boundary >= 160 ? boundary : prefix.length).trimEnd()}…`;
}

export function periodKey(observation: Pick<Observation, "start" | "end">): string {
  return `${observation.end}|${observation.start ?? ""}`;
}
export function periodLabel(observation: Pick<Observation, "start" | "end">): string {
  return observation.start === null
    ? `As of ${observation.end}`
    : `${observation.start} – ${observation.end}`;
}
export function safeSecUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      ["sec.gov", "www.sec.gov", "data.sec.gov"].includes(url.hostname) &&
      !url.username &&
      !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}
export function exactValue(value: number, unit: MatrixAnswerMetric["unit"]): string {
  return `${value.toLocaleString("en-US", { maximumSignificantDigits: 21 })} ${unit === "percent" ? "%" : unit}`;
}
export function compactValue(value: number, unit: MatrixAnswerMetric["unit"]): string {
  return unit === "percent"
    ? `${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}%`
    : `$${value.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 2 })}`;
}

export function metricSeries(
  companies: ReadonlyArray<MatrixAnswerCompany>,
  metric: MatrixMetricId,
  symbols: ReadonlySet<string>,
  from = "",
  to = "",
) {
  return companies
    .filter((company) => symbols.has(company.symbol))
    .map((company) => {
      const data = company.metrics.find((candidate) => candidate.id === metric);
      return {
        company,
        metric: data,
        observations: (data?.observations ?? [])
          .filter(
            (observation) => (!from || observation.end >= from) && (!to || observation.end <= to),
          )
          .toSorted((a, b) => periodKey(a).localeCompare(periodKey(b))),
      };
    });
}

/** Keep a company's own trajectory even when other companies' fiscal dates interleave. */
export function chartSeriesPoints(
  observations: ReadonlyArray<Observation>,
  periodKeys: ReadonlyArray<string>,
) {
  const positions = new Map(periodKeys.map((key, index) => [key, index]));
  return observations.map((observation, index) => {
    const previous = observations[index - 1];
    return {
      observation,
      index: positions.get(periodKey(observation))!,
      previous,
      previousIndex: previous ? positions.get(periodKey(previous))! : null,
    };
  });
}

export interface FinancialRow {
  readonly company: MatrixAnswerCompany;
  readonly period: Pick<Observation, "start" | "end"> | null;
  readonly cells: Map<MatrixMetricId, { metric: MatrixAnswerMetric; observation: Observation }>;
}
export function financialRows(
  companies: ReadonlyArray<MatrixAnswerCompany>,
  metrics: ReadonlyArray<MatrixMetricId>,
  mode: "exact" | "latest" = "exact",
): FinancialRow[] {
  if (mode === "latest") {
    return companies.map((company) => {
      const cells: FinancialRow["cells"] = new Map();
      for (const metric of company.metrics) {
        if (!metrics.includes(metric.id)) continue;
        const observation = metric.observations.toSorted((a, b) =>
          periodKey(b).localeCompare(periodKey(a)),
        )[0];
        if (observation) cells.set(metric.id, { metric, observation });
      }
      return { company, period: null, cells };
    });
  }
  return companies.flatMap((company) => {
    const rows = new Map<string, FinancialRow>();
    for (const metric of company.metrics) {
      if (!metrics.includes(metric.id)) continue;
      for (const observation of metric.observations) {
        const key = periodKey(observation);
        let row = rows.get(key);
        if (!row) {
          row = { company, period: observation, cells: new Map() };
          rows.set(key, row);
        }
        // A row is an exact SEC period; annual and quarterly observations never coalesce.
        row.cells.set(metric.id, { metric, observation });
      }
    }
    return rows.size ? [...rows.values()] : [{ company, period: null, cells: new Map() }];
  });
}
export function sortFinancialRows(
  rows: ReadonlyArray<FinancialRow>,
  key: "company" | "period" | MatrixMetricId,
  direction: "asc" | "desc",
): FinancialRow[] {
  return rows.toSorted((a, b) => {
    const left =
      key === "company"
        ? a.company.symbol
        : key === "period"
          ? a.period && periodKey(a.period)
          : a.cells.get(key)?.observation.value;
    const right =
      key === "company"
        ? b.company.symbol
        : key === "period"
          ? b.period && periodKey(b.period)
          : b.cells.get(key)?.observation.value;
    if (left === undefined || left === null) return right === undefined || right === null ? 0 : 1;
    if (right === undefined || right === null) return -1;
    const comparison =
      typeof left === "number" && typeof right === "number"
        ? left - right
        : String(left).localeCompare(String(right));
    return (direction === "asc" ? 1 : -1) * comparison;
  });
}
