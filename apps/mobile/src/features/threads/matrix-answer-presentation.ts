import type {
  MatrixAnswerCompany,
  MatrixAnswerMetric,
  MatrixAnswerSpec,
  MatrixMetricId,
} from "@t3tools/contracts";
import { matrixAnswerSections } from "@t3tools/shared/matrixAnswerLayout";

export type MatrixObservation = MatrixAnswerMetric["observations"][number];

export function matrixPeriodKey(observation: Pick<MatrixObservation, "start" | "end">): string {
  return `${observation.start ?? ""}/${observation.end}`;
}

export function matrixPeriodLabel(observation: Pick<MatrixObservation, "start" | "end">): string {
  return observation.start === null
    ? `As of ${observation.end}`
    : `${observation.start} – ${observation.end}`;
}

export function matrixExactValue(value: number, unit: MatrixAnswerMetric["unit"]): string {
  // Preserve the server's finite value, including derived ratios, without display rounding.
  return `${String(value)} ${unit === "percent" ? "%" : "USD"}`;
}

export function matrixOrderedObservations(metric: MatrixAnswerMetric): MatrixObservation[] {
  return [...metric.observations].sort(
    (a, b) => a.end.localeCompare(b.end) || (a.start ?? "").localeCompare(b.start ?? ""),
  );
}

export function matrixComparisonPeriods(
  companies: readonly MatrixAnswerCompany[],
  metrics: readonly MatrixMetricId[],
) {
  const periods = new Map<string, Pick<MatrixObservation, "start" | "end">>();
  for (const company of companies) {
    for (const metric of company.metrics) {
      if (!metrics.includes(metric.id)) continue;
      for (const observation of metric.observations)
        periods.set(matrixPeriodKey(observation), observation);
    }
  }
  return [...periods.values()].sort(
    (a, b) => b.end.localeCompare(a.end) || (b.start ?? "").localeCompare(a.start ?? ""),
  );
}

export function matrixComparisonRows(
  companies: readonly MatrixAnswerCompany[],
  metrics: readonly MatrixMetricId[],
  periodKey: string | null,
  sort: { readonly metric: MatrixMetricId; readonly descending: boolean } | null,
) {
  const selections = companies.flatMap((company) => {
    const periods = periodKey === "all" ? matrixComparisonPeriods([company], metrics) : [];
    return periods.length
      ? periods.map((period) => ({ company, periodKey: matrixPeriodKey(period) }))
      : [{ company, periodKey: periodKey === "all" ? null : periodKey }];
  });
  const rows = selections.map(({ company, periodKey }) => ({
    periodKey,
    company,
    cells: metrics.map((id) => {
      const metric = company.metrics.find((candidate) => candidate.id === id);
      const observation =
        metric === undefined
          ? undefined
          : periodKey === null
            ? matrixOrderedObservations(metric).at(-1)
            : metric.observations.find((candidate) => matrixPeriodKey(candidate) === periodKey);
      return { id, metric, observation };
    }),
  }));
  if (sort !== null) {
    rows.sort((a, b) => {
      const left = a.cells.find((cell) => cell.id === sort.metric)?.observation?.value;
      const right = b.cells.find((cell) => cell.id === sort.metric)?.observation?.value;
      if (left === undefined)
        return right === undefined ? a.company.symbol.localeCompare(b.company.symbol) : 1;
      if (right === undefined) return -1;
      return (
        (sort.descending ? right - left : left - right) ||
        a.company.symbol.localeCompare(b.company.symbol)
      );
    });
  }
  return rows;
}

export function matrixSafeSourceUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      (url.hostname === "sec.gov" ||
        url.hostname === "www.sec.gov" ||
        url.hostname === "data.sec.gov")
    );
  } catch {
    return false;
  }
}

/** A revision may remove the active tab; always leave a reachable section selected. */
export function matrixVisibleSection(spec: MatrixAnswerSpec, selectedId: string | null) {
  const sections = matrixAnswerSections(spec);
  return {
    sections,
    selected: sections.find((section) => section.id === selectedId) ?? sections[0],
  };
}

/** Respect authored grouping without squeezing native cards below a readable width. */
export function matrixCardColumns(width: number, requested: 1 | 2 | 3): number {
  return Math.min(requested, Math.max(1, Math.floor((width + 12) / 272)));
}
