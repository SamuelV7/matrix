import {
  createContext,
  useContext,
  useId,
  useLayoutEffect,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import type {
  MatrixAnswer,
  MatrixResearchBlock,
  MatrixResearchDataset,
  MatrixResearchView,
  MatrixResearchMeasure,
} from "@t3tools/contracts";
import {
  formatResearchValue,
  formatResearchDifference,
  isResearchPercentageUnit,
  researchChange,
  researchBlockTitle,
  researchObservation,
  researchSeries,
  researchSeriesSegments,
  resolveResearchView,
  type ResolvedResearchView as ResolvedView,
  type ResearchPoint,
} from "@t3tools/shared/matrixResearch";
import { matrixWorldMap } from "@t3tools/shared/matrixWorldMap";
import { Button } from "../components/ui/button";
import { observeResize } from "../lib/observeResize";
import {
  RESEARCH_COLORS,
  researchFill,
  researchScale,
  researchYearRows,
  sortResearchRows,
  toggleResearchEntity,
  researchTablePage,
} from "./researchCanvas.logic";

const CONTROL =
  "min-h-9 rounded-lg border border-border bg-background px-3 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";
interface ResearchContextValue {
  answer: MatrixAnswer;
  analyst: boolean;
  exact: boolean;
  setExact: (value: boolean) => void;
  view: (dataset: MatrixResearchDataset) => ResolvedView;
  update: (dataset: MatrixResearchDataset, patch: Partial<MatrixResearchView>) => void;
}
const ResearchContext = createContext<ResearchContextValue | null>(null);
function useResearch() {
  const context = useContext(ResearchContext);
  if (!context) throw new Error("Research blocks require a research canvas.");
  return context;
}

export interface ResearchCanvasProps {
  answer: MatrixAnswer;
  analyst?: boolean;
  children: ReactNode;
  onViewChange?: (datasetId: string, view: MatrixResearchView) => void;
}

export function ResearchCanvas({
  answer,
  children,
  onViewChange,
  analyst = false,
}: ResearchCanvasProps) {
  const source = `${answer.id}:${answer.lastPresentedRunId ?? answer.createdAt}`;
  const [precision, setPrecision] = useState({ analyst, exact: analyst });
  const exact = precision.analyst === analyst ? precision.exact : analyst;
  if (precision.analyst !== analyst) setPrecision({ analyst, exact: analyst });
  const [local, setLocal] = useState<{ source: string; views: Record<string, MatrixResearchView> }>(
    { source, views: {} },
  );
  if (local.source !== source) setLocal({ source, views: {} });
  const views = local.source === source ? local.views : {};
  const view = (dataset: MatrixResearchDataset) => {
    const map = answer.spec.blocks.find(
      (block) => block.kind === "map" && block.dataset === dataset.id,
    );
    return resolveResearchView(
      dataset,
      answer.spec.queries?.find((query) => query.id === dataset.id),
      views[dataset.id] ?? answer.views?.find((saved) => saved.datasetId === dataset.id)?.view,
      map?.kind === "map" ? map.measure : undefined,
    );
  };
  const update = (dataset: MatrixResearchDataset, patch: Partial<MatrixResearchView>) => {
    const next = { ...view(dataset), ...patch };
    setLocal((previous) => ({
      source,
      views: { ...(previous.source === source ? previous.views : {}), [dataset.id]: next },
    }));
    onViewChange?.(dataset.id, next);
  };
  return (
    <ResearchContext.Provider
      value={{
        answer,
        analyst,
        exact,
        setExact: (value) => setPrecision({ analyst, exact: value }),
        view,
        update,
      }}
    >
      {children}
    </ResearchContext.Provider>
  );
}

export function ResearchCanvasControls() {
  const { answer, view, update, exact, setExact } = useResearch();
  const datasets = answer.datasets?.filter((dataset) =>
    answer.spec.blocks.some((block) => "dataset" in block && block.dataset === dataset.id),
  );
  if (!datasets?.length) return null;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>Linked country, year and measure controls</span>
        <label className="flex items-center gap-2">
          Value precision
          <select
            className={CONTROL}
            value={exact ? "exact" : "rounded"}
            onChange={(event) => setExact(event.target.value === "exact")}
          >
            <option value="rounded">Readable · rounded</option>
            <option value="exact">Exact source precision</option>
          </select>
        </label>
      </div>
      {datasets.map((dataset) => (
        <DatasetControls
          key={dataset.id}
          dataset={dataset}
          view={view(dataset)}
          onChange={(patch) => update(dataset, patch)}
        />
      ))}
    </div>
  );
}

function DatasetControls({
  dataset,
  view,
  onChange,
}: {
  dataset: MatrixResearchDataset;
  view: ResolvedView;
  onChange: (patch: Partial<MatrixResearchView>) => void;
}) {
  const [search, setSearch] = useState("");
  const observationYears = dataset.observations.map((row) => row.year);
  const firstYear = observationYears.length ? Math.min(...observationYears) : dataset.defaultYear;
  const lastYear = observationYears.length ? Math.max(...observationYears) : dataset.defaultYear;
  const years = Array.from({ length: lastYear - firstYear + 1 }, (_, index) => firstYear + index);
  const id = useId();
  const countries = dataset.entities.filter(
    (entity) => entity.iso3 && entity.name.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <section
      aria-label={`${dataset.title} controls`}
      className="space-y-4 rounded-xl border border-border bg-muted/15 p-4"
    >
      <div className="flex flex-wrap items-end gap-4">
        <label className="flex min-w-44 flex-1 flex-col gap-1 text-xs text-muted-foreground">
          Map & comparison measure
          <select
            className={CONTROL}
            value={view.measure}
            onChange={(event) => onChange({ measure: event.target.value })}
          >
            {dataset.measures.map((measure) => (
              <option key={measure.id} value={measure.id}>
                {measure.label} · {measure.unit}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Year
          <select
            className={CONTROL}
            value={view.year}
            onChange={(event) => onChange({ year: Number(event.target.value) })}
          >
            {years.toReversed().map((year) => (
              <option key={year} value={year}>
                {year}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-w-40 flex-1 flex-col gap-2 text-xs text-muted-foreground">
          Annual timeline · {view.year}
          <input
            className="h-9 w-full accent-primary"
            aria-label="Research year"
            type="range"
            min={years[0]}
            max={years.at(-1)}
            step={1}
            value={view.year}
            onChange={(event) => onChange({ year: Number(event.target.value) })}
          />
        </label>
        {dataset.entities.some((entity) => entity.id === "OWID_WRL") ? (
          <Button variant="outline" size="sm" onClick={() => onChange({ entities: ["OWID_WRL"] })}>
            World reset
          </Button>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2" aria-label="Compared countries">
        <span className="mr-1 text-xs text-muted-foreground">Compare {view.entities.length}/6</span>
        {view.entities.map((id, index) => (
          <button
            key={id}
            type="button"
            className="rounded-full border border-border px-3 py-1 text-xs focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            style={{ borderColor: RESEARCH_COLORS[index] }}
            aria-label={`Remove ${dataset.entities.find((entity) => entity.id === id)?.name ?? id} from comparison`}
            onClick={() => onChange({ entities: view.entities.filter((entity) => entity !== id) })}
          >
            {dataset.entities.find((entity) => entity.id === id)?.name ?? id} ×
          </button>
        ))}
        {!view.entities.length ? (
          <span className="text-xs text-muted-foreground">
            Select a country on the map or below.
          </span>
        ) : null}
      </div>
      <details className="text-xs">
        <summary className="cursor-pointer text-muted-foreground">
          Country search & accessible selection
        </summary>
        <div className="mt-3 space-y-3">
          <label className="flex flex-col gap-1" htmlFor={`${id}-country`}>
            Find a country
            <input
              id={`${id}-country`}
              className={CONTROL}
              placeholder="Search country name…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4">
            {countries.map((entity) => (
              <label key={entity.id} className="flex items-center gap-2 rounded-md p-1">
                <input
                  type="checkbox"
                  className="accent-primary"
                  checked={view.entities.includes(entity.id)}
                  disabled={
                    !view.entities.includes(entity.id) &&
                    view.entities.filter((id) => id !== "OWID_WRL").length >= 6
                  }
                  onChange={() =>
                    onChange({ entities: toggleResearchEntity(view.entities, entity.id) })
                  }
                />
                {entity.name}
              </label>
            ))}
          </div>
          {!countries.length ? <p>No matching countries in this dataset.</p> : null}
          <p className="text-muted-foreground">
            Choose up to six countries. Selecting a country replaces World; World is an aggregate,
            not another country in rankings.
          </p>
        </div>
      </details>
    </section>
  );
}

function MeasureNote({
  dataset,
  measure,
}: {
  dataset: MatrixResearchDataset;
  measure: MatrixResearchMeasure;
}) {
  const { analyst } = useResearch();
  return (
    <details className="text-xs leading-relaxed text-muted-foreground" open={analyst}>
      <summary className="cursor-pointer">
        {measure.label} · {measure.unit} · annual country data ·{" "}
        {measure.sourceIds
          .map((id) => dataset.sources.find((source) => source.id === id)?.name ?? id)
          .join("; ")}{" "}
        · definition & source details
      </summary>
      <p className="mt-2 whitespace-pre-wrap">{measure.description}</p>
    </details>
  );
}

function CountryMap({
  dataset,
  measure,
  title,
}: {
  dataset: MatrixResearchDataset;
  measure: MatrixResearchMeasure;
  title: string;
}) {
  const { view: getView, update, exact } = useResearch();
  const view = getView(dataset);
  const rows = researchYearRows(dataset, view.year);
  const byIso = new Map(rows.filter((row) => row.entity.iso3).map((row) => [row.entity.iso3, row]));
  const scale = researchScale(
    rows
      .filter((row) => row.entity.iso3)
      .flatMap((row) => {
        const value = row.observation?.values[measure.id];
        return value == null ? [] : [value];
      }),
    measure,
  );
  const [focus, setFocus] = useState<string | null>(null);
  const focused = rows.find((row) => row.entity.id === focus);
  const available = rows.filter(
    (row) => row.entity.iso3 && row.observation?.values[measure.id] != null,
  ).length;
  const gradientId = useId().replaceAll(":", "");
  return (
    <section className="space-y-4" aria-label={title}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h4 className="text-lg font-medium">{title}</h4>
          <p className="mt-1 text-xs text-muted-foreground">
            {measure.label} · {measure.unit}
          </p>
        </div>
        <span className="text-xs tabular-nums text-muted-foreground">
          {view.year} · {available} countries with observations
        </span>
      </div>
      <div className="overflow-hidden rounded-xl border border-border bg-background p-2 sm:p-4">
        <svg
          className="block min-h-64 w-full"
          viewBox={`0 0 ${matrixWorldMap.width} ${matrixWorldMap.height}`}
          role="group"
          aria-label={`${measure.label} by country in ${view.year}. Use country search or the table for an accessible alternative.`}
        >
          {matrixWorldMap.countries.map((country) => {
            const row = byIso.get(country.iso3);
            const value = row?.observation?.values[measure.id];
            const selected = row ? view.entities.includes(row.entity.id) : false;
            const label = `${country.name}, ${view.year}: ${formatResearchValue(value, measure.unit, !exact)}${selected ? ", selected" : ""}`;
            return (
              <path
                key={country.iso3}
                d={country.path}
                fill={researchFill(value, scale)}
                stroke={selected ? "#f8fafc" : "#0f172a"}
                strokeWidth={selected ? 1.8 : 0.45}
                vectorEffect="non-scaling-stroke"
                role={row ? "button" : undefined}
                tabIndex={row ? 0 : undefined}
                aria-label={label}
                aria-pressed={row ? selected : undefined}
                className={
                  row ? "cursor-pointer outline-none focus:stroke-white focus:stroke-2" : ""
                }
                onMouseEnter={() => setFocus(row?.entity.id ?? null)}
                onFocus={() => setFocus(row?.entity.id ?? null)}
                onClick={() => {
                  if (row)
                    update(dataset, {
                      entities: toggleResearchEntity(view.entities, row.entity.id),
                    });
                }}
                onKeyDown={(event) => {
                  if (row && (event.key === "Enter" || event.key === " ")) {
                    event.preventDefault();
                    update(dataset, {
                      entities: toggleResearchEntity(view.entities, row.entity.id),
                    });
                  }
                }}
              >
                <title>{label}</title>
              </path>
            );
          })}
        </svg>
        <div className="min-h-8 px-2 text-xs text-muted-foreground" aria-live="polite">
          {focused
            ? `${focused.entity.name} · ${view.year} · ${formatResearchValue(focused.observation?.values[measure.id], measure.unit, !exact)}${focused.observation?.status ? ` · ${focused.observation.status}` : ""}`
            : "Select countries to link the history, comparison and table. Missing observations are never zero."}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
        {scale ? (
          <div className="w-72 max-w-full">
            <svg
              width="100%"
              height="12"
              role="img"
              aria-label={`Linear color scale from ${formatResearchValue(scale.min, measure.unit)} to ${formatResearchValue(scale.max, measure.unit)}`}
            >
              <defs>
                <linearGradient id={gradientId}>
                  <stop offset="0%" stopColor={researchFill(scale.min, scale)} />
                  {scale.diverging ? (
                    <stop offset="50%" stopColor={researchFill(0, scale)} />
                  ) : null}
                  <stop offset="100%" stopColor={researchFill(scale.max, scale)} />
                </linearGradient>
              </defs>
              <rect width="100%" height="10" rx="3" fill={`url(#${gradientId})`} />
            </svg>
            <div className="mt-1 flex justify-between gap-2">
              <span>{formatResearchValue(scale.min, measure.unit, true)}</span>
              {scale.diverging ? <span>0</span> : null}
              <span>{formatResearchValue(scale.max, measure.unit, true)}</span>
            </div>
            <p className="mt-1">
              Linear scale · {measure.unit}
              {measure.id === "droughtIndex" ? " · negative = drier" : ""}
            </p>
          </div>
        ) : (
          <span>No observations for this measure and year.</span>
        )}
        <span className="flex items-center gap-2">
          <span
            className="inline-block h-3 w-3 rounded-sm"
            style={{ backgroundColor: researchFill(null, null) }}
          />
          Not available / outside coverage
        </span>
      </div>
      <MeasureNote dataset={dataset} measure={measure} />
      <p className="text-2xs text-muted-foreground">
        Boundaries:{" "}
        <a className="underline" href={matrixWorldMap.source.url} target="_blank" rel="noreferrer">
          {matrixWorldMap.source.name}
        </a>{" "}
        · {matrixWorldMap.source.license}. {matrixWorldMap.source.projection}. Boundaries are for
        reference, not a statement of sovereignty.
      </p>
    </section>
  );
}

function useResearchPlotWidth() {
  const [element, setElement] = useState<SVGSVGElement | null>(null);
  const [width, setWidth] = useState(640);
  useLayoutEffect(() => {
    if (!element) return;
    return observeResize(element, (entries) => {
      const nextWidth = Math.floor(entries.at(-1)?.contentRect.width ?? 0);
      if (nextWidth > 0) setWidth(nextWidth);
    });
  }, [element]);
  return { ref: setElement, width };
}

function SeriesChart({
  dataset,
  measure,
  title,
  chartType,
}: {
  dataset: MatrixResearchDataset;
  measure: MatrixResearchMeasure;
  title: string;
  chartType: "line" | "bar";
}) {
  const { view: getView, update, exact } = useResearch();
  const view = getView(dataset);
  const [mode, setMode] = useState(chartType);
  const [point, setPoint] = useState<{ entity: string; year: number } | null>(null);
  const { ref: plotRef, width: plotWidth } = useResearchPlotWidth();
  const plotRight = Math.max(104, plotWidth - 24);
  const series = view.entities.map((id, index) => ({
    id,
    name: dataset.entities.find((entity) => entity.id === id)?.name ?? id,
    color: RESEARCH_COLORS[index % RESEARCH_COLORS.length]!,
    points: researchSeries(dataset, id, measure.id),
  }));
  const activePoint = point
    ? series
        .find((item) => item.name === point.entity)
        ?.points.find((entry) => entry.year === point.year)
    : undefined;
  const points = series.flatMap((item) => item.points);
  const allYears = dataset.observations.map((row) => row.year);
  const first = allYears.length ? Math.min(...allYears) : view.year;
  const last = allYears.length ? Math.max(...allYears) : view.year;
  const low = points.length ? Math.min(0, ...points.map((item) => item.value)) : 0;
  const high = points.length ? Math.max(0, ...points.map((item) => item.value)) || 1 : 1;
  const x = (year: number) => 82 + ((year - first) / Math.max(1, last - first)) * (plotRight - 82);
  const y = (value: number) => 300 - ((value - low) / Math.max(0.000001, high - low)) * 260;
  const ticks = Array.from(
    new Set([
      first,
      ...Array.from({ length: plotWidth < 480 ? 2 : 4 }, (_, index) =>
        Math.round(first + ((last - first) * (index + 1)) / (plotWidth < 480 ? 3 : 5)),
      ),
      last,
    ]),
  );
  const detail = (entity: string, entry: ResearchPoint) => setPoint({ entity, year: entry.year });
  return (
    <section className="space-y-4" aria-label={title}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h4 className="text-lg font-medium">{title}</h4>
          <p className="mt-1 text-xs text-muted-foreground">
            {measure.label} · {measure.unit}
          </p>
        </div>
        <div className="flex gap-1" aria-label="Chart display">
          {(["line", "bar"] as const).map((kind) => (
            <Button
              key={kind}
              variant={mode === kind ? "secondary" : "ghost"}
              size="compact"
              aria-pressed={mode === kind}
              onClick={() => setMode(kind)}
            >
              {kind === "line" ? "Line" : "Bar"}
            </Button>
          ))}
        </div>
      </div>
      {!points.length ? (
        <p className="rounded-lg border border-dashed border-border p-8 text-sm text-muted-foreground">
          No history for the selected countries and measure. Select countries or another measure; no
          substitute series is shown.
        </p>
      ) : (
        <div className="rounded-xl border border-border bg-muted/10 p-2">
          <svg
            ref={plotRef}
            className="block w-full"
            viewBox={`0 0 ${plotWidth} 350`}
            role="group"
            aria-label={`${measure.label} history, ${first} to ${last}. Exact annual positions; missing years break lines.`}
          >
            {[0, 0.25, 0.5, 0.75, 1].map((fraction) => {
              const value = low + (high - low) * fraction;
              return (
                <g key={fraction}>
                  <line
                    x1="82"
                    x2={plotRight}
                    y1={y(value)}
                    y2={y(value)}
                    stroke="currentColor"
                    opacity="0.12"
                  />
                  <text x="73" y={y(value) + 4} textAnchor="end" fontSize="11" fill="currentColor">
                    {formatResearchValue(
                      value,
                      isResearchPercentageUnit(measure.unit) ? "%" : "",
                      true,
                    )}
                  </text>
                </g>
              );
            })}
            {ticks.map((year) => (
              <text
                key={year}
                x={x(year)}
                y="325"
                textAnchor="middle"
                fontSize="11"
                fill="currentColor"
              >
                {year}
              </text>
            ))}
            <line
              x1={x(view.year)}
              x2={x(view.year)}
              y1="35"
              y2="300"
              stroke="currentColor"
              strokeDasharray="4 5"
              opacity="0.5"
            />
            {series.map((item, index) => (
              <g key={item.id}>
                {mode === "line"
                  ? researchSeriesSegments(item.points).map((segment) => (
                      <path
                        key={segment[0]?.year}
                        d={segment
                          .map(
                            (entry, i) =>
                              `${i === 0 ? "M" : "L"}${x(entry.year)},${y(entry.value)}`,
                          )
                          .join(" ")}
                        stroke={item.color}
                        strokeWidth="2.5"
                        fill="none"
                      />
                    ))
                  : null}
                {item.points.map((entry) => {
                  const label = `${item.name}, ${entry.year}: ${formatResearchValue(entry.value, measure.unit, !exact)}${entry.status ? `, ${entry.status}` : ""}`;
                  const barWidth = Math.max(
                    0.8,
                    Math.min(
                      28,
                      (plotRight - 82) / Math.max(1, last - first + 1) / Math.max(1, series.length),
                    ),
                  );
                  const props = {
                    tabIndex: 0,
                    role: "button" as const,
                    "aria-label": label,
                    onFocus: () => detail(item.name, entry),
                    onMouseEnter: () => detail(item.name, entry),
                    onClick: () => {
                      detail(item.name, entry);
                      update(dataset, { year: entry.year });
                    },
                    onKeyDown: (event: KeyboardEvent<SVGElement>) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        detail(item.name, entry);
                        update(dataset, { year: entry.year });
                      }
                    },
                  };
                  return mode === "line" ? (
                    <circle
                      key={entry.year}
                      {...props}
                      cx={x(entry.year)}
                      cy={y(entry.value)}
                      r={entry.year === view.year ? 4.5 : 2.5}
                      fill={item.color}
                      className="cursor-pointer focus:stroke-foreground focus:stroke-2"
                    >
                      <title>{label}</title>
                    </circle>
                  ) : (
                    <rect
                      key={entry.year}
                      {...props}
                      x={
                        x(entry.year) + (index - (series.length - 1) / 2) * barWidth - barWidth / 2
                      }
                      y={Math.min(y(0), y(entry.value))}
                      width={barWidth * 0.9}
                      height={Math.max(1, Math.abs(y(entry.value) - y(0)))}
                      fill={item.color}
                      className="cursor-pointer focus:stroke-foreground focus:stroke-2"
                    >
                      <title>{label}</title>
                    </rect>
                  );
                })}
              </g>
            ))}
          </svg>
          <p className="min-h-6 px-2 text-xs text-muted-foreground" aria-live="polite">
            {point && activePoint
              ? `${point.entity} · ${activePoint.year} · ${formatResearchValue(activePoint.value, measure.unit, !exact)}${activePoint.status ? ` · ${activePoint.status}` : ""}`
              : "Hover or focus a point for details. Choose exact precision for the full source value; selecting a point changes the workspace year."}
          </p>
        </div>
      )}
      <div className="flex flex-wrap gap-x-5 gap-y-2 text-xs">
        {series.map((item) => (
          <span key={item.id} className="flex items-center gap-2">
            <span className="h-2 w-5 rounded-full" style={{ backgroundColor: item.color }} />
            {item.name}
          </span>
        ))}
      </div>
      <MeasureNote dataset={dataset} measure={measure} />
      <p className="text-xs text-muted-foreground">
        Calendar years are positioned by exact year; gaps are not interpolated. {dataset.timeBasis}
      </p>
    </section>
  );
}

function DataMetrics({
  dataset,
  measures: authoredMeasures,
  title,
}: {
  dataset: MatrixResearchDataset;
  measures: readonly string[];
  title: string;
}) {
  const { view: getView, exact, analyst } = useResearch();
  const view = getView(dataset);
  const measures = Array.from(new Set([view.measure, ...authoredMeasures]));
  return (
    <section className="space-y-3" aria-label={title}>
      <h4 className="text-base font-medium">
        {title} <span className="text-xs font-normal text-muted-foreground">· {view.year}</span>
      </h4>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {view.entities.flatMap((id) =>
          measures.map((measureId) => {
            const measure = dataset.measures.find((item) => item.id === measureId);
            if (!measure) return null;
            const observation = researchObservation(dataset, id, view.year);
            const change = researchChange(dataset, id, measure.id, view.year);
            return (
              <div
                key={`${id}:${measureId}`}
                className="rounded-xl border border-border bg-muted/15 p-4"
              >
                <p className="text-xs text-muted-foreground">
                  {dataset.entities.find((entity) => entity.id === id)?.name ?? id} ·{" "}
                  {measure.label}
                </p>
                <p className="mt-2 break-words text-2xl font-semibold tabular-nums">
                  {formatResearchValue(observation?.values[measureId], measure.unit, !exact)}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {measure.unit} · {view.year}
                  {observation?.status ? ` · ${observation.status}` : ""}
                </p>
                <details className="mt-3 text-xs text-muted-foreground" open={analyst}>
                  <summary className="cursor-pointer">Exact value & year-on-year</summary>
                  <p className="mt-2">
                    {formatResearchValue(observation?.values[measureId], measure.unit)}
                  </p>
                  <p>
                    {change
                      ? `Change from ${view.year - 1}: ${formatResearchDifference(change.absolute, measure.unit)}${isResearchPercentageUnit(measure.unit) ? "" : change.percent == null ? " · relative percentage change unavailable for a non-positive baseline" : ` (${change.percent.toFixed(2)}% relative)`}.`
                      : `Year-on-year change unavailable: both ${view.year - 1} and ${view.year} observations are required.`}
                  </p>
                  <MeasureNote dataset={dataset} measure={measure} />
                </details>
              </div>
            );
          }),
        )}
      </div>
      {!view.entities.length ? (
        <p className="text-xs text-muted-foreground">
          Select countries to compare exact-year observations.
        </p>
      ) : null}
    </section>
  );
}

function DataTable({
  dataset,
  measures: authoredMeasures,
  title,
}: {
  dataset: MatrixResearchDataset;
  measures: readonly string[];
  title: string;
}) {
  const { view: getView, update, exact, setExact } = useResearch();
  const view = getView(dataset);
  const measures = Array.from(new Set([view.measure, ...authoredMeasures]));
  const [sort, setSort] = useState({ key: view.measure, direction: "desc" as "asc" | "desc" });
  const [sortMeasure, setSortMeasure] = useState(view.measure);
  if (sortMeasure !== view.measure) {
    setSortMeasure(view.measure);
    setSort({ key: view.measure, direction: "desc" });
  }
  const [search, setSearch] = useState("");
  const [selectedOnly, setSelectedOnly] = useState(false);
  const [pagination, setPagination] = useState({ scope: "", page: 0 });
  const rows = sortResearchRows(researchYearRows(dataset, view.year), sort.key, sort.direction);
  const visible = rows.filter(
    (row) =>
      row.entity.name.toLowerCase().includes(search.toLowerCase()) &&
      (!selectedOnly || view.entities.includes(row.entity.id)),
  );
  const numericRank = new Map(
    rows
      .filter((row) => row.entity.iso3 && row.observation?.values[sort.key] != null)
      .map((row, index) => [row.entity.id, index + 1]),
  );
  const columns = ["country", ...measures];
  const pageScope = JSON.stringify([
    dataset.id,
    view.year,
    view.measure,
    sort.key,
    sort.direction,
    search,
    selectedOnly,
    selectedOnly ? view.entities : [],
  ]);
  const page = researchTablePage(visible, pagination.scope === pageScope ? pagination.page : 0);
  return (
    <section className="space-y-3" aria-label={title}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h4 className="text-lg font-medium">
          {title} <span className="text-xs font-normal text-muted-foreground">· {view.year}</span>
        </h4>
        <div className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2 text-xs">
            Precision
            <select
              className={CONTROL}
              value={exact ? "exact" : "rounded"}
              onChange={(event) => setExact(event.target.value === "exact")}
            >
              <option value="rounded">Readable · rounded</option>
              <option value="exact">Exact source values</option>
            </select>
          </label>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={selectedOnly}
              onChange={(event) => setSelectedOnly(event.target.checked)}
            />
            Selected only
          </label>
        </div>
      </div>
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        Filter table countries
        <input
          className={CONTROL}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search countries…"
        />
      </label>
      <div
        className="overflow-x-auto rounded-xl border border-border"
        tabIndex={0}
        aria-label="Research data table, scroll horizontally for all measures"
      >
        <table className="w-full text-left text-xs">
          <thead className="bg-muted/30">
            <tr>
              <th scope="col" className="p-3">
                Compare
              </th>
              {columns.map((key) => {
                const measure = dataset.measures.find((item) => item.id === key);
                return (
                  <th
                    key={key}
                    scope="col"
                    className="p-3"
                    aria-sort={
                      sort.key === key
                        ? sort.direction === "asc"
                          ? "ascending"
                          : "descending"
                        : "none"
                    }
                  >
                    <button
                      type="button"
                      className="text-left font-medium focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                      onClick={() =>
                        setSort({
                          key,
                          direction: sort.key === key && sort.direction === "desc" ? "asc" : "desc",
                        })
                      }
                    >
                      {measure ? `${measure.label} (${measure.unit})` : "Country"}
                      {sort.key === key ? (sort.direction === "desc" ? " ↓" : " ↑") : ""}
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {page.rows.map((row) => (
              <tr
                key={row.entity.id}
                className={
                  view.entities.includes(row.entity.id)
                    ? "border-t border-border bg-primary/10"
                    : "border-t border-border"
                }
              >
                <td className="p-3">
                  <input
                    aria-label={`Compare ${row.entity.name}`}
                    type="checkbox"
                    checked={view.entities.includes(row.entity.id)}
                    disabled={
                      !view.entities.includes(row.entity.id) &&
                      row.entity.id !== "OWID_WRL" &&
                      view.entities.filter((id) => id !== "OWID_WRL").length >= 6
                    }
                    onChange={() =>
                      update(dataset, {
                        entities: toggleResearchEntity(view.entities, row.entity.id),
                      })
                    }
                  />
                </td>
                <th scope="row" className="p-3 font-medium">
                  {numericRank.has(row.entity.id) ? (
                    <span className="mr-2 text-muted-foreground">
                      {numericRank.get(row.entity.id)}
                    </span>
                  ) : null}
                  {row.entity.name}
                  {!row.entity.iso3 ? " · aggregate" : ""}
                </th>
                {measures.map((id) => {
                  const value = row.observation?.values[id];
                  const unit = dataset.measures.find((measure) => measure.id === id)?.unit ?? "";
                  return (
                    <td className="whitespace-nowrap p-3 tabular-nums" key={id}>
                      {!exact && value != null ? (
                        <details>
                          <summary className="cursor-pointer">
                            {formatResearchValue(value, unit, true)}
                          </summary>
                          <p className="mt-1">
                            Exact source: {formatResearchValue(value, unit, false)}
                          </p>
                        </details>
                      ) : (
                        formatResearchValue(value, unit, !exact)
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <nav
        className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground"
        aria-label={`${title} pages`}
      >
        <span role="status">
          Rows {page.start}–{page.end} of {page.total}
          {page.total !== rows.length ? ` matching (${rows.length} total)` : ""} · page{" "}
          {page.page + 1} of {page.pageCount}
        </span>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="compact"
            disabled={page.page === 0}
            onClick={() => setPagination({ scope: pageScope, page: page.page - 1 })}
          >
            Previous
          </Button>
          <Button
            variant="outline"
            size="compact"
            disabled={page.page + 1 >= page.pageCount}
            onClick={() => setPagination({ scope: pageScope, page: page.page + 1 })}
          >
            Next
          </Button>
        </div>
      </nav>
      {!visible.length ? (
        <p className="text-xs text-muted-foreground">No countries match this filter.</p>
      ) : null}
      <p className="text-xs text-muted-foreground">
        All matching rows remain available through pages or country search. Numeric sort uses source
        values, not rounded text; missing values stay last. Country ranks exclude World and other
        aggregates and follow {sort.direction === "asc" ? "ascending" : "descending"} display order.
        No observation is substituted from a different year.{" "}
        {exact
          ? "Exact source precision is shown."
          : "Readable values are rounded; expand a cell or choose exact precision for its source value."}{" "}
        Units and provenance follow the sources below.
      </p>
    </section>
  );
}

function ScatterChart({
  dataset,
  block,
  title,
}: {
  dataset: MatrixResearchDataset;
  block: Extract<MatrixResearchBlock, { kind: "scatter" }>;
  title: string;
}) {
  const { view: getView, update, exact } = useResearch();
  const view = getView(dataset);
  const xm = dataset.measures.find((measure) => measure.id === block.xMeasure);
  const ym = dataset.measures.find((measure) => measure.id === block.yMeasure);
  const [detailId, setDetailId] = useState<string | null>(null);
  const { ref: plotRef, width: plotWidth } = useResearchPlotWidth();
  const plotRight = Math.max(112, plotWidth - 24);
  if (!xm || !ym) return <p role="alert">Scatter measure is unavailable in this dataset.</p>;
  const paired = researchYearRows(dataset, view.year).flatMap((row) => {
    const x = row.observation?.values[xm.id];
    const y = row.observation?.values[ym.id];
    return row.entity.iso3 && x != null && y != null ? [{ entity: row.entity, x, y }] : [];
  });
  const detailPoint = paired.find((point) => point.entity.id === detailId);
  const detail = detailPoint
    ? `${detailPoint.entity.name}, ${view.year}: ${xm.label} ${formatResearchValue(detailPoint.x, xm.unit, !exact)}; ${ym.label} ${formatResearchValue(detailPoint.y, ym.unit, !exact)}`
    : null;
  const xmin = Math.min(0, ...paired.map((point) => point.x));
  const xmax = Math.max(0, ...paired.map((point) => point.x)) || 1;
  const ymin = Math.min(0, ...paired.map((point) => point.y));
  const ymax = Math.max(0, ...paired.map((point) => point.y)) || 1;
  const x = (value: number) =>
    90 + ((value - xmin) / Math.max(0.000001, xmax - xmin)) * (plotRight - 90);
  const y = (value: number) => 300 - ((value - ymin) / Math.max(0.000001, ymax - ymin)) * 260;
  return (
    <section className="space-y-3" aria-label={title}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="text-lg font-medium">{title}</h4>
        <span className="text-xs text-muted-foreground">
          {view.year} · {paired.length} paired countries
        </span>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>
          X: {xm.label} ({xm.unit})
        </span>
        <span>
          Y: {ym.label} ({ym.unit})
        </span>
      </div>
      {paired.length ? (
        <div className="rounded-xl border border-border bg-muted/10 p-2">
          <svg
            ref={plotRef}
            className="block w-full"
            viewBox={`0 0 ${plotWidth} 380`}
            role="group"
            aria-label={`${xm.label} versus ${ym.label} in ${view.year}`}
          >
            {[0, 0.25, 0.5, 0.75, 1].map((fraction) => {
              const xv = xmin + (xmax - xmin) * fraction;
              const yv = ymin + (ymax - ymin) * fraction;
              return (
                <g key={fraction}>
                  <line
                    x1="90"
                    x2={plotRight}
                    y1={y(yv)}
                    y2={y(yv)}
                    stroke="currentColor"
                    opacity="0.1"
                  />
                  <text x="80" y={y(yv) + 4} fontSize="11" textAnchor="end" fill="currentColor">
                    {formatResearchValue(yv, isResearchPercentageUnit(ym.unit) ? "%" : "", true)}
                  </text>
                  <text x={x(xv)} y="323" fontSize="11" textAnchor="middle" fill="currentColor">
                    {formatResearchValue(xv, isResearchPercentageUnit(xm.unit) ? "%" : "", true)}
                  </text>
                </g>
              );
            })}
            <text
              x={(90 + plotRight) / 2}
              y="360"
              textAnchor="middle"
              fontSize="12"
              fill="currentColor"
            >
              X
            </text>
            <text
              transform="translate(16,170) rotate(-90)"
              textAnchor="middle"
              fontSize="12"
              fill="currentColor"
            >
              Y
            </text>
            {paired.map((point) => {
              const label = `${point.entity.name}, ${view.year}: ${xm.label} ${formatResearchValue(point.x, xm.unit, !exact)}; ${ym.label} ${formatResearchValue(point.y, ym.unit, !exact)}`;
              const selected = view.entities.includes(point.entity.id);
              return (
                <circle
                  key={point.entity.id}
                  cx={x(point.x)}
                  cy={y(point.y)}
                  r={selected ? 6 : 3.5}
                  fill={
                    selected ? RESEARCH_COLORS[view.entities.indexOf(point.entity.id)] : "#64748b"
                  }
                  stroke={selected ? "#fff" : "none"}
                  opacity={selected ? 1 : 0.65}
                  tabIndex={0}
                  role="button"
                  aria-label={label}
                  aria-pressed={selected}
                  className="cursor-pointer focus:stroke-foreground focus:stroke-2"
                  onMouseEnter={() => setDetailId(point.entity.id)}
                  onFocus={() => setDetailId(point.entity.id)}
                  onClick={() =>
                    update(dataset, {
                      entities: toggleResearchEntity(view.entities, point.entity.id),
                    })
                  }
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      update(dataset, {
                        entities: toggleResearchEntity(view.entities, point.entity.id),
                      });
                    }
                  }}
                >
                  <title>{label}</title>
                </circle>
              );
            })}
          </svg>
          <p className="min-h-8 px-2 text-xs text-muted-foreground" aria-live="polite">
            {detail ??
              "Each point is one country with both observations in the same year. Select a point to compare its history."}
          </p>
        </div>
      ) : (
        <p className="rounded-lg border border-dashed border-border p-6 text-sm text-muted-foreground">
          No paired observations in {view.year}. Choose another year; missing observations are not
          substituted.
        </p>
      )}
      <MeasureNote dataset={dataset} measure={xm} />
      <MeasureNote dataset={dataset} measure={ym} />
      <p className="rounded-lg border border-warning/20 bg-warning-surface p-3 text-xs text-muted-foreground">
        Association is not causation. Annual country-level comparisons do not establish an effect of
        one measure on another. Measurement definitions, coverage and other country differences
        matter.
        {xm.id === "droughtIndex" || ym.id === "droughtIndex"
          ? " Country-level annual climate averages are not crop-area-weighted exposure or current growing conditions. Harvested area, irrigation, technology and other factors also differ; this view does not establish a drought effect on crop output."
          : ""}
      </p>
    </section>
  );
}

export function ResearchBlockView({ block }: { block: MatrixResearchBlock }) {
  const { answer, view } = useResearch();
  const dataset = answer.datasets?.find((candidate) => candidate.id === block.dataset);
  if (!dataset)
    return (
      <section className="space-y-2">
        <h4 className="font-medium">Research data</h4>
        <p role="status" className="text-sm text-muted-foreground">
          Source dataset is unavailable. No substitute numbers or visualization are shown.
        </p>
      </section>
    );
  const title = researchBlockTitle(dataset, block, view(dataset));
  if (block.kind === "data-table")
    return (
      <DataTable
        dataset={dataset}
        measures={[...new Set([view(dataset).measure, ...block.measures])]}
        title={title}
      />
    );
  if (block.kind === "data-metrics")
    return (
      <DataMetrics
        dataset={dataset}
        measures={[...new Set([view(dataset).measure, ...block.measures])]}
        title={title}
      />
    );
  if (block.kind === "scatter")
    return (
      <ScatterChart
        key={`${dataset.id}:${view(dataset).year}:${block.xMeasure}:${block.yMeasure}`}
        dataset={dataset}
        block={block}
        title={title}
      />
    );
  const measureId = block.kind === "series" ? block.measure : view(dataset).measure;
  const measure = dataset.measures.find((candidate) => candidate.id === measureId);
  if (!measure)
    return <p role="alert">Requested measure is unavailable. No substitute value is shown.</p>;
  return block.kind === "map" ? (
    <CountryMap dataset={dataset} measure={measure} title={title} />
  ) : (
    <SeriesChart
      key={`${dataset.id}:${measure.id}`}
      dataset={dataset}
      measure={measure}
      title={title}
      chartType={block.chartType}
    />
  );
}

export function ResearchCanvasSources() {
  const { answer, analyst } = useResearch();
  if (!answer.datasets?.length) return null;
  return (
    <aside className="border-t border-border pt-4" aria-label="Research sources and limitations">
      {answer.datasets.map((dataset) => (
        <details
          key={dataset.id}
          className="mb-3 rounded-lg border border-border p-3"
          open={analyst}
        >
          <summary className="cursor-pointer text-sm font-medium">
            Sources & limitations · {dataset.title}{" "}
            <span className="font-normal text-muted-foreground">
              ({dataset.sources.length} sources)
            </span>
          </summary>
          <div className="mt-4 space-y-4 text-xs leading-relaxed text-muted-foreground">
            <p>
              {dataset.timeBasis} Frequency: annual. Scope: country-level historical observations,
              not real-time conditions or a forecast.
            </p>
            {dataset.warnings.length ? (
              <ul className="list-disc space-y-1 pl-4">
                {dataset.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            ) : null}
            {dataset.sources.map((source) => (
              <section key={source.id} className="space-y-1 border-t border-border pt-3">
                <h5 className="font-medium text-foreground">
                  <a
                    className="underline underline-offset-2"
                    href={source.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {source.name}
                  </a>
                </h5>
                <p>{source.description}</p>
                <p>
                  Source updated: {source.updatedAt ?? "not supplied"} · retrieved:{" "}
                  {source.retrievedAt}
                </p>
                <p>License / terms: {source.license}</p>
                <a className="underline" href={source.downloadUrl} target="_blank" rel="noreferrer">
                  Underlying data
                </a>
              </section>
            ))}
            <div className="space-y-2 border-t border-border pt-3">
              {dataset.measures.map((measure) => (
                <p key={measure.id}>
                  <span className="font-medium text-foreground">
                    {measure.label} · {measure.unit}
                    {measure.derived ? " · derived" : ""}.
                  </span>{" "}
                  {measure.description}
                </p>
              ))}
            </div>
          </div>
        </details>
      ))}
    </aside>
  );
}
