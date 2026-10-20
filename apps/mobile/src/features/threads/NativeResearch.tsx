import type {
  MatrixResearchBlock,
  MatrixResearchDataset,
  MatrixResearchMeasure,
  MatrixResearchView,
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
} from "@t3tools/shared/matrixResearch";
import { matrixWorldMap } from "@t3tools/shared/matrixWorldMap";
import { useMemo, useState, type ReactNode } from "react";
import { Modal, Pressable, ScrollView, TextInput, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Circle, Line, Path, Polyline, Rect } from "react-native-svg";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { SheetHeader } from "../../components/ui/SheetHeader";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import {
  nativeResearchColor,
  nativeResearchCompare,
  nativeResearchFocus,
  nativeResearchPage,
  nativeResearchRows,
  nativeResearchSourceUrl,
} from "./native-research-presentation";

export type NativeResearchView = { entities: string[]; year: number; measure: string };
type ResearchProps = {
  readonly dataset: MatrixResearchDataset;
  readonly view: NativeResearchView;
  readonly disabled: boolean;
  readonly analyst: boolean;
  readonly onChange: (view: MatrixResearchView) => void;
};
const SERIES_COLORS = ["#38bdf8", "#fb923c", "#a78bfa", "#34d399", "#f472b6", "#facc15"];

function ResearchChoice(props: {
  label: string;
  selected: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: props.selected, disabled: props.disabled }}
      disabled={props.disabled}
      onPress={props.onPress}
      className={
        props.selected
          ? "min-h-11 justify-center rounded-xl bg-secondary px-3"
          : "min-h-11 justify-center rounded-xl border border-border-subtle px-3"
      }
    >
      <Text className="text-sm text-foreground">{props.label}</Text>
    </Pressable>
  );
}

function ResearchLink(props: { url: string; children: ReactNode }) {
  const [failed, setFailed] = useState(false);
  if (!nativeResearchSourceUrl(props.url))
    return <Text className="text-sm text-foreground-muted">Source link unavailable</Text>;
  return (
    <View>
      <Pressable
        accessibilityRole="link"
        accessibilityHint="Opens the source in your browser"
        className="min-h-11 justify-center py-2"
        onPress={() => {
          void tryOpenExternalUrl(props.url, "matrix-answer").then((opened) => setFailed(!opened));
        }}
      >
        <Text className="text-sm text-primary-text underline">{props.children}</Text>
      </Pressable>
      {failed ? (
        <Text accessibilityRole="alert" className="text-sm text-danger">
          Could not open source. Tap to retry.
        </Text>
      ) : null}
    </View>
  );
}

function ResearchDescription(props: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <View className="gap-1">
      <Text
        selectable
        numberOfLines={expanded ? undefined : 3}
        className="text-sm text-foreground-muted"
      >
        {props.text}
      </Text>
      {props.text ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          className="min-h-11 justify-center"
          onPress={() => setExpanded(!expanded)}
        >
          <Text className="text-sm text-primary-text">
            {expanded ? "Collapse description" : "Read full description"}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export function NativeResearchSources(props: { dataset: MatrixResearchDataset }) {
  return (
    <View className="gap-3">
      <Text selectable className="text-sm text-foreground-muted">
        {props.dataset.timeBasis}
      </Text>
      {props.dataset.sources.map((source) => (
        <View key={source.id} className="gap-1 rounded-xl bg-secondary p-3">
          <Text className="font-t3-semibold text-foreground">{source.name}</Text>
          <ResearchDescription text={source.description} />
          <Text selectable className="text-xs text-foreground-muted">
            Retrieved {source.retrievedAt} · Updated {source.updatedAt ?? "not provided"}
            {"\n"}License / terms: {source.license}
          </Text>
          <ResearchLink url={source.url}>Source and terms</ResearchLink>
          <ResearchLink url={source.downloadUrl}>Underlying data</ResearchLink>
        </View>
      ))}
      {props.dataset.measures.map((measure) => (
        <View key={measure.id} className="gap-1">
          <Text className="text-xs text-foreground-muted">
            {measure.label} ({measure.unit}) · {measure.derived ? "Derived" : "Source series"}
          </Text>
          <ResearchDescription text={measure.description} />
          <Text className="text-xs text-foreground-muted">
            Sources:{" "}
            {measure.sourceIds
              .map((id) => props.dataset.sources.find((source) => source.id === id)?.name ?? id)
              .join("; ")}
          </Text>
        </View>
      ))}
    </View>
  );
}

export function NativeResearchControls(props: ResearchProps) {
  const { dataset, view } = props;
  const [picker, setPicker] = useState(false);
  const [search, setSearch] = useState("");
  const [sources, setSources] = useState(false);
  const insets = useSafeAreaInsets();
  const years = useMemo(
    () => [...new Set(dataset.observations.map((row) => row.year))].sort((a, b) => b - a),
    [dataset],
  );
  const countries = dataset.entities.filter((entity) =>
    entity.name.toLowerCase().includes(search.trim().toLowerCase()),
  );
  return (
    <View className="gap-3 rounded-xl border border-border-subtle p-3">
      <Text accessibilityRole="header" className="font-t3-semibold text-lg text-foreground">
        {dataset.title}
      </Text>
      <Text selectable className="text-xs text-foreground-muted">
        Annual country observations · {dataset.timeBasis}
      </Text>
      <Text className="text-sm text-foreground">Year · {view.year}</Text>
      <ScrollView horizontal nestedScrollEnabled contentContainerStyle={{ gap: 8 }}>
        {years.map((year) => (
          <ResearchChoice
            key={year}
            label={String(year)}
            selected={year === view.year}
            disabled={props.disabled}
            onPress={() => props.onChange({ ...view, year })}
          />
        ))}
      </ScrollView>
      <Text className="text-sm text-foreground">
        Map measure (history uses its authored measure)
      </Text>
      <ScrollView horizontal nestedScrollEnabled contentContainerStyle={{ gap: 8 }}>
        {dataset.measures.map((measure) => (
          <ResearchChoice
            key={measure.id}
            label={measure.label}
            selected={measure.id === view.measure}
            disabled={props.disabled}
            onPress={() => props.onChange({ ...view, measure: measure.id })}
          />
        ))}
      </ScrollView>
      <Text className="text-sm text-foreground">Focus and comparisons (up to 6)</Text>
      <View className="flex-row flex-wrap gap-2">
        {view.entities.map((id, index) => (
          <ResearchChoice
            key={id}
            label={`${index === 0 ? "Focus: " : ""}${dataset.entities.find((entity) => entity.id === id)?.name ?? id}`}
            selected={index === 0}
            disabled={props.disabled}
            onPress={() =>
              props.onChange({ ...view, entities: nativeResearchFocus(view.entities, id) })
            }
          />
        ))}
      </View>
      {view.entities.length === 0 ? (
        <Text className="text-sm text-foreground-muted">
          No countries selected. Tap the map or choose countries / World to show history and
          metrics.
        </Text>
      ) : null}
      <Button
        label="Choose countries / World"
        tone="text"
        disabled={props.disabled}
        onPress={() => setPicker(true)}
      />
      {view.entities.some(
        (id) => dataset.entities.find((entity) => entity.id === id)?.name === "World",
      ) &&
      dataset.measures.some(
        (measure) => measure.id === "droughtIndex" || measure.id === "EN.CLC.SPEI.XD",
      ) ? (
        <Text className="text-sm text-foreground-muted">
          World SPEI is not available. A global drought index is not estimated by averaging country
          indices.
        </Text>
      ) : null}
      {dataset.warnings.map((warning) => (
        <Text selectable key={warning} className="text-sm text-foreground-muted">
          {warning}
        </Text>
      ))}
      <Button
        label={sources ? "Hide dataset sources" : "Dataset sources and coverage"}
        tone="text"
        onPress={() => setSources(!sources)}
      />
      {sources ? <NativeResearchSources dataset={dataset} /> : null}
      {picker ? (
        <Modal
          visible
          animationType="slide"
          presentationStyle="fullScreen"
          onRequestClose={() => setPicker(false)}
        >
          <GestureHandlerRootView style={{ flex: 1 }}>
            <View
              className="flex-1 bg-screen"
              style={{ paddingTop: insets.top, paddingBottom: insets.bottom }}
            >
              <SheetHeader
                presentation="inline"
                title="Countries and comparisons"
                onClose={() => setPicker(false)}
                accessibilityLabel="Close country selector"
              />
              <View className="gap-2 px-4">
                <TextInput
                  accessibilityLabel="Search countries"
                  placeholder="Search countries or World"
                  value={search}
                  onChangeText={setSearch}
                  autoCorrect={false}
                  className="min-h-11 rounded-xl border border-border-subtle px-3 text-foreground"
                />
                <Text className="text-sm text-foreground-muted">
                  Tap a country to focus. Compare adds/removes a series; at least one and at most
                  six selections are retained.
                </Text>
              </View>
              <ScrollView
                keyboardShouldPersistTaps="handled"
                contentContainerStyle={{ padding: 16, gap: 10 }}
              >
                {countries.map((entity) => (
                  <View key={entity.id} className="flex-row items-center gap-2">
                    <View className="flex-1">
                      <ResearchChoice
                        label={entity.name}
                        selected={view.entities[0] === entity.id}
                        disabled={props.disabled}
                        onPress={() => {
                          props.onChange({
                            ...view,
                            entities: nativeResearchFocus(view.entities, entity.id),
                          });
                          setPicker(false);
                        }}
                      />
                    </View>
                    <ResearchChoice
                      label={view.entities.includes(entity.id) ? "Remove" : "Compare"}
                      selected={view.entities.includes(entity.id)}
                      disabled={
                        props.disabled ||
                        (view.entities.includes(entity.id)
                          ? view.entities.length === 1
                          : view.entities.length === 6)
                      }
                      onPress={() =>
                        props.onChange({
                          ...view,
                          entities: nativeResearchCompare(view.entities, entity.id),
                        })
                      }
                    />
                  </View>
                ))}
              </ScrollView>
            </View>
          </GestureHandlerRootView>
        </Modal>
      ) : null}
    </View>
  );
}

function ResearchValue(props: {
  dataset: MatrixResearchDataset;
  entityId: string;
  year: number;
  measure: MatrixResearchMeasure;
  analyst: boolean;
}) {
  const [exact, setExact] = useState(false);
  const compact = !props.analyst && !exact;
  const observation = researchObservation(props.dataset, props.entityId, props.year);
  const value = observation?.values[props.measure.id];
  const change = researchChange(props.dataset, props.entityId, props.measure.id, props.year);
  const percentage = isResearchPercentageUnit(props.measure.unit);
  return (
    <View className="gap-1">
      <Text selectable className="font-t3-semibold text-base text-foreground">
        {formatResearchValue(value, props.measure.unit, compact)}
      </Text>
      <Text selectable className="text-xs text-foreground-muted">
        {props.measure.label} · {props.year}
        {observation?.status
          ? ` · ${observation.status}`
          : " · Original observation flags not provided"}
      </Text>
      {change && value != null ? (
        <Text className="text-xs text-foreground-muted">
          Change from {props.year - 1}:{" "}
          {formatResearchDifference(change.absolute, props.measure.unit, compact)}
          {percentage
            ? ""
            : change.percent === null
              ? " · Relative change unavailable"
              : ` (${formatResearchValue(change.percent, "%", compact)})`}
        </Text>
      ) : (
        <Text className="text-xs text-foreground-muted">
          Exact previous-year change unavailable.
        </Text>
      )}
      {!props.analyst && typeof value === "number" ? (
        <Button
          label={exact ? "Show rounded value" : "Show exact value"}
          tone="text"
          onPress={() => setExact(!exact)}
        />
      ) : null}
      <Text className="text-xs text-foreground-muted">
        Sources:{" "}
        {props.measure.sourceIds
          .map((id) => props.dataset.sources.find((source) => source.id === id)?.name ?? id)
          .join("; ")}
      </Text>
    </View>
  );
}

function ResearchMap(props: ResearchProps & { measure: MatrixResearchMeasure }) {
  const { dataset, view, measure } = props;
  const [width, setWidth] = useState(300);
  const rows = useMemo(
    () => nativeResearchRows(dataset, view.year, { measure: measure.id, descending: true }),
    [dataset, view.year, measure.id],
  );
  const byIso = new Map(
    rows.flatMap((row) => (row.entity.iso3 ? [[row.entity.iso3, row] as const] : [])),
  );
  const values = rows
    .filter((row) => row.entity.iso3 !== null)
    .flatMap((row) => {
      const value = row.observation?.values[measure.id];
      return value == null ? [] : [value];
    });
  const extent: [number, number] | null = values.length
    ? [Math.min(...values), Math.max(...values)]
    : null;
  const diverging = measure.colorScale === "diverging";
  const bound = extent ? Math.max(Math.abs(extent[0]), Math.abs(extent[1])) : 0;
  return (
    <View className="gap-3">
      <Text className="text-sm text-foreground">
        {measure.label} · {view.year} · {measure.unit}
      </Text>
      <View onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
        <Svg
          width={width}
          height={(width * matrixWorldMap.height) / matrixWorldMap.width}
          viewBox={`0 0 ${matrixWorldMap.width} ${matrixWorldMap.height}`}
        >
          {matrixWorldMap.countries.map((country) => {
            const row = byIso.get(country.iso3);
            const value = row?.observation?.values[measure.id];
            const selected = row !== undefined && view.entities.includes(row.entity.id);
            return (
              <Path
                key={country.iso3}
                d={country.path}
                fill={nativeResearchColor(value, extent, diverging)}
                stroke={selected ? "#facc15" : "#0f172a"}
                strokeWidth={selected ? 1.8 : 0.35}
                accessibilityLabel={`${country.name}: ${formatResearchValue(value, measure.unit)}`}
                onPress={
                  props.disabled || !row
                    ? undefined
                    : () =>
                        props.onChange({
                          ...view,
                          entities: nativeResearchFocus(view.entities, row.entity.id),
                        })
                }
              />
            );
          })}
        </Svg>
      </View>
      {extent ? (
        <>
          <View className="flex-row items-center gap-2">
            {[0, 1, 2, 3, 4].map((step) => (
              <View
                key={step}
                style={{
                  width: 24,
                  height: 12,
                  backgroundColor: nativeResearchColor(
                    diverging
                      ? -bound + (step * bound) / 2
                      : extent[0] + (step * (extent[1] - extent[0])) / 4,
                    extent,
                    diverging,
                  ),
                }}
              />
            ))}
          </View>
          <Text className="text-xs text-foreground-muted">
            {formatResearchValue(diverging ? -bound : extent[0], measure.unit, true)} →{" "}
            {formatResearchValue(diverging ? bound : extent[1], measure.unit, true)} · Gray: not
            available · Gold outline: selected
          </Text>
        </>
      ) : (
        <Text className="text-xs text-foreground-muted">
          No observations for this measure and year. Gray countries are unavailable, not zero.
        </Text>
      )}
      <Text className="text-xs text-foreground-muted">
        Tap a country to link its history and values. Use the country selector for small islands and
        World. {values.length} countries have values; World is not added to country totals.
      </Text>
      <ResearchLink url={matrixWorldMap.source.url}>
        {matrixWorldMap.source.name} · {matrixWorldMap.source.license}
      </ResearchLink>
      <Text selectable className="text-xs text-foreground-muted">
        {matrixWorldMap.source.projection}
      </Text>
      {view.entities.map((id) => (
        <View key={id} className="gap-1">
          <Text className="font-t3-semibold text-foreground">
            {dataset.entities.find((entity) => entity.id === id)?.name ?? id}
          </Text>
          <ResearchValue
            dataset={dataset}
            entityId={id}
            year={view.year}
            measure={measure}
            analyst={props.analyst}
          />
        </View>
      ))}
    </View>
  );
}

function ResearchSeries(
  props: ResearchProps & { measure: MatrixResearchMeasure; chartType: "line" | "bar" },
) {
  const { dataset, view, measure } = props;
  const [width, setWidth] = useState(300);
  const [chartType, setChartType] = useState(props.chartType);
  const series = useMemo(
    () => view.entities.map((id) => ({ id, points: researchSeries(dataset, id, measure.id) })),
    [dataset, view.entities, measure.id],
  );
  const points = series.flatMap((entry) => entry.points);
  const years = points.map((point) => point.year);
  const first = Math.min(view.year, ...years);
  const last = Math.max(view.year, ...years);
  const low = Math.min(0, ...points.map((point) => point.value));
  const high = Math.max(0, ...points.map((point) => point.value));
  const x = (year: number) => 18 + ((year - first) / (last - first || 1)) * Math.max(1, width - 36);
  const y = (value: number) => 16 + (1 - (value - low) / (high - low || 1)) * 160;
  return (
    <View className="gap-3">
      <Text className="text-sm text-foreground">
        {measure.label} · {measure.unit} · {first}–{last}
      </Text>
      <View className="flex-row gap-2">
        <ResearchChoice
          label="Line"
          selected={chartType === "line"}
          onPress={() => setChartType("line")}
        />
        <ResearchChoice
          label="Bars"
          selected={chartType === "bar"}
          onPress={() => setChartType("bar")}
        />
      </View>
      <Text className="text-xs text-foreground-muted">
        Scale: {formatResearchValue(low, measure.unit, true)} to{" "}
        {formatResearchValue(high, measure.unit, true)}
      </Text>
      {points.length ? (
        <View onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
          <Svg width={width} height={196} accessible={false}>
            <Line x1={16} x2={width - 16} y1={y(0)} y2={y(0)} stroke="#64748b" />
            <Line
              x1={x(view.year)}
              x2={x(view.year)}
              y1={12}
              y2={180}
              stroke="#94a3b8"
              strokeDasharray="4 4"
            />
            {series.flatMap((entry, seriesIndex) => {
              const color = SERIES_COLORS[seriesIndex % SERIES_COLORS.length]!;
              const barWidth = Math.max(
                1,
                Math.min(12, (width - 36) / Math.max(1, last - first + 1) / series.length),
              );
              return [
                ...(chartType === "line"
                  ? researchSeriesSegments(entry.points).map((segment) => (
                      <Polyline
                        key={`${entry.id}:line:${segment[0]!.year}`}
                        points={segment
                          .map((point) => `${x(point.year)},${y(point.value)}`)
                          .join(" ")}
                        fill="none"
                        stroke={color}
                        strokeWidth={2}
                      />
                    ))
                  : []),
                ...entry.points.map((point) =>
                  chartType === "bar" ? (
                    <Rect
                      key={`${entry.id}:${point.year}`}
                      x={
                        x(point.year) +
                        (seriesIndex - (series.length - 1) / 2) * barWidth -
                        barWidth / 2
                      }
                      y={Math.min(y(0), y(point.value))}
                      width={barWidth}
                      height={Math.max(1, Math.abs(y(0) - y(point.value)))}
                      fill={color}
                      opacity={view.year === point.year ? 1 : 0.6}
                      onPress={
                        props.disabled
                          ? undefined
                          : () => props.onChange({ ...view, year: point.year })
                      }
                    />
                  ) : (
                    <Circle
                      key={`${entry.id}:${point.year}`}
                      cx={x(point.year)}
                      cy={y(point.value)}
                      r={view.year === point.year ? 4 : 2.5}
                      fill={color}
                      onPress={
                        props.disabled
                          ? undefined
                          : () => props.onChange({ ...view, year: point.year })
                      }
                    />
                  ),
                ),
              ];
            })}
          </Svg>
        </View>
      ) : (
        <Text className="text-sm text-foreground-muted">
          No observations for these selections. Missing is not zero.
        </Text>
      )}
      <Text className="text-xs text-foreground-muted">
        Annual spacing. Lines stop at missing years; missing observations are never interpolated.
        Tap a point or choose the year above for exact values.
      </Text>
      {series.map((entry, index) => (
        <View key={entry.id} className="gap-1 rounded-xl bg-secondary p-3">
          <Text
            style={{ color: SERIES_COLORS[index % SERIES_COLORS.length] }}
            className="font-t3-semibold"
          >
            {dataset.entities.find((entity) => entity.id === entry.id)?.name ?? entry.id}
          </Text>
          <ResearchValue
            dataset={dataset}
            entityId={entry.id}
            year={view.year}
            measure={measure}
            analyst={props.analyst}
          />
        </View>
      ))}
    </View>
  );
}

function ResearchTable(props: ResearchProps & { measures: readonly string[] }) {
  const [sort, setSort] = useState({ measure: props.view.measure, descending: true });
  const [mapMeasure, setMapMeasure] = useState(props.view.measure);
  if (mapMeasure !== props.view.measure) {
    setMapMeasure(props.view.measure);
    setSort({ measure: props.view.measure, descending: true });
  }
  const [selectedOnly, setSelectedOnly] = useState(false);
  const [search, setSearch] = useState("");
  const [exact, setExact] = useState(false);
  const baseline = `${props.view.year}:${sort.measure}:${sort.descending}:${search}:${selectedOnly ? props.view.entities.join(",") : "all"}`;
  const [pagination, setPagination] = useState({ baseline, page: 0 });
  const measures = props.measures.flatMap((id) => {
    const measure = props.dataset.measures.find((candidate) => candidate.id === id);
    return measure ? [measure] : [];
  });
  const rows = useMemo(
    () => nativeResearchRows(props.dataset, props.view.year, sort),
    [props.dataset, props.view.year, sort],
  );
  const page = nativeResearchPage(rows, {
    search,
    entities: selectedOnly ? props.view.entities : null,
    page: pagination.baseline === baseline ? pagination.page : 0,
  });
  return (
    <View className="gap-3">
      <Text className="text-sm text-foreground">
        {props.view.year} · Numeric sort; missing values last. Tap a country to focus.
      </Text>
      <View className="flex-row gap-2">
        <ResearchChoice
          label="All countries / World"
          selected={!selectedOnly}
          onPress={() => setSelectedOnly(false)}
        />
        <ResearchChoice
          label="Selected"
          selected={selectedOnly}
          onPress={() => setSelectedOnly(true)}
        />
      </View>
      <TextInput
        accessibilityLabel="Search table countries"
        placeholder="Search table countries"
        value={search}
        onChangeText={setSearch}
        autoCorrect={false}
        className="min-h-11 rounded-xl border border-border-subtle px-3 text-foreground"
      />
      {!props.analyst ? (
        <Button
          label={exact ? "Show rounded table values" : "Show exact table values"}
          tone="text"
          onPress={() => setExact(!exact)}
        />
      ) : null}
      <Text className="text-xs text-foreground-muted">
        {props.analyst || exact
          ? "Exact values."
          : "Rounded for readability; exact values remain available."}{" "}
        Source definitions, derivations and links are in Dataset sources and coverage.
      </Text>
      <ScrollView horizontal nestedScrollEnabled>
        <View>
          <View className="flex-row border-b border-border-subtle py-2">
            <View style={{ width: 164 }}>
              <Text className="font-t3-semibold text-foreground">Country / aggregate</Text>
            </View>
            {measures.map((measure) => (
              <View key={measure.id} style={{ width: 164 }}>
                <ResearchChoice
                  label={`${measure.label}${sort.measure === measure.id ? (sort.descending ? " ↓" : " ↑") : ""}`}
                  selected={sort.measure === measure.id}
                  onPress={() =>
                    setSort({
                      measure: measure.id,
                      descending: sort.measure === measure.id ? !sort.descending : true,
                    })
                  }
                />
                <Text className="text-xs text-foreground-muted">{measure.unit}</Text>
              </View>
            ))}
          </View>
          {page.rows.map((row) => (
            <View key={row.entity.id} className="flex-row border-b border-border-subtle py-2">
              <View style={{ width: 164 }}>
                <ResearchChoice
                  label={row.entity.name}
                  selected={props.view.entities.includes(row.entity.id)}
                  disabled={props.disabled}
                  onPress={() =>
                    props.onChange({
                      ...props.view,
                      entities: nativeResearchFocus(props.view.entities, row.entity.id),
                    })
                  }
                />
              </View>
              {measures.map((measure) => (
                <View key={measure.id} style={{ width: 164 }} className="justify-center px-2">
                  <Text selectable className="text-sm text-foreground">
                    {formatResearchValue(
                      row.observation?.values[measure.id],
                      measure.unit,
                      !props.analyst && !exact,
                    )}
                  </Text>
                  <Text className="text-xs text-foreground-muted">
                    {row.observation?.status ?? "Flags not provided"}
                  </Text>
                </View>
              ))}
            </View>
          ))}
        </View>
      </ScrollView>
      {page.total === 0 ? (
        <Text className="text-sm text-foreground-muted">No countries match this table filter.</Text>
      ) : null}
      <Text accessibilityLiveRegion="polite" className="text-xs text-foreground-muted">
        Rows {page.first}–{page.last} of {page.total} matching countries / aggregates ·{" "}
        {rows.length} source entities · Page {page.page + 1} of {page.pageCount}
      </Text>
      <View className="flex-row gap-2">
        <Button
          label="Previous page"
          tone="text"
          disabled={page.page === 0}
          onPress={() => setPagination({ baseline, page: page.page - 1 })}
        />
        <Button
          label="Next page"
          tone="text"
          disabled={page.page + 1 >= page.pageCount}
          onPress={() => setPagination({ baseline, page: page.page + 1 })}
        />
      </View>
    </View>
  );
}

function ResearchScatter(
  props: ResearchProps & { xMeasure: MatrixResearchMeasure; yMeasure: MatrixResearchMeasure },
) {
  const [width, setWidth] = useState(300);
  const rows = useMemo(
    () =>
      nativeResearchRows(props.dataset, props.view.year, {
        measure: props.xMeasure.id,
        descending: false,
      }),
    [props.dataset, props.view.year, props.xMeasure.id],
  );
  const points = rows.flatMap((row) => {
    const x = row.observation?.values[props.xMeasure.id];
    const y = row.observation?.values[props.yMeasure.id];
    return row.entity.iso3 && x != null && y != null ? [{ entity: row.entity, x, y }] : [];
  });
  const xmin = Math.min(...points.map((point) => point.x));
  const xmax = Math.max(...points.map((point) => point.x));
  const ymin = Math.min(...points.map((point) => point.y));
  const ymax = Math.max(...points.map((point) => point.y));
  return (
    <View className="gap-3">
      <Text className="text-sm text-foreground">
        {props.view.year} · X: {props.xMeasure.label} ({props.xMeasure.unit}) · Y:{" "}
        {props.yMeasure.label} ({props.yMeasure.unit})
      </Text>
      {points.length ? (
        <>
          <View onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
            <Svg width={width} height={210} accessible={false}>
              <Line x1={18} x2={width - 18} y1={190} y2={190} stroke="#64748b" />
              <Line x1={18} x2={18} y1={16} y2={190} stroke="#64748b" />
              {points.map((point) => (
                <Circle
                  key={point.entity.id}
                  cx={18 + ((point.x - xmin) / (xmax - xmin || 1)) * (width - 36)}
                  cy={190 - ((point.y - ymin) / (ymax - ymin || 1)) * 174}
                  r={props.view.entities.includes(point.entity.id) ? 6 : 3.5}
                  fill={props.view.entities.includes(point.entity.id) ? "#facc15" : "#38bdf8"}
                  opacity={props.view.entities.includes(point.entity.id) ? 1 : 0.6}
                  onPress={
                    props.disabled
                      ? undefined
                      : () =>
                          props.onChange({
                            ...props.view,
                            entities: nativeResearchFocus(props.view.entities, point.entity.id),
                          })
                  }
                />
              ))}
            </Svg>
          </View>
          <Text className="text-xs text-foreground-muted">
            X range: {formatResearchValue(xmin, props.xMeasure.unit, true)}–
            {formatResearchValue(xmax, props.xMeasure.unit, true)}
            {"\n"}Y range: {formatResearchValue(ymin, props.yMeasure.unit, true)}–
            {formatResearchValue(ymax, props.yMeasure.unit, true)}
          </Text>
        </>
      ) : (
        <Text className="text-sm text-foreground-muted">
          No paired country observations for this year.
        </Text>
      )}
      <Text selectable className="text-xs text-foreground-muted">
        {points.length} countries have both values in the exact selected year. Missing pairs and
        aggregates are excluded. Association is not causation.
      </Text>
      {[props.xMeasure.id, props.yMeasure.id].some(
        (id) => id === "droughtIndex" || id === "EN.CLC.SPEI.XD",
      ) ? (
        <Text selectable className="text-xs text-foreground-muted">
          Annual country climate is not crop-area-weighted exposure or proof of a causal effect on
          production.
        </Text>
      ) : null}
      {props.view.entities.map((id) => (
        <View key={id} className="gap-2 rounded-xl bg-secondary p-3">
          <Text className="font-t3-semibold text-foreground">
            {props.dataset.entities.find((entity) => entity.id === id)?.name ?? id}
          </Text>
          <ResearchValue
            dataset={props.dataset}
            entityId={id}
            year={props.view.year}
            measure={props.xMeasure}
            analyst={props.analyst}
          />
          <ResearchValue
            dataset={props.dataset}
            entityId={id}
            year={props.view.year}
            measure={props.yMeasure}
            analyst={props.analyst}
          />
        </View>
      ))}
    </View>
  );
}

export function NativeResearchBlock(props: ResearchProps & { block: MatrixResearchBlock }) {
  const { block, dataset, view } = props;
  const measure = dataset.measures.find((candidate) => candidate.id === view.measure);
  const seriesMeasure =
    block.kind === "series"
      ? dataset.measures.find((candidate) => candidate.id === block.measure)
      : undefined;
  const xMeasure =
    block.kind === "scatter"
      ? dataset.measures.find((candidate) => candidate.id === block.xMeasure)
      : undefined;
  const yMeasure =
    block.kind === "scatter"
      ? dataset.measures.find((candidate) => candidate.id === block.yMeasure)
      : undefined;
  let content: ReactNode;
  switch (block.kind) {
    case "map":
      content = measure ? (
        <ResearchMap {...props} measure={measure} />
      ) : (
        <Text className="text-sm text-foreground-muted">Selected measure unavailable.</Text>
      );
      break;
    case "series":
      content = seriesMeasure ? (
        <ResearchSeries {...props} measure={seriesMeasure} chartType={block.chartType} />
      ) : (
        <Text className="text-sm text-foreground-muted">
          History measure {block.measure} unavailable.
        </Text>
      );
      break;
    case "data-table":
      content = (
        <ResearchTable {...props} measures={[...new Set([view.measure, ...block.measures])]} />
      );
      break;
    case "data-metrics": {
      const ids = [...new Set([view.measure, ...block.measures])];
      content = (
        <View className="gap-3">
          {view.entities.map((id) => (
            <View key={id} className="gap-3 rounded-xl bg-secondary p-3">
              <Text className="font-t3-semibold text-foreground">
                {dataset.entities.find((entity) => entity.id === id)?.name ?? id}
              </Text>
              {ids.map((measureId) => {
                const metric = dataset.measures.find((candidate) => candidate.id === measureId);
                return metric ? (
                  <ResearchValue
                    key={metric.id}
                    dataset={dataset}
                    entityId={id}
                    year={view.year}
                    measure={metric}
                    analyst={props.analyst}
                  />
                ) : (
                  <Text key={measureId} className="text-sm text-foreground-muted">
                    {measureId}: measure unavailable.
                  </Text>
                );
              })}
            </View>
          ))}
        </View>
      );
      break;
    }
    case "scatter":
      content =
        xMeasure && yMeasure ? (
          <ResearchScatter {...props} xMeasure={xMeasure} yMeasure={yMeasure} />
        ) : (
          <Text className="text-sm text-foreground-muted">Scatter measure unavailable.</Text>
        );
      break;
  }
  return (
    <View className="gap-3">
      <Text accessibilityRole="header" className="font-t3-semibold text-lg text-foreground">
        {researchBlockTitle(dataset, block, view)}
      </Text>
      {content}
    </View>
  );
}
