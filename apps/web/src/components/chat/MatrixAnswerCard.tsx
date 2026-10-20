import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  ThreadId,
  MatrixAnswer,
  MatrixAnswerCompany,
  MatrixAnswerMetric,
  MatrixMetricId,
  MatrixAnswerBlock,
  MatrixResearchView,
} from "@t3tools/contracts";
import { CommandId, MessageId } from "@t3tools/contracts";
import {
  matrixAnswerSections,
  matrixAnswerPeriodWindow,
  matrixDiagramLayout,
} from "@t3tools/shared/matrixAnswerLayout";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { PinIcon } from "lucide-react";
import { randomUUID } from "../../lib/utils";
import { matrixEnvironment } from "../../state/matrix";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import {
  chartSeriesPoints,
  compactValue,
  exactValue,
  financialRows,
  METRIC_LABELS,
  metricSeries,
  periodKey,
  matrixSummaryPreview,
  periodLabel,
  safeSecUrl,
  sortFinancialRows,
  type Observation,
} from "./MatrixAnswer.logic";
import {
  ResearchCanvas,
  ResearchBlockView,
  ResearchCanvasControls,
  ResearchCanvasSources,
} from "../../matrix/ResearchCanvas";

const COLORS = ["#0284c7", "#d97706", "#8b5cf6", "#059669"];
const CONTROL = "min-h-8 max-w-full rounded-md border border-input bg-background px-2 text-xs";

function SourceLink({ url, children }: { url: string; children: ReactNode }) {
  const href = safeSecUrl(url);
  return href ? (
    <a
      className="break-all underline decoration-muted-foreground/40 underline-offset-2 hover:decoration-current"
      href={href}
      target="_blank"
      rel="noopener noreferrer"
    >
      {children}
    </a>
  ) : (
    <span>{children} (source link unavailable)</span>
  );
}

function SourcedValue({
  observation,
  metric,
  analyst = false,
}: {
  observation: Observation;
  metric: MatrixAnswerMetric;
  analyst?: boolean;
}) {
  return (
    <details className="min-w-0 text-xs" open={analyst}>
      <summary className="cursor-pointer tabular-nums">
        {exactValue(observation.value, metric.unit)}
      </summary>
      <div className="mt-1 space-y-1 break-words text-muted-foreground">
        <div>{periodLabel(observation)}</div>
        {observation.sources.map((source) => (
          <div key={`${source.accession}:${source.tag}`}>
            <SourceLink url={source.url}>{source.tag}</SourceLink> · filed {source.filed}
            <br />
            Accession {source.accession}
          </div>
        ))}
      </div>
    </details>
  );
}

function MetricCards({
  companies,
  metricId,
  analyst,
}: {
  companies: ReadonlyArray<MatrixAnswerCompany>;
  metricId: MatrixMetricId;
  analyst: boolean;
}) {
  return (
    <section className="space-y-2" aria-label={METRIC_LABELS[metricId]}>
      <h4 className="font-medium">{METRIC_LABELS[metricId]}</h4>
      <div className={`grid gap-2 ${companies.length > 1 ? "sm:grid-cols-2" : ""}`}>
        {companies.map((company) => {
          const metric = company.metrics.find((item) => item.id === metricId);
          const latest = metric?.observations.toSorted((a, b) =>
            periodKey(b).localeCompare(periodKey(a)),
          )[0];
          return (
            <div
              className="min-w-0 rounded-lg border border-border bg-muted/20 p-3"
              key={company.symbol}
            >
              <div className="text-xs text-muted-foreground">
                {company.symbol} · {company.name}
              </div>
              {metric && latest ? (
                <>
                  <div className="my-1 text-2xl font-semibold tabular-nums">
                    {compactValue(latest.value, metric.unit)}
                  </div>
                  <div className="mb-2 text-xs text-muted-foreground">
                    {periodLabel(latest)} · {metric.unit}
                  </div>
                  <SourcedValue observation={latest} metric={metric} analyst={analyst} />
                  <details className="mt-2 text-xs text-muted-foreground" open={analyst}>
                    <summary className="cursor-pointer">About this metric</summary>
                    <p className="mt-1">{metric.description}</p>
                  </details>
                </>
              ) : (
                <p className="mt-2 text-xs text-muted-foreground">
                  Not reported · no substitute value used.
                </p>
              )}
            </div>
          );
        })}
      </div>
      {companies.length > 1 ? (
        <p className="text-xs text-muted-foreground">
          Company fiscal periods may differ; exact dates are shown above.
        </p>
      ) : null}
    </section>
  );
}

function FinancialTable({
  companies,
  metrics,
  analyst,
  requestedPeriods,
}: {
  companies: ReadonlyArray<MatrixAnswerCompany>;
  metrics: ReadonlyArray<MatrixMetricId>;
  analyst: boolean;
  requestedPeriods: number | undefined;
}) {
  const [mode, setMode] = useState<"latest" | "exact">(requestedPeriods ? "exact" : "latest");
  const [window, setWindow] = useState(requestedPeriods);
  const [sort, setSort] = useState<{
    key: "company" | "period" | MatrixMetricId;
    direction: "asc" | "desc";
  }>({ key: "company", direction: "asc" });
  const rows = sortFinancialRows(
    financialRows(matrixAnswerPeriodWindow(companies, metrics, window), metrics, mode),
    sort.key,
    sort.direction,
  );
  const columns: ReadonlyArray<"company" | "period" | MatrixMetricId> =
    mode === "latest" ? ["company", ...metrics] : ["company", "period", ...metrics];
  return (
    <section className="min-w-0 space-y-2" aria-label="Financial comparison table">
      <h4 className="font-medium">Financial comparison</h4>
      <label className="flex flex-wrap items-center gap-2 text-xs">
        Period view{" "}
        <select
          className={CONTROL}
          value={mode}
          onChange={(event) => setMode(event.target.value === "latest" ? "latest" : "exact")}
        >
          <option value="latest">Latest reported per company</option>
          <option value="exact">All exact reporting periods</option>
        </select>
      </label>
      {requestedPeriods ? (
        <div className="flex flex-wrap gap-2">
          <Button
            variant={window ? "secondary" : "ghost"}
            size="compact"
            aria-pressed={!!window}
            onClick={() => {
              setWindow(requestedPeriods);
              setMode("exact");
            }}
          >
            Latest {requestedPeriods} periods per company
          </Button>
          <Button
            variant={window ? "ghost" : "secondary"}
            size="compact"
            aria-pressed={!window}
            onClick={() => {
              setWindow(undefined);
              setMode("exact");
            }}
          >
            All periods
          </Button>
        </div>
      ) : null}
      <p className="text-xs text-muted-foreground">
        {mode === "latest"
          ? "Latest reported values per company and metric. Fiscal periods may differ: each cell shows its exact period, so this is not a calendar-aligned comparison."
          : "Rows preserve exact SEC periods without combining unrelated start/end dates."}{" "}
        USD and percentage columns retain their own units. Missing values sort last, never as zero.
      </p>
      <div
        className="max-w-full overflow-x-auto rounded-lg border border-border"
        tabIndex={0}
        aria-label="Scrollable financial table"
      >
        <table className="w-full text-left text-xs">
          <thead className="bg-muted/30">
            <tr>
              {columns.map((key) => (
                <th
                  className="p-2 align-top"
                  key={key}
                  scope="col"
                  aria-sort={
                    sort.key === key
                      ? sort.direction === "asc"
                        ? "ascending"
                        : "descending"
                      : "none"
                  }
                >
                  <Button
                    variant="ghost"
                    size="compact"
                    onClick={() =>
                      setSort({
                        key,
                        direction: sort.key === key && sort.direction === "asc" ? "desc" : "asc",
                      })
                    }
                  >
                    {key === "company"
                      ? "Company"
                      : key === "period"
                        ? "Period"
                        : `${METRIC_LABELS[key]} (${key.endsWith("Margin") ? "%" : "USD"})`}
                    {sort.key === key ? (sort.direction === "asc" ? " ↑" : " ↓") : ""}
                  </Button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                className="border-t border-border"
                key={`${row.company.symbol}:${row.period ? periodKey(row.period) : "missing"}`}
              >
                <th className="p-3 align-top font-medium" scope="row">
                  {row.company.symbol}
                </th>
                {mode === "exact" ? (
                  <td className="min-w-36 p-3 align-top">
                    {row.period ? periodLabel(row.period) : "No reported period"}
                  </td>
                ) : null}
                {metrics.map((id) => {
                  const cell = row.cells.get(id);
                  return (
                    <td key={id} className="min-w-36 p-3 align-top">
                      {cell ? (
                        <>
                          <p className="mb-1 text-muted-foreground">
                            {periodLabel(cell.observation)}
                          </p>
                          <SourcedValue
                            metric={cell.metric}
                            observation={cell.observation}
                            analyst={analyst}
                          />
                        </>
                      ) : (
                        <span className="text-muted-foreground">
                          {mode === "latest"
                            ? "Not reported"
                            : "Not reported for this exact period"}
                        </span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function FinancialChart({
  companies,
  block,
  analyst,
}: {
  companies: ReadonlyArray<MatrixAnswerCompany>;
  block: Extract<MatrixAnswerBlock, { kind: "chart" }>;
  analyst: boolean;
}) {
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [chartSetting, setChartSetting] = useState({
    source: block.chartType,
    value: block.chartType,
  });
  if (chartSetting.source !== block.chartType)
    setChartSetting({ source: block.chartType, value: block.chartType });
  const chartType = chartSetting.source === block.chartType ? chartSetting.value : block.chartType;
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [window, setWindow] = useState(block.periods);
  const [selected, setSelected] = useState<string | null>(null);
  const [metricSource, setMetricSource] = useState(block.metric);
  if (metricSource !== block.metric) {
    setMetricSource(block.metric);
    setFrom("");
    setTo("");
    setSelected(null);
  }
  const symbols = new Set(
    companies.filter((company) => !hidden.has(company.symbol)).map((company) => company.symbol),
  );
  const all = metricSeries(
    companies,
    block.metric,
    new Set(companies.map((company) => company.symbol)),
  );
  const dates = [
    ...new Set(all.flatMap((series) => series.observations.map((observation) => observation.end))),
  ].toSorted();
  const series = metricSeries(
    matrixAnswerPeriodWindow(companies, [block.metric], window),
    block.metric,
    symbols,
    from,
    to,
  );
  const periods = new Map<string, Observation>();
  for (const item of series)
    for (const observation of item.observations) periods.set(periodKey(observation), observation);
  const keys = [...periods.keys()].toSorted();
  const activeKey = selected && periods.has(selected) ? selected : keys.at(-1);
  const units = [...new Set(series.flatMap((item) => (item.metric ? [item.metric.unit] : [])))];
  const rangeInvalid = !!from && !!to && from > to;
  return (
    <section className="min-w-0 space-y-3" aria-label={`${METRIC_LABELS[block.metric]} chart`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="font-medium">{METRIC_LABELS[block.metric]}</h4>
        <div className="flex gap-1">
          {(["line", "bar"] as const).map((kind) => (
            <Button
              key={kind}
              variant={chartType === kind ? "secondary" : "ghost"}
              size="compact"
              aria-pressed={chartType === kind}
              onClick={() => setChartSetting({ source: block.chartType, value: kind })}
            >
              {kind === "line" ? "Line" : "Bar"}
            </Button>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        {companies.map((company, index) => (
          <Button
            key={company.symbol}
            variant={symbols.has(company.symbol) ? "outline" : "ghost"}
            size="compact"
            aria-pressed={symbols.has(company.symbol)}
            onClick={() =>
              setHidden((previous) => {
                const next = new Set(previous);
                if (next.has(company.symbol)) next.delete(company.symbol);
                else next.add(company.symbol);
                return next;
              })
            }
          >
            <span
              className="size-2 rounded-full"
              style={{ backgroundColor: COLORS[index % COLORS.length] }}
            />
            {company.symbol}
          </Button>
        ))}
      </div>
      <details open={analyst} className="space-y-2 text-xs">
        <summary className="cursor-pointer text-muted-foreground">
          Period controls ·{" "}
          {window
            ? `latest ${window} reported periods per company`
            : from || to
              ? `${from || "earliest"} to ${to || "latest"}`
              : "all reported periods"}
        </summary>
        <div className="flex flex-wrap gap-2 text-xs">
          <label className="flex items-center gap-1">
            From{" "}
            <select
              className={CONTROL}
              value={from}
              onChange={(event) => {
                setFrom(event.target.value);
                setWindow(undefined);
              }}
            >
              <option value="">Earliest</option>
              {dates.map((date) => (
                <option key={date}>{date}</option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1">
            To{" "}
            <select
              className={CONTROL}
              value={to}
              onChange={(event) => {
                setTo(event.target.value);
                setWindow(undefined);
              }}
            >
              <option value="">Latest</option>
              {dates.map((date) => (
                <option key={date}>{date}</option>
              ))}
            </select>
          </label>
          <Button
            variant="ghost"
            size="compact"
            onClick={() => {
              setFrom("");
              setTo("");
              setWindow(undefined);
            }}
          >
            All periods
          </Button>
          {block.periods ? (
            <Button
              variant={window ? "secondary" : "ghost"}
              size="compact"
              aria-pressed={!!window}
              onClick={() => {
                setWindow(block.periods);
                setFrom("");
                setTo("");
              }}
            >
              Latest {block.periods} periods per company
            </Button>
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground">
          Horizontal positions are ordered exact start/end periods (ordinal spacing, not calendar
          spacing), not shared fiscal-year labels. Lines join each company's consecutive reported
          observations; gaps are not zero. Select a point or period for exact sourced values.
        </p>
      </details>
      {rangeInvalid ? (
        <p role="alert" className="text-xs text-destructive">
          Choose a start date no later than the end date.
        </p>
      ) : keys.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No reported values in this range for the selected companies.
        </p>
      ) : (
        units.map((unit) => {
          const matching = series.filter((item) => item.metric?.unit === unit);
          const values = matching.flatMap((item) =>
            item.observations.map((observation) => observation.value),
          );
          const min = Math.min(0, ...values),
            max = Math.max(0, ...values);
          const span = max - min || 1;
          const x = (index: number) => 55 + ((index + 0.5) * 600) / keys.length;
          const y = (value: number) => 25 + ((max - value) / span) * 170;
          return (
            <div
              key={unit}
              className="overflow-hidden rounded-lg border border-border bg-muted/10 p-2"
            >
              <p className="text-xs text-muted-foreground">
                {unit === "percent" ? "Percent (%)" : "US dollars (USD)"} · {keys.length} exact
                periods
              </p>
              <svg
                viewBox="0 0 680 240"
                className="h-auto w-full"
                role="img"
                aria-label={`${METRIC_LABELS[block.metric]}, ${unit}. Exact values and sources below.`}
              >
                <line x1="55" x2="655" y1={y(0)} y2={y(0)} stroke="currentColor" opacity="0.2" />
                {[max, min].map((value, index) => (
                  <text
                    key={index === 0 ? "maximum" : "minimum"}
                    x="4"
                    y={index === 0 ? 20 : 210}
                    fontSize="10"
                    fill="currentColor"
                  >
                    {compactValue(value, unit)}
                  </text>
                ))}
                {matching.map((item, seriesIndex) => {
                  const color =
                    COLORS[
                      companies.findIndex((company) => company.symbol === item.company.symbol) %
                        COLORS.length
                    ];
                  return (
                    <g key={item.company.symbol}>
                      {chartSeriesPoints(item.observations, keys).map(
                        ({ observation, index, previous, previousIndex }) => {
                          const key = periodKey(observation);
                          const width = Math.min(42, 450 / keys.length / matching.length);
                          const center =
                            x(index) +
                            (chartType === "bar"
                              ? (seriesIndex - (matching.length - 1) / 2) * (width + 2)
                              : 0);
                          const label = `${item.company.symbol}, ${periodLabel(observation)}, ${exactValue(observation.value, unit)}`;
                          return (
                            <g key={key}>
                              {chartType === "line" && previous && previousIndex !== null ? (
                                <line
                                  x1={x(previousIndex)}
                                  x2={x(index)}
                                  y1={y(previous.value)}
                                  y2={y(observation.value)}
                                  stroke={color}
                                  strokeWidth="2"
                                />
                              ) : null}
                              {chartType === "bar" ? (
                                <rect
                                  x={center - width / 2}
                                  y={Math.min(y(0), y(observation.value))}
                                  height={Math.max(1, Math.abs(y(observation.value) - y(0)))}
                                  width={width}
                                  fill={color}
                                  opacity="0.75"
                                  onClick={() => setSelected(key)}
                                >
                                  <title>{label}</title>
                                </rect>
                              ) : null}
                              <circle
                                cx={center}
                                cy={y(observation.value)}
                                r={activeKey === key ? 6 : 4}
                                fill={color}
                                stroke="var(--background)"
                                strokeWidth="1"
                                tabIndex={0}
                                role="button"
                                aria-label={label}
                                onClick={() => setSelected(key)}
                                onKeyDown={(event) => {
                                  if (event.key === "Enter" || event.key === " ") {
                                    event.preventDefault();
                                    setSelected(key);
                                  }
                                }}
                              >
                                <title>{label}</title>
                              </circle>
                            </g>
                          );
                        },
                      )}
                    </g>
                  );
                })}
                <text x="55" y="232" fontSize="10" fill="currentColor">
                  {periods.get(keys[0]!)?.end}
                </text>
                <text x="655" y="232" textAnchor="end" fontSize="10" fill="currentColor">
                  {periods.get(keys.at(-1)!)?.end}
                </text>
              </svg>
            </div>
          );
        })
      )}
      {activeKey && !rangeInvalid ? (
        <div className="space-y-2 rounded-lg bg-muted/20 p-3">
          <label className="flex flex-wrap items-center gap-2 text-xs">
            Exact period{" "}
            <select
              className={CONTROL}
              value={activeKey}
              onChange={(event) => setSelected(event.target.value)}
            >
              {keys.map((key) => (
                <option key={key} value={key}>
                  {periodLabel(periods.get(key)!)}
                </option>
              ))}
            </select>
          </label>
          {series.map((item) => {
            const observation = item.observations.find(
              (candidate) => periodKey(candidate) === activeKey,
            );
            return (
              <div key={item.company.symbol} className="min-w-0 text-xs">
                <span className="font-medium">{item.company.symbol}: </span>
                {item.metric && observation ? (
                  <SourcedValue observation={observation} metric={item.metric} analyst={analyst} />
                ) : (
                  <span className="text-muted-foreground">Not reported for this exact period</span>
                )}
              </div>
            );
          })}
        </div>
      ) : null}
      {series
        .filter((item) => item.observations.length === 0)
        .map((item) => (
          <p key={item.company.symbol} className="text-xs text-muted-foreground">
            {item.company.symbol}: no reported {METRIC_LABELS[block.metric].toLowerCase()} in this
            range.
          </p>
        ))}
    </section>
  );
}

function FilingTimeline({
  companies,
  title,
  canvas = false,
}: {
  companies: ReadonlyArray<MatrixAnswerCompany>;
  title: string;
  canvas?: boolean;
}) {
  const filings = companies
    .flatMap((company) => company.filings.map((filing) => ({ company, filing })))
    .toSorted((a, b) => b.filing.filed.localeCompare(a.filing.filed));
  return (
    <section className="space-y-2">
      <h4 className="font-medium">{title}</h4>
      <p className="text-xs text-muted-foreground">
        Recent company filings include all forms. Expand a value for the exact filing behind that
        number.
      </p>
      {companies
        .filter((company) => company.filings.length === 0)
        .map((company) => (
          <p key={company.symbol} className="text-xs text-muted-foreground">
            {company.symbol}: no filings available.
          </p>
        ))}
      <ol
        className={
          canvas
            ? "space-y-3 border-l border-border pl-3"
            : "max-h-80 space-y-3 overflow-y-auto border-l border-border pl-3"
        }
      >
        {filings.map(({ company, filing }) => (
          <li key={`${company.symbol}:${filing.accession}`} className="text-xs">
            <div className="font-medium">
              {company.symbol} · <SourceLink url={filing.url}>{filing.form}</SourceLink>
            </div>
            <p className="text-muted-foreground">
              Filed {filing.filed} · report period {filing.reportDate ?? "not available"}
            </p>
            <p className="break-all text-muted-foreground">Accession {filing.accession}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

function CompanyProfile({ companies }: { companies: ReadonlyArray<MatrixAnswerCompany> }) {
  return (
    <section className="min-w-0 space-y-3" aria-label="Company profile">
      {companies.map((company) => (
        <div key={company.symbol} className="min-w-0 rounded-lg border border-border p-3">
          <h4 className="break-words font-semibold">{company.profile?.name ?? company.name}</h4>
          <p className="text-xs text-muted-foreground">
            {company.symbol} · CIK {company.cik}
          </p>
          {company.profile ? (
            <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs">
              <dt>Industry</dt>
              <dd className="break-words">{company.profile.industry ?? "Not reported"}</dd>
              <dt>Exchanges</dt>
              <dd className="break-words">
                {company.profile.exchanges.join(", ") || "Not reported"}
              </dd>
              <dt>Tickers</dt>
              <dd className="break-words">
                {company.profile.tickers.join(", ") || "Not reported"}
              </dd>
              <dt>SIC</dt>
              <dd>{company.profile.sic ?? "Not reported"}</dd>
              <dt>Fiscal year end</dt>
              <dd>{company.profile.fiscalYearEnd ?? "Not reported"}</dd>
            </dl>
          ) : (
            <p className="mt-2 text-xs text-muted-foreground">
              Extended SEC profile unavailable for this saved answer.
            </p>
          )}
          <p className="mt-2 text-xs text-muted-foreground">
            Company identity from SEC data. Expand sources below for provenance and freshness.
          </p>
        </div>
      ))}
    </section>
  );
}

function QualitativeDiagram({ block }: { block: Extract<MatrixAnswerBlock, { kind: "diagram" }> }) {
  const layout = matrixDiagramLayout(block);
  const [selectedId, setSelectedId] = useState(block.nodes[0]?.id);
  const selected = block.nodes.find((node) => node.id === selectedId) ?? block.nodes[0];
  return (
    <section className="min-w-0 space-y-2">
      <h4 className="font-medium">{block.title}</h4>
      <p className="text-xs text-muted-foreground">
        Qualitative interpretation · not a reported allocation or quantitative breakdown. Select a
        node to explore.
      </p>
      {layout ? (
        <div
          className="max-w-full overflow-x-auto rounded-lg border border-border"
          tabIndex={0}
          aria-label="Scrollable qualitative diagram"
        >
          <div className="relative" style={{ width: layout.width, height: layout.height }}>
            <svg
              width={layout.width}
              height={layout.height}
              className="pointer-events-none absolute inset-0"
              aria-hidden
            >
              {layout.edges.map((edge) => (
                <g key={`${edge.from.x}:${edge.from.y}:${edge.to.x}:${edge.to.y}`}>
                  <path
                    d={`M ${edge.from.x} ${edge.from.y} L ${edge.to.x} ${edge.to.y}`}
                    fill="none"
                    stroke="currentColor"
                    className="text-muted-foreground"
                  />
                  <path
                    d={`M ${edge.to.x - 4} ${edge.to.y - 7} L ${edge.to.x} ${edge.to.y} L ${edge.to.x + 4} ${edge.to.y - 7}`}
                    fill="none"
                    stroke="currentColor"
                    className="text-muted-foreground"
                  />
                  {edge.label ? (
                    <text
                      x={(edge.from.x + edge.to.x) / 2}
                      y={(edge.from.y + edge.to.y) / 2 - 4}
                      textAnchor="middle"
                      fill="currentColor"
                      className="text-3xs"
                    >
                      {edge.label}
                    </text>
                  ) : null}
                </g>
              ))}
            </svg>
            {layout.nodes.map((position) => {
              const node = block.nodes.find((candidate) => candidate.id === position.id)!;
              return (
                <button
                  key={node.id}
                  type="button"
                  aria-pressed={selected?.id === node.id}
                  onClick={() => setSelectedId(node.id)}
                  className={`absolute overflow-y-auto break-words rounded-lg border p-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${selected?.id === node.id ? "border-primary bg-primary/10" : "border-border bg-card"}`}
                  style={{
                    left: position.x,
                    top: position.y,
                    width: position.width,
                    height: position.height,
                  }}
                >
                  {node.label}
                </button>
              );
            })}
          </div>
        </div>
      ) : (
        <p role="status" className="text-xs text-muted-foreground">
          Diagram connections unavailable. All explanations remain below.
        </p>
      )}
      {layout && selected ? (
        <div
          className="sticky bottom-0 max-h-32 overflow-y-auto rounded-lg border border-border bg-card p-3"
          aria-live="polite"
        >
          <h5 className="font-medium">{selected.label}</h5>
          <p className="mt-1 whitespace-pre-wrap break-words text-muted-foreground">
            {selected.detail}
          </p>
        </div>
      ) : (
        block.nodes.map((node) => (
          <details key={node.id}>
            <summary className="cursor-pointer">{node.label}</summary>
            <p className="whitespace-pre-wrap break-words">{node.detail}</p>
          </details>
        ))
      )}
    </section>
  );
}

function FollowUpActions({
  block,
  environmentId,
  threadId,
  onAsk,
}: {
  block: Extract<MatrixAnswerBlock, { kind: "actions" }>;
  environmentId?: EnvironmentId | undefined;
  threadId: ThreadId;
  onAsk?: (prompt: string) => void;
}) {
  return (
    <section className="min-w-0 space-y-2">
      <h4 className="font-medium">{block.title}</h4>
      {onAsk ? (
        <div className="flex flex-wrap gap-2">
          {block.prompts.map((prompt) => (
            <Button
              key={prompt}
              variant="outline"
              size="sm-multiline"
              onClick={() => onAsk(prompt)}
            >
              {prompt}
            </Button>
          ))}
        </div>
      ) : environmentId ? (
        <ConnectedFollowUpActions block={block} environmentId={environmentId} threadId={threadId} />
      ) : (
        <p className="text-xs text-muted-foreground">
          Open this answer in its conversation to ask a follow-up.
        </p>
      )}
    </section>
  );
}

function ConnectedFollowUpActions({
  block,
  environmentId,
  threadId,
}: {
  block: Extract<MatrixAnswerBlock, { kind: "actions" }>;
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  const canSend = useAtomValue(
    orchestrationEnvironment.v2.dispatchCommand.permissionAtom(environmentId, {
      type: "message.dispatch",
    }),
  );
  const dispatch = useOrchestrationCommand(orchestrationEnvironment.v2.dispatchCommand, {
    reportFailure: false,
  });
  const sending = useRef(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const send = async (prompt: string) => {
    if (sending.current || !canSend) return;
    sending.current = true;
    setPending(prompt);
    setError(null);
    setSent(null);
    try {
      const result = await dispatch({
        environmentId,
        input: {
          type: "message.dispatch",
          commandId: CommandId.make(randomUUID()),
          createdBy: "user",
          creationSource: "web",
          threadId,
          messageId: MessageId.make(randomUUID()),
          text: prompt,
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
        },
      });
      if (result._tag === "Failure") {
        const failure = squashAtomCommandFailure(result);
        setError(
          failure instanceof Error
            ? failure.message
            : "Could not send the follow-up. Please try again.",
        );
      } else setSent(prompt);
    } finally {
      sending.current = false;
      setPending(null);
    }
  };
  return (
    <div className="min-w-0 space-y-2">
      {block.prompts.map((prompt) => (
        <Button
          key={prompt}
          variant="outline"
          size="sm-multiline"
          className="w-full justify-start whitespace-pre-wrap break-words text-left"
          disabled={!canSend || pending !== null}
          onClick={() => void send(prompt)}
        >
          {prompt}
        </Button>
      ))}
      {!canSend ? (
        <p className="text-xs text-muted-foreground">
          Follow-ups require permission to operate this conversation.
        </p>
      ) : null}
      {pending ? (
        <p role="status" className="text-xs text-muted-foreground">
          Sending follow-up…
        </p>
      ) : null}
      {sent ? (
        <p role="status" className="text-xs text-muted-foreground">
          Follow-up sent to this conversation.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
export function MatrixAnswerView({
  answer,
  environmentId,
  pinPending,
  pinError,
  canPin,
  onPin,
  onOpenWorkspace,
  layout = "card",
  onAsk,
  onViewChange,
  viewPending = false,
  viewError = null,
  canSaveView = false,
  onRetryView,
}: {
  answer: MatrixAnswer;
  environmentId?: EnvironmentId;
  pinPending: boolean;
  pinError: string | null;
  canPin: boolean;
  onPin: () => void;
  onOpenWorkspace?: () => void;
  layout?: "card" | "canvas";
  onAsk?: (prompt: string) => void;
  onViewChange?: (datasetId: string, view: MatrixResearchView) => void;
  viewPending?: boolean;
  viewError?: string | null;
  canSaveView?: boolean;
  onRetryView?: () => void;
}) {
  const [levelSetting, setLevel] = useState({
    source: answer.spec.level,
    value: answer.spec.level,
  });
  if (levelSetting.source !== answer.spec.level)
    setLevel({ source: answer.spec.level, value: answer.spec.level });
  const level = levelSetting.source === answer.spec.level ? levelSetting.value : answer.spec.level;
  const analyst = level === "analyst";
  const canvas =
    layout === "canvas" || Boolean(answer.spec.blocks.some((block) => "dataset" in block));
  const sections = matrixAnswerSections(answer.spec);
  const [selectedSectionId, setSelectedSectionId] = useState(sections[0]?.id);
  const [presentationRun, setPresentationRun] = useState(answer.lastPresentedRunId);
  if (presentationRun !== answer.lastPresentedRunId) {
    setPresentationRun(answer.lastPresentedRunId);
    setSelectedSectionId(sections[0]?.id);
  }
  const selectedSection =
    sections.find((section) => section.id === selectedSectionId) ?? sections[0];
  const summaryPreview = matrixSummaryPreview(answer.spec.summary);
  const instanceId = useId();
  return (
    <ResearchCanvas answer={answer} analyst={analyst} {...(onViewChange ? { onViewChange } : {})}>
      <article
        className={
          canvas
            ? "min-w-0 space-y-6 text-sm"
            : "flex max-h-[65svh] min-w-0 flex-col gap-3 overflow-hidden rounded-xl border border-border bg-card p-3 text-sm sm:p-5"
        }
        aria-label={answer.spec.title}
      >
        <header className="shrink-0 space-y-2">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium text-muted-foreground">
                {canvas ? "Research brief" : `Matrix research · revision ${answer.revision}`}
              </p>
              <h3
                className={
                  canvas
                    ? "break-words text-2xl font-semibold sm:text-3xl"
                    : "break-words text-lg font-semibold"
                }
              >
                {answer.spec.title}
              </h3>
            </div>
            <Button
              variant={answer.pinned ? "secondary" : "outline"}
              size="sm"
              disabled={pinPending || !canPin}
              onClick={onPin}
              aria-pressed={answer.pinned}
            >
              {pinPending ? "Saving…" : answer.pinned ? "Unpin" : "Pin"}
            </Button>
          </div>
          <div>
            <details className="group text-muted-foreground" open={canvas}>
              <summary className="list-none cursor-pointer break-words">
                <span className="line-clamp-2 group-open:hidden">{summaryPreview}</span>
                <span className="text-xs underline group-open:hidden">
                  Interpretation · read conclusion
                </span>
                <span className="hidden text-xs underline group-open:inline">Hide conclusion</span>
              </summary>
              <p
                className={
                  canvas
                    ? "mt-2 max-w-5xl whitespace-pre-wrap break-words leading-relaxed"
                    : "mt-2 max-h-36 overflow-y-auto whitespace-pre-wrap break-words"
                }
              >
                {answer.spec.summary}
              </p>
            </details>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div
              className="flex rounded-lg border border-border p-0.5"
              aria-label="Explanation detail"
            >
              {(["guided", "analyst"] as const).map((value) => (
                <Button
                  key={value}
                  variant={level === value ? "secondary" : "ghost"}
                  size="compact"
                  aria-pressed={level === value}
                  onClick={() => setLevel({ source: answer.spec.level, value })}
                >
                  {value === "guided" ? "Guided" : "Analyst"}
                </Button>
              ))}
            </div>
            {onOpenWorkspace ? (
              <Button variant="ghost" size="compact" onClick={onOpenWorkspace}>
                Pinned workspace
              </Button>
            ) : null}
          </div>
          {!canPin ? (
            <p className="text-xs text-muted-foreground">
              Pinning requires permission to operate this conversation.
            </p>
          ) : null}
          {pinError ? (
            <p role="alert" className="text-xs text-destructive">
              {pinError}
            </p>
          ) : null}
          {analyst ? (
            <p className="text-xs text-muted-foreground">
              Updated {answer.updatedAt} · created {answer.createdAt}
            </p>
          ) : null}
        </header>
        <ResearchCanvasControls />
        {answer.datasets?.length ? (
          <div
            className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground"
            aria-live="polite"
          >
            <span>
              {viewPending
                ? "Saving view…"
                : canSaveView
                  ? "Country, year and measure selections save to this conversation."
                  : "Explore this view locally. Saving requires permission to operate this conversation."}
            </span>
            {viewError ? (
              <>
                <span role="alert" className="text-destructive">
                  {viewError}
                </span>
                {onRetryView ? (
                  <Button
                    variant="outline"
                    size="compact"
                    disabled={viewPending}
                    onClick={onRetryView}
                  >
                    Retry saving view
                  </Button>
                ) : null}
              </>
            ) : null}
          </div>
        ) : null}
        {answer.companies.length === 0 &&
        answer.spec.blocks.some((block) =>
          ["company", "metric", "chart", "table", "filings"].includes(block.kind),
        ) ? (
          <p className="text-muted-foreground">
            No company data is available. No substitute values were used.
          </p>
        ) : null}
        {answer.spec.symbols
          .filter((symbol) => !answer.companies.some((company) => company.symbol === symbol))
          .map((symbol) => (
            <p key={symbol} className="text-xs text-muted-foreground">
              {symbol}: company data unavailable.
            </p>
          ))}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
          {!canvas ? (
            <div
              role="tablist"
              aria-label="Research sections"
              className="flex max-w-full shrink-0 gap-1 overflow-x-auto border-b border-border pb-2"
            >
              {sections.map((section, index) => (
                <Button
                  key={section.id}
                  role="tab"
                  size="sm"
                  id={`${instanceId}-tab-${section.id}`}
                  aria-controls={`${instanceId}-panel-${section.id}`}
                  aria-selected={selectedSection?.id === section.id}
                  tabIndex={selectedSection?.id === section.id ? 0 : -1}
                  variant={selectedSection?.id === section.id ? "secondary" : "ghost"}
                  className="shrink-0"
                  onClick={() => setSelectedSectionId(section.id)}
                  onKeyDown={(event) => {
                    const nextIndex =
                      event.key === "ArrowRight"
                        ? (index + 1) % sections.length
                        : event.key === "ArrowLeft"
                          ? (index + sections.length - 1) % sections.length
                          : event.key === "Home"
                            ? 0
                            : event.key === "End"
                              ? sections.length - 1
                              : null;
                    if (nextIndex === null) return;
                    event.preventDefault();
                    const next = sections[nextIndex]!;
                    setSelectedSectionId(next.id);
                    document.getElementById(`${instanceId}-tab-${next.id}`)?.focus();
                  }}
                >
                  {section.label}
                </Button>
              ))}
            </div>
          ) : null}
          {sections.map((section) => (
            <div
              key={section.id}
              role={canvas ? "region" : "tabpanel"}
              id={`${instanceId}-panel-${section.id}`}
              aria-labelledby={
                canvas ? `${instanceId}-heading-${section.id}` : `${instanceId}-tab-${section.id}`
              }
              hidden={!canvas && selectedSection?.id !== section.id}
              tabIndex={0}
              className={
                canvas
                  ? "@container min-w-0 space-y-4"
                  : "@container min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              }
            >
              {canvas ? (
                <h3
                  id={`${instanceId}-heading-${section.id}`}
                  className={
                    sections.length > 1
                      ? "border-b border-border pb-2 text-xs font-semibold uppercase tracking-widest text-muted-foreground"
                      : "sr-only"
                  }
                >
                  {section.label}
                </h3>
              ) : null}
              <div
                className={`grid min-w-0 gap-5 ${section.columns === 3 ? "@3xl:grid-cols-2 @6xl:grid-cols-3" : section.columns === 2 ? "@3xl:grid-cols-2" : "grid-cols-1"}`}
              >
                {section.blockIds.map((id) => {
                  const block = answer.spec.blocks.find((candidate) => candidate.id === id);
                  if (!block) return null;
                  return (
                    <div
                      key={`${block.id}:${answer.lastPresentedRunId ?? ""}`}
                      className={canvas ? "min-w-0" : "min-w-0 rounded-lg border border-border p-3"}
                    >
                      {"dataset" in block ? (
                        <ResearchBlockView block={block} />
                      ) : block.kind === "company" ? (
                        <CompanyProfile companies={answer.companies} />
                      ) : block.kind === "diagram" ? (
                        <QualitativeDiagram block={block} />
                      ) : block.kind === "actions" ? (
                        <FollowUpActions
                          block={block}
                          environmentId={environmentId}
                          threadId={answer.threadId}
                          {...(onAsk ? { onAsk } : {})}
                        />
                      ) : block.kind === "metric" ? (
                        <MetricCards
                          companies={answer.companies}
                          metricId={block.metric}
                          analyst={analyst}
                        />
                      ) : block.kind === "chart" ? (
                        <FinancialChart
                          key={`${block.metric}:${block.periods}`}
                          companies={answer.companies}
                          block={block}
                          analyst={analyst}
                        />
                      ) : block.kind === "table" ? (
                        <FinancialTable
                          key={`${block.metrics.join(",")}:${block.periods}`}
                          requestedPeriods={block.periods}
                          companies={answer.companies}
                          metrics={block.metrics}
                          analyst={analyst}
                        />
                      ) : block.kind === "filings" ? (
                        <FilingTimeline
                          companies={answer.companies}
                          title={block.title}
                          canvas={canvas}
                        />
                      ) : (
                        <section>
                          <p className="text-xs text-muted-foreground">
                            Interpretation · not a reported financial fact
                          </p>
                          <h4 className="font-medium">{block.title}</h4>
                          <p className="mt-2 whitespace-pre-wrap break-words text-muted-foreground">
                            {block.text}
                          </p>
                        </section>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
        {answer.companies.length > 0 ? (
          <footer
            className={
              canvas
                ? "space-y-3 border-t border-border pt-3"
                : "max-h-[25svh] shrink-0 space-y-3 overflow-y-auto border-t border-border pt-3"
            }
          >
            <details>
              <summary className="cursor-pointer text-xs text-muted-foreground">
                SEC sources & data limits (
                {answer.companies.reduce((count, company) => count + company.warnings.length, 0)}{" "}
                warnings)
              </summary>
              <div className="mt-3 space-y-3">
                {answer.companies.map((company) => (
                  <div key={company.symbol} className="space-y-2 text-xs">
                    {company.warnings.length ? (
                      <details className="rounded-md border border-warning/30 bg-warning/5 p-2">
                        <summary className="cursor-pointer font-medium">
                          {company.symbol} · data warnings ({company.warnings.length})
                        </summary>
                        <ul
                          className={
                            canvas
                              ? "mt-2 list-disc space-y-1 pl-4"
                              : "mt-2 max-h-64 list-disc space-y-1 overflow-y-auto pl-4"
                          }
                        >
                          {company.warnings.map((warning) => (
                            <li key={warning}>{warning}</li>
                          ))}
                        </ul>
                      </details>
                    ) : null}
                    <details open={analyst}>
                      <summary className="cursor-pointer text-muted-foreground">
                        {company.symbol} · sources & freshness
                      </summary>
                      <div className="mt-2 space-y-1 break-words text-muted-foreground">
                        <p>
                          {company.name} · CIK {company.cik}
                        </p>
                        {company.sources.length ? (
                          company.sources.map((source) => (
                            <p key={`${source.url}:${source.label}`}>
                              <SourceLink url={source.url}>{source.label}</SourceLink> · retrieved{" "}
                              {source.fetchedAt}
                            </p>
                          ))
                        ) : (
                          <p>Source retrieval timestamp unavailable.</p>
                        )}
                      </div>
                    </details>
                  </div>
                ))}
                {!analyst ? (
                  <p className="text-xs text-muted-foreground">
                    Guided view: expand any number for its exact value, reporting period and SEC
                    filing. Analyst view opens provenance by default. Margins are percentages, not
                    dollar amounts.
                  </p>
                ) : null}
              </div>
            </details>
          </footer>
        ) : null}
        <ResearchCanvasSources />
      </article>
    </ResearchCanvas>
  );
}

interface ConnectedAnswerProps {
  environmentId: EnvironmentId;
  answer: MatrixAnswer;
  onOpenWorkspace?: () => void;
  layout?: "card" | "canvas";
  onAsk?: (prompt: string) => void;
}

export function ConnectedAnswer(props: ConnectedAnswerProps) {
  const { environmentId, answer } = props;
  return (
    <ConnectedAnswerSession
      key={`${environmentId}:${answer.threadId}:${answer.id}:${answer.lastPresentedRunId ?? answer.createdAt}`}
      {...props}
    />
  );
}

function ConnectedAnswerSession({
  environmentId,
  answer,
  onOpenWorkspace,
  layout,
  onAsk,
}: ConnectedAnswerProps) {
  const [saved, setSaved] = useState<MatrixAnswer | null>(null);
  const current =
    saved && saved.id === answer.id && saved.revision > answer.revision ? saved : answer;
  const latest = useRef(current);
  const input = {
    threadId: current.threadId,
    answerId: current.id,
    expectedRevision: current.revision,
    pinned: !current.pinned,
  };
  const canPin = useAtomValue(matrixEnvironment.setPinned.permissionAtom(environmentId, input));
  const canSaveView = useAtomValue(
    matrixEnvironment.setView.permissionAtom(environmentId, {
      threadId: current.threadId,
      answerId: current.id,
      expectedRevision: current.revision,
      datasetId: current.datasets?.[0]?.id ?? "unavailable",
      view: { entities: [], year: null, measure: null },
    }),
  );
  const setPinned = useAtomCommand(matrixEnvironment.setPinned, { reportFailure: false });
  const setView = useAtomCommand(matrixEnvironment.setView, { reportFailure: false });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewPending, setViewPending] = useState(false);
  const [viewError, setViewError] = useState<string | null>(null);
  const [queuedViews, setQueuedViews] = useState<Record<string, MatrixResearchView>>({});
  // State drives saving UI; the transport copy also sees edits made before React commits.
  const queue = useRef<Record<string, MatrixResearchView>>({});
  const saving = useRef(false);
  const mounted = useRef(false);
  const queued = Object.keys(queuedViews).length > 0;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!canSaveView || pending || viewPending || saving.current || viewError || !queued) return;
    const entry = Object.entries(queue.current)[0];
    if (!entry) return;
    const [datasetId, view] = entry;
    const source = current.revision > latest.current.revision ? current : latest.current;
    latest.current = source;
    saving.current = true;
    setViewPending(true);
    void (async () => {
      try {
        const result = await setView({
          environmentId,
          input: {
            threadId: source.threadId,
            answerId: source.id,
            expectedRevision: source.revision,
            datasetId,
            view,
          },
        });
        if (!mounted.current) return;
        if (result._tag === "Failure") {
          const failure = squashAtomCommandFailure(result);
          setViewError(
            failure instanceof Error
              ? failure.message
              : "View could not be saved. Reconnect to read the latest revision, then retry.",
          );
        } else {
          if (result.value.revision > latest.current.revision) latest.current = result.value;
          setSaved((previous) =>
            previous && previous.revision > result.value.revision ? previous : result.value,
          );
          if (queue.current[datasetId] === view) {
            const remaining = { ...queue.current };
            delete remaining[datasetId];
            queue.current = remaining;
            setQueuedViews(remaining);
          }
        }
      } catch (cause) {
        if (mounted.current)
          setViewError(
            cause instanceof Error
              ? cause.message
              : "View could not be saved. Your local selection is still visible.",
          );
      } finally {
        saving.current = false;
        if (mounted.current) setViewPending(false);
      }
    })();
  }, [canSaveView, pending, viewPending, viewError, queued, current, environmentId, setView]);
  const pin = async () => {
    if (
      !mounted.current ||
      saving.current ||
      (Object.keys(queue.current).length > 0 && canSaveView && !viewError) ||
      !canPin
    )
      return;
    const source = current.revision > latest.current.revision ? current : latest.current;
    latest.current = source;
    saving.current = true;
    setPending(true);
    setError(null);
    try {
      const result = await setPinned({
        environmentId,
        input: {
          threadId: source.threadId,
          answerId: source.id,
          expectedRevision: source.revision,
          pinned: !source.pinned,
        },
      });
      if (!mounted.current) return;
      if (result._tag === "Failure") {
        const failure = squashAtomCommandFailure(result);
        setError(
          failure instanceof Error
            ? failure.message
            : "Could not save this pin. Read the latest revision and try again.",
        );
      } else {
        if (result.value.revision > latest.current.revision) latest.current = result.value;
        setSaved((previous) =>
          previous && previous.revision > result.value.revision ? previous : result.value,
        );
      }
    } catch (cause) {
      if (mounted.current)
        setError(
          cause instanceof Error
            ? cause.message
            : "Could not save this pin. Read the latest revision and try again.",
        );
    } finally {
      saving.current = false;
      if (mounted.current) setPending(false);
    }
  };
  return (
    <MatrixAnswerView
      environmentId={environmentId}
      answer={current}
      canPin={canPin}
      pinPending={pending || viewPending || (queued && canSaveView && !viewError)}
      pinError={error}
      onPin={() => void pin()}
      canSaveView={canSaveView}
      viewPending={viewPending || (queued && canSaveView && !viewError)}
      viewError={viewError}
      onViewChange={(datasetId, view) => {
        if (!mounted.current || !canSaveView) return;
        const views = { ...queue.current, [datasetId]: view };
        queue.current = views;
        setQueuedViews(views);
        setViewError(null);
      }}
      onRetryView={() => {
        setViewError(null);
      }}
      {...(layout ? { layout } : {})}
      {...(onAsk ? { onAsk } : {})}
      {...(onOpenWorkspace ? { onOpenWorkspace } : {})}
    />
  );
}

export function MatrixAnswerCard({
  environmentId,
  answer,
  layout,
  onAsk,
}: {
  environmentId: EnvironmentId;
  answer: MatrixAnswer;
  layout?: "card" | "canvas";
  onAsk?: (prompt: string) => void;
}) {
  const [open, setOpen] = useState(false);
  // This subscription covers the whole durable thread, not the paginated chat window.
  const workspace = useEnvironmentQuery(
    matrixEnvironment.workspace({ environmentId, input: { threadId: answer.threadId } }),
  );
  const live = workspace.data?.answers.find((candidate) => candidate.id === answer.id);
  const current = live && live.revision > answer.revision ? live : answer;
  return (
    <>
      <ConnectedAnswer
        environmentId={environmentId}
        answer={current}
        onOpenWorkspace={() => setOpen(true)}
        {...(layout ? { layout } : {})}
        {...(onAsk ? { onAsk } : {})}
      />
      <MatrixWorkspaceDialog
        environmentId={environmentId}
        threadId={answer.threadId}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
}

function MatrixWorkspaceDialog({
  environmentId,
  threadId,
  open,
  onOpenChange,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const workspace = useEnvironmentQuery(
    open ? matrixEnvironment.workspace({ environmentId, input: { threadId } }) : null,
  );
  const [tab, setTab] = useState<"pinned" | "all">("pinned");
  const answers = workspace.data?.answers ?? [];
  const pinned = answers.filter((candidate) => candidate.pinned);
  const visible = (tab === "pinned" ? pinned : answers).toSorted((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt),
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="w-[calc(100vw-2rem)] max-w-5xl" bottomStickOnMobile={false}>
        <DialogHeader>
          <DialogTitle>Research workspace</DialogTitle>
          <DialogDescription>
            Saved to this conversation, including answers outside the loaded chat history. Pins
            reload with the thread.
          </DialogDescription>
          <div className="flex flex-wrap gap-2" aria-label="Research answer view">
            <Button
              variant={tab === "pinned" ? "secondary" : "ghost"}
              size="sm"
              aria-pressed={tab === "pinned"}
              onClick={() => setTab("pinned")}
            >
              Pinned ({pinned.length})
            </Button>
            <Button
              variant={tab === "all" ? "secondary" : "ghost"}
              size="sm"
              aria-pressed={tab === "all"}
              onClick={() => setTab("all")}
            >
              All answers ({answers.length})
            </Button>
          </div>
        </DialogHeader>
        <DialogPanel>
          {workspace.error ? (
            <div className="space-y-2">
              <p role="alert" className="text-xs text-destructive">
                {workspace.error}
              </p>
              <Button variant="outline" size="sm" onClick={workspace.refresh}>
                Reconnect workspace
              </Button>
            </div>
          ) : null}
          {!workspace.data && !workspace.error ? (
            <p role="status" className="text-sm text-muted-foreground">
              Loading saved answers…
            </p>
          ) : null}
          {workspace.data && visible.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border p-6 text-sm text-muted-foreground">
              {tab === "pinned"
                ? "No pinned answers yet. Pin an answer in the chat or All answers to keep its interactive charts and sources here."
                : "No research answers have been saved to this conversation yet."}
            </p>
          ) : null}
          <div className="min-w-0 space-y-4">
            {visible.map((candidate) => (
              <ConnectedAnswer
                key={candidate.id}
                environmentId={environmentId}
                answer={candidate}
              />
            ))}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Close workspace
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export function MatrixWorkspaceButton({
  environmentId,
  threadId,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        title="Open research workspace"
        aria-label="Open research workspace"
        onClick={() => setOpen(true)}
      >
        <PinIcon className="size-4" aria-hidden />
        <span className="hidden sm:inline">Research</span>
      </Button>
      <MatrixWorkspaceDialog
        environmentId={environmentId}
        threadId={threadId}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
}
