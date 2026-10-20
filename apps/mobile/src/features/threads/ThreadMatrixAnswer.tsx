import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  MatrixAnswer,
  MatrixAnswerBlock,
  MatrixAnswerCompany,
  MatrixAnswerMetric,
  MatrixMetricId,
  MatrixResearchView,
  ThreadId,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { CommandId, MessageId } from "@t3tools/contracts";
import { matrixAnswerPeriodWindow, matrixDiagramLayout } from "@t3tools/shared/matrixAnswerLayout";
import { useRef, useState, type ReactNode } from "react";
import { Modal, Pressable, ScrollView, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Circle, Line, Polyline, Rect } from "react-native-svg";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { SheetHeader } from "../../components/ui/SheetHeader";
import { flattenThemeColor } from "../../lib/mobileTheme";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { uuidv4 } from "../../lib/uuid";
import type { ThreadFeedMessage } from "../../lib/threadActivity";
import { matrixEnvironment } from "../../state/matrix";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  matrixComparisonPeriods,
  matrixCardColumns,
  matrixComparisonRows,
  matrixExactValue,
  matrixOrderedObservations,
  matrixPeriodKey,
  matrixPeriodLabel,
  matrixSafeSourceUrl,
  type MatrixObservation,
  matrixVisibleSection,
} from "./matrix-answer-presentation";
import {
  NativeResearchBlock,
  NativeResearchControls,
  NativeResearchSources,
} from "./NativeResearch";
import { nativeResearchView } from "./native-research-presentation";

function Choice(props: {
  readonly label: string;
  readonly selected: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: props.selected }}
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

function SourceLink(props: { readonly url: string; readonly children: ReactNode }) {
  const [failed, setFailed] = useState(false);
  if (!matrixSafeSourceUrl(props.url)) {
    return <Text className="text-sm text-foreground-muted">Source link unavailable</Text>;
  }
  return (
    <View>
      <Pressable
        accessibilityRole="link"
        accessibilityHint="Opens the SEC source in your browser"
        onPress={() => {
          void tryOpenExternalUrl(props.url, "matrix-answer").then((opened) => setFailed(!opened));
        }}
        className="min-h-11 justify-center py-2"
      >
        <Text className="text-sm text-primary-text underline">{props.children}</Text>
      </Pressable>
      {failed ? (
        <Text accessibilityRole="alert" className="text-sm text-danger">
          Could not open the SEC link. Tap to retry.
        </Text>
      ) : null}
    </View>
  );
}

function Observation(props: {
  readonly observation: MatrixObservation;
  readonly metric: MatrixAnswerMetric;
  readonly analyst: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const { observation, metric } = props;
  return (
    <View className="gap-1">
      <Text selectable className="font-t3-semibold text-base tabular-nums text-foreground">
        {matrixExactValue(observation.value, metric.unit)}
      </Text>
      <Text selectable className="text-sm text-foreground-muted">
        {matrixPeriodLabel(observation)}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: expanded || props.analyst }}
        onPress={() => setExpanded(!expanded)}
        className="min-h-11 justify-center"
      >
        <Text className="text-sm text-primary-text">
          {expanded || props.analyst
            ? "SEC provenance"
            : `Show ${observation.sources.length === 2 ? "both SEC sources" : "SEC source"}`}
        </Text>
      </Pressable>
      {expanded || props.analyst
        ? observation.sources.map((source) => (
            <SourceLink key={`${source.accession}:${source.tag}`} url={source.url}>
              {source.tag}
              {"\n"}Filed {source.filed} · {source.accession}
            </SourceLink>
          ))
        : null}
    </View>
  );
}

function MetricBlock(props: {
  readonly answer: MatrixAnswer;
  readonly metricId: MatrixMetricId;
  readonly analyst: boolean;
}) {
  return (
    <View className="gap-4">
      {props.answer.companies.map((company) => {
        const metric = company.metrics.find((candidate) => candidate.id === props.metricId);
        const observations = metric ? matrixOrderedObservations(metric) : [];
        const latest = observations[observations.length - 1];
        return (
          <View key={company.symbol} className="gap-2 rounded-xl bg-secondary p-3">
            <Text className="font-t3-semibold text-foreground">
              {company.symbol} · {metric?.label ?? props.metricId}
            </Text>
            {metric ? (
              <Text className="text-sm text-foreground-muted">{metric.description}</Text>
            ) : null}
            {metric && latest ? (
              <Observation observation={latest} metric={metric} analyst={props.analyst} />
            ) : (
              <Text className="text-sm text-foreground-muted">
                No reported value available. Missing is not zero.
              </Text>
            )}
          </View>
        );
      })}
    </View>
  );
}

function CompanyChart(props: {
  readonly company: MatrixAnswerCompany;
  readonly metric: MatrixAnswerMetric;
  readonly chartType: "line" | "bar";
  readonly periods: number | undefined;
  readonly analyst: boolean;
}) {
  const [recent, setRecent] = useState(true);
  const [chartType, setChartType] = useState(props.chartType);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [width, setWidth] = useState(280);
  const theme = useUniwindTheme();
  const accent = flattenThemeColor(theme["--color-primary-text"], theme["--color-screen"]);
  const axis = flattenThemeColor(theme["--color-foreground-muted"], theme["--color-screen"]);
  const all = matrixOrderedObservations(props.metric);
  const observations = recent ? all.slice(-(props.periods ?? 5)) : all;
  const selected =
    observations.find((observation) => matrixPeriodKey(observation) === selectedKey) ??
    observations[observations.length - 1];
  const min = Math.min(0, ...observations.map((observation) => observation.value));
  const max = Math.max(0, ...observations.map((observation) => observation.value));
  const span = max - min || 1;
  const plotWidth = Math.max(1, width - 32);
  const y = (value: number) => 16 + (1 - (value - min) / span) * 130;
  const x = (index: number) => 16 + ((index + 0.5) * plotWidth) / Math.max(1, observations.length);
  return (
    <View className="gap-3">
      <Text className="font-t3-semibold text-foreground">
        {props.company.symbol} · {props.metric.label} (
        {props.metric.unit === "percent" ? "%" : "USD"})
      </Text>
      <Text className="text-sm text-foreground-muted">{props.metric.description}</Text>
      <View className="flex-row flex-wrap gap-2">
        <Choice
          label={`Latest ${props.periods ?? 5}`}
          selected={recent}
          onPress={() => setRecent(true)}
        />
        <Choice label="All periods" selected={!recent} onPress={() => setRecent(false)} />
        <Choice label="Line" selected={chartType === "line"} onPress={() => setChartType("line")} />
        <Choice label="Bars" selected={chartType === "bar"} onPress={() => setChartType("bar")} />
      </View>
      {observations.length === 0 ? (
        <Text className="text-sm text-foreground-muted">No reported observations to chart.</Text>
      ) : (
        <>
          <Text className="text-xs text-foreground-muted">
            Scale: {matrixExactValue(min, props.metric.unit)} to{" "}
            {matrixExactValue(max, props.metric.unit)}
          </Text>
          <View onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
            <Svg width={width} height={166} accessible={false}>
              <Line x1={12} x2={width - 12} y1={y(0)} y2={y(0)} stroke={axis} strokeWidth={1} />
              {chartType === "line" ? (
                <Polyline
                  points={observations
                    .map((observation, index) => `${x(index)},${y(observation.value)}`)
                    .join(" ")}
                  fill="none"
                  stroke={accent}
                  strokeWidth={2}
                />
              ) : null}
              {observations.map((observation, index) => {
                const active = observation === selected;
                const barWidth = Math.max(2, Math.min(36, plotWidth / observations.length - 8));
                return chartType === "bar" ? (
                  <Rect
                    key={matrixPeriodKey(observation)}
                    x={x(index) - barWidth / 2}
                    y={Math.min(y(0), y(observation.value))}
                    width={barWidth}
                    height={Math.max(1, Math.abs(y(0) - y(observation.value)))}
                    fill={accent}
                    opacity={active ? 1 : 0.55}
                    onPress={() => setSelectedKey(matrixPeriodKey(observation))}
                  />
                ) : (
                  <Circle
                    key={matrixPeriodKey(observation)}
                    cx={x(index)}
                    cy={y(observation.value)}
                    r={active ? 7 : 5}
                    fill={accent}
                    opacity={active ? 1 : 0.55}
                    onPress={() => setSelectedKey(matrixPeriodKey(observation))}
                  />
                );
              })}
            </Svg>
          </View>
          <Text className="text-xs text-foreground-muted">
            Periods in chronological order, equally spaced. Select a period for exact values and
            sources.
          </Text>
          <ScrollView horizontal nestedScrollEnabled contentContainerStyle={{ gap: 8 }}>
            {observations.map((observation) => (
              <Choice
                key={matrixPeriodKey(observation)}
                label={matrixPeriodLabel(observation)}
                selected={observation === selected}
                onPress={() => setSelectedKey(matrixPeriodKey(observation))}
              />
            ))}
          </ScrollView>
          {selected ? (
            <Observation observation={selected} metric={props.metric} analyst={props.analyst} />
          ) : null}
        </>
      )}
    </View>
  );
}

function ComparisonTable(props: {
  readonly answer: MatrixAnswer;
  readonly metrics: readonly MatrixMetricId[];
  readonly analyst: boolean;
  readonly requestedPeriods: number | undefined;
}) {
  const [periodKey, setPeriodKey] = useState<string | null>(props.requestedPeriods ? "all" : null);
  const [window, setWindow] = useState(props.requestedPeriods);
  const companies = matrixAnswerPeriodWindow(props.answer.companies, props.metrics, window);
  const [sort, setSort] = useState<{ metric: MatrixMetricId; descending: boolean } | null>(null);
  const periods = matrixComparisonPeriods(props.answer.companies, props.metrics);
  const period = periods.find((candidate) => matrixPeriodKey(candidate) === periodKey);
  const rows = matrixComparisonRows(
    companies,
    props.metrics,
    periodKey === "all" ? "all" : period ? matrixPeriodKey(period) : null,
    sort,
  );
  return (
    <View className="gap-3">
      <Text className="font-t3-semibold text-foreground">Company comparison</Text>
      <Text className="text-sm text-foreground-muted">
        Swipe across columns; tap a metric to sort. Each cell retains its exact period, units, and
        SEC sources. A missing value is not zero.
      </Text>
      {!period && periodKey !== "all" ? (
        <Text accessibilityRole="alert" className="font-t3-semibold text-sm text-foreground">
          Latest reported per company: fiscal periods may differ; not calendar-aligned. Check each
          cell's dates before comparing.
        </Text>
      ) : (
        <Text className="text-sm text-foreground-muted">
          {periodKey === "all"
            ? "Year-by-year rows preserve each company's exact reporting periods. Missing annual data is not filled."
            : `Exact-period mode: only values for ${matrixPeriodLabel(period!)} are shown. Other fiscal periods are not substituted.`}
        </Text>
      )}
      <ScrollView horizontal nestedScrollEnabled contentContainerStyle={{ gap: 8 }}>
        <Choice
          label="Latest reported"
          selected={periodKey === null}
          onPress={() => setPeriodKey(null)}
        />
        <Choice
          label="All exact periods"
          selected={periodKey === "all" && !window}
          onPress={() => {
            setWindow(undefined);
            setPeriodKey("all");
          }}
        />
        {props.requestedPeriods ? (
          <Choice
            label={`Latest ${props.requestedPeriods} periods per company`}
            selected={periodKey === "all" && !!window}
            onPress={() => {
              setWindow(props.requestedPeriods);
              setPeriodKey("all");
            }}
          />
        ) : null}
        {periods.map((candidate) => (
          <Choice
            key={matrixPeriodKey(candidate)}
            label={matrixPeriodLabel(candidate)}
            selected={matrixPeriodKey(candidate) === periodKey}
            onPress={() => {
              setWindow(undefined);
              setPeriodKey(matrixPeriodKey(candidate));
            }}
          />
        ))}
      </ScrollView>
      {periods.length === 0 ? (
        <Text className="text-sm text-foreground-muted">No reported periods available.</Text>
      ) : null}
      <ScrollView horizontal nestedScrollEnabled>
        <View>
          <View className="flex-row border-b border-border-subtle">
            <View style={{ width: 120 }} className="justify-center p-2">
              <Text className="font-t3-semibold text-foreground">Company</Text>
            </View>
            {props.metrics.map((id) => {
              const metric = props.answer.companies
                .flatMap((company) => company.metrics)
                .find((candidate) => candidate.id === id);
              return (
                <Pressable
                  key={id}
                  accessibilityRole="button"
                  accessibilityLabel={`Sort ${metric?.label ?? id}${sort?.metric === id && sort.descending ? " ascending" : " descending"}`}
                  onPress={() =>
                    setSort({ metric: id, descending: sort?.metric !== id || !sort.descending })
                  }
                  style={{ width: 220 }}
                  className="min-h-11 justify-center p-2"
                >
                  <Text className="font-t3-semibold text-primary-text">
                    {metric?.label ?? id}
                    {sort?.metric === id ? (sort.descending ? " ↓" : " ↑") : " ↕"}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          {rows.map(({ company, cells, periodKey: rowPeriod }) => (
            <View
              key={`${company.symbol}:${rowPeriod ?? "latest"}`}
              className="flex-row border-b border-border-subtle"
            >
              <View style={{ width: 120 }} className="p-2">
                <Text className="font-t3-semibold text-foreground">{company.symbol}</Text>
                <Text className="text-xs text-foreground-muted">{company.name}</Text>
              </View>
              {cells.map(({ id, metric, observation }) => (
                <View key={id} style={{ width: 220 }} className="p-2">
                  {metric && observation ? (
                    <Observation
                      observation={observation}
                      metric={metric}
                      analyst={props.analyst}
                    />
                  ) : (
                    <Text className="text-sm text-foreground-muted">
                      {period
                        ? "Not available for this exact period"
                        : "No reported value available"}
                    </Text>
                  )}
                </View>
              ))}
            </View>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

function CompanyBlock(props: { readonly answer: MatrixAnswer }) {
  return (
    <View className="gap-3">
      {props.answer.companies.map((company) => (
        <View key={company.symbol} className="gap-2 rounded-xl bg-secondary p-3">
          <Text className="font-t3-semibold text-lg text-foreground">{company.name}</Text>
          <Text selectable className="text-sm text-foreground-muted">
            {company.symbol} · CIK {company.cik}
          </Text>
          {company.profile ? (
            <Text selectable className="text-sm text-foreground">
              {[
                company.profile.industry,
                company.profile.exchanges.join(", "),
                company.profile.tickers.join(", "),
                company.profile.sic ? `SIC ${company.profile.sic}` : null,
                company.profile.fiscalYearEnd
                  ? `Fiscal year end ${company.profile.fiscalYearEnd}`
                  : null,
              ]
                .filter(Boolean)
                .join("\n")}
            </Text>
          ) : (
            <Text className="text-sm text-foreground-muted">
              Additional SEC company profile unavailable.
            </Text>
          )}
          <Text className="text-xs text-foreground-muted">Company identity from SEC records.</Text>
        </View>
      ))}
    </View>
  );
}

function DiagramBlock(props: { readonly block: Extract<MatrixAnswerBlock, { kind: "diagram" }> }) {
  const { block } = props;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const layout = matrixDiagramLayout(block);
  const selected = block.nodes.find((node) => node.id === selectedId) ?? block.nodes[0];
  const theme = useUniwindTheme();
  const line = flattenThemeColor(theme["--color-foreground-muted"], theme["--color-screen"]);
  return (
    <View className="gap-3">
      <Text className="font-t3-semibold text-foreground">{block.title}</Text>
      <Text className="text-xs text-foreground-muted">
        Qualitative interpretation, not a reported allocation or quantitative breakdown. Select a
        node for details.
      </Text>
      {layout ? (
        <ScrollView horizontal nestedScrollEnabled>
          <View style={{ width: layout.width, height: layout.height }}>
            <Svg width={layout.width} height={layout.height} accessible={false}>
              {layout.edges.map((edge) => (
                <Line
                  key={`${edge.from.x}:${edge.from.y}:${edge.to.x}:${edge.to.y}`}
                  x1={edge.from.x}
                  y1={edge.from.y}
                  x2={edge.to.x}
                  y2={edge.to.y}
                  stroke={line}
                  strokeWidth={2}
                />
              ))}
            </Svg>
            {layout.nodes.map((node) => {
              const content = block.nodes.find((candidate) => candidate.id === node.id)!;
              return (
                <Pressable
                  key={node.id}
                  accessibilityRole="button"
                  accessibilityState={{ selected: selected?.id === node.id }}
                  accessibilityLabel={content.label}
                  accessibilityHint={content.detail}
                  onPress={() => setSelectedId(node.id)}
                  style={{
                    position: "absolute",
                    left: node.x,
                    top: node.y,
                    width: node.width,
                    height: node.height,
                  }}
                  className={
                    selected?.id === node.id
                      ? "items-center justify-center rounded-xl border border-primary-text bg-secondary px-2"
                      : "items-center justify-center rounded-xl border border-border-subtle bg-screen px-2"
                  }
                >
                  <Text numberOfLines={2} className="text-center text-sm text-foreground">
                    {content.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </ScrollView>
      ) : (
        <Text className="text-sm text-foreground-muted">
          Diagram layout unavailable. Node details remain below.
        </Text>
      )}
      {!layout
        ? block.nodes.map((node) => (
            <Choice
              key={node.id}
              label={node.label}
              selected={selected?.id === node.id}
              onPress={() => setSelectedId(node.id)}
            />
          ))
        : null}
      {block.edges.length > 0 ? (
        <View className="gap-1">
          {block.edges.map((edge) => (
            <Text key={`${edge.from}:${edge.to}`} className="text-xs text-foreground-muted">
              {block.nodes.find((node) => node.id === edge.from)?.label} →{" "}
              {block.nodes.find((node) => node.id === edge.to)?.label}
              {edge.label ? `: ${edge.label}` : ""}
            </Text>
          ))}
        </View>
      ) : null}
      {selected ? (
        <View className="gap-1 rounded-xl bg-secondary p-3">
          <Text className="font-t3-semibold text-foreground">{selected.label}</Text>
          <Text selectable accessibilityLiveRegion="polite" className="text-sm text-foreground">
            {selected.detail}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

function FollowupBlock(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly block: Extract<MatrixAnswerBlock, { kind: "actions" }>;
}) {
  const canSend = useAtomValue(
    orchestrationEnvironment.v2.dispatchCommand.permissionAtom(props.environmentId),
  );
  const dispatch = useAtomCommand(orchestrationEnvironment.v2.dispatchCommand, {
    label: "send research follow-up",
    reportFailure: false,
  });
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sending = useRef(false);
  const send = async (prompt: string) => {
    if (!canSend || sending.current) return;
    sending.current = true;
    setPending(prompt);
    setError(null);
    try {
      const result = await dispatch({
        environmentId: props.environmentId,
        input: {
          type: "message.dispatch",
          commandId: CommandId.make(uuidv4()),
          messageId: MessageId.make(uuidv4()),
          threadId: props.threadId,
          createdBy: "user",
          creationSource: "mobile",
          text: prompt,
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
        },
      });
      if (result._tag !== "Success") {
        const cause = squashAtomCommandFailure(result);
        setError(cause instanceof Error ? cause.message : "Could not send follow-up. Try again.");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not send follow-up. Try again.");
    } finally {
      sending.current = false;
      setPending(null);
    }
  };
  return (
    <View className="gap-2">
      <Text className="font-t3-semibold text-foreground">{props.block.title}</Text>
      <Text className="text-xs text-foreground-muted">
        Sends the exact prompt below to this conversation.
      </Text>
      {props.block.prompts.map((prompt) => (
        <Pressable
          key={prompt}
          accessibilityRole="button"
          accessibilityState={{ disabled: !canSend || pending !== null }}
          disabled={!canSend || pending !== null}
          onPress={() => {
            void send(prompt);
          }}
          className="min-h-11 justify-center rounded-xl border border-border-subtle p-3"
        >
          <Text className="text-sm text-primary-text">{prompt}</Text>
          {pending === prompt ? (
            <Text accessibilityRole="progressbar" className="text-xs text-foreground-muted">
              Sending…
            </Text>
          ) : null}
        </Pressable>
      ))}
      {!canSend ? (
        <Text className="text-sm text-foreground-muted">
          This connection does not have permission to send follow-ups.
        </Text>
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" className="text-sm text-danger">
          {error}
        </Text>
      ) : null}
    </View>
  );
}

function AnswerBlock(props: {
  readonly answer: MatrixAnswer;
  readonly block: MatrixAnswerBlock;
  readonly analyst: boolean;
  readonly environmentId: EnvironmentId;
  readonly researchDisabled: boolean;
  readonly onResearchChange: (datasetId: string, view: MatrixResearchView) => void;
}) {
  const { answer, block, analyst } = props;
  const [allFilings, setAllFilings] = useState(false);
  switch (block.kind) {
    case "map":
    case "series":
    case "data-table":
    case "data-metrics":
    case "scatter": {
      const dataset = answer.datasets?.find((candidate) => candidate.id === block.dataset);
      if (!dataset) {
        return (
          <Text accessibilityRole="alert" className="text-sm text-danger">
            Dataset {block.dataset} is unavailable. Reconnect to read the latest answer.
          </Text>
        );
      }
      const view = nativeResearchView(answer, dataset);
      return (
        <NativeResearchBlock
          dataset={dataset}
          block={block}
          view={view}
          analyst={analyst}
          disabled={props.researchDisabled}
          onChange={(next) => props.onResearchChange(dataset.id, next)}
        />
      );
    }
    case "company":
      return <CompanyBlock answer={answer} />;
    case "diagram":
      return <DiagramBlock block={block} />;
    case "actions":
      return (
        <FollowupBlock
          environmentId={props.environmentId}
          threadId={answer.threadId}
          block={block}
        />
      );
    case "metric":
      return <MetricBlock answer={answer} metricId={block.metric} analyst={analyst} />;
    case "chart":
      return (
        <View className="gap-5">
          {answer.companies.map((company) => {
            const metric = company.metrics.find((candidate) => candidate.id === block.metric);
            return metric ? (
              <CompanyChart
                key={`${company.symbol}:${block.metric}:${block.chartType}:${block.periods}`}
                company={company}
                metric={metric}
                chartType={block.chartType}
                periods={block.periods}
                analyst={analyst}
              />
            ) : (
              <Text key={company.symbol} className="text-sm text-foreground-muted">
                {company.symbol}: {block.metric} data unavailable.
              </Text>
            );
          })}
        </View>
      );
    case "table":
      return (
        <ComparisonTable
          key={`${block.metrics.join(",")}:${block.periods}`}
          answer={answer}
          metrics={block.metrics}
          analyst={analyst}
          requestedPeriods={block.periods}
        />
      );
    case "explanation":
      return (
        <View className="gap-2">
          <Text className="font-t3-semibold text-foreground">{block.title}</Text>
          <Text selectable className="text-base text-foreground">
            {block.text}
          </Text>
          <Text className="text-xs text-foreground-muted">
            Interpretation, not a source observation.
          </Text>
        </View>
      );
    case "filings":
      return (
        <View className="gap-3">
          <Text className="font-t3-semibold text-foreground">{block.title}</Text>
          <Text className="text-xs text-foreground-muted">
            Recent company filings include all forms. Expand a value for its exact source filing.
          </Text>
          {answer.companies.map((company) => (
            <View key={company.symbol}>
              <Text className="font-t3-semibold text-foreground">{company.symbol}</Text>
              {company.filings.length === 0 ? (
                <Text className="text-sm text-foreground-muted">No filings available.</Text>
              ) : (
                (allFilings ? company.filings : company.filings.slice(0, 6)).map((filing) => (
                  <SourceLink key={filing.accession} url={filing.url}>
                    {filing.form} · Filed {filing.filed}
                    {"\n"}Report date {filing.reportDate ?? "not available"}
                    {analyst ? `\n${filing.accession} · ${filing.document}` : ""}
                  </SourceLink>
                ))
              )}
            </View>
          ))}
          {answer.companies.some((company) => company.filings.length > 6) ? (
            <Button
              label={allFilings ? "Show recent filings" : "Show all filings"}
              tone="text"
              onPress={() => setAllFilings(!allFilings)}
            />
          ) : null}
        </View>
      );
  }
}

type MatrixAgentNote = ThreadFeedMessage;

function AgentNotes(props: {
  readonly notes?: readonly MatrixAgentNote[];
  readonly renderNote?: (note: MatrixAgentNote) => ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  if (!props.notes?.length) return null;
  return (
    <View className="gap-2">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded(!expanded)}
        className="min-h-11 justify-center"
      >
        <Text className="text-sm text-primary-text">
          {expanded ? "Hide" : "Show"} additional agent notes ({props.notes.length})
        </Text>
      </Pressable>
      {expanded ? (
        <ScrollView nestedScrollEnabled style={{ maxHeight: 320 }}>
          {props.notes.map((note) => (
            <View key={note.id} className="gap-1 py-2">
              {props.renderNote ? (
                props.renderNote(note)
              ) : (
                <Text selectable className="text-sm text-foreground">
                  {note.text}
                </Text>
              )}
              {note.streaming ? (
                <Text className="text-xs text-foreground-muted">Updating…</Text>
              ) : null}
            </View>
          ))}
        </ScrollView>
      ) : null}
    </View>
  );
}

function AnswerCard(props: {
  readonly environmentId: EnvironmentId;
  readonly answer: MatrixAnswer;
  readonly onWorkspace?: () => void;
  readonly refreshWorkspace: () => void;
  readonly additionalNotes?: readonly MatrixAgentNote[];
  readonly renderAdditionalNote?: (note: MatrixAgentNote) => ReactNode;
}) {
  const { answer, environmentId } = props;
  const [detail, setDetail] = useState({ baseline: answer.spec.level, value: answer.spec.level });
  const [provenance, setProvenance] = useState(false);
  const [showWarnings, setShowWarnings] = useState(false);
  const [summaryExpanded, setSummaryExpanded] = useState(false);
  const [selectedSectionId, setSelectedSectionId] = useState<string | null>(null);
  const [panelWidth, setPanelWidth] = useState(280);
  const [pending, setPending] = useState(false);
  const mutationPending = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<MatrixAnswer | null>(null);
  const current =
    saved && saved.id === answer.id && saved.revision > answer.revision ? saved : answer;
  const level = detail.baseline === current.spec.level ? detail.value : current.spec.level;
  if (detail.baseline !== current.spec.level) {
    setDetail({ baseline: current.spec.level, value: current.spec.level });
  }
  const [presentationRun, setPresentationRun] = useState(current.lastPresentedRunId);
  if (presentationRun !== current.lastPresentedRunId) {
    setPresentationRun(current.lastPresentedRunId);
    setSelectedSectionId(null);
  }
  const { sections, selected } = matrixVisibleSection(current.spec, selectedSectionId);
  const columns = matrixCardColumns(panelWidth, selected?.columns ?? 1);
  const canPin = useAtomValue(matrixEnvironment.setPinned.permissionAtom(environmentId));
  const setPinned = useAtomCommand(matrixEnvironment.setPinned, {
    label: "save Matrix pin",
    reportFailure: false,
  });
  const canSetView = useAtomValue(matrixEnvironment.setView.permissionAtom(environmentId));
  const setView = useAtomCommand(matrixEnvironment.setView, {
    label: "save research view",
    reportFailure: false,
  });
  const changeResearchView = async (datasetId: string, view: MatrixResearchView) => {
    if (!canSetView || mutationPending.current) return;
    mutationPending.current = true;
    setPending(true);
    setError(null);
    try {
      const result = await setView({
        environmentId,
        input: {
          threadId: current.threadId,
          answerId: current.id,
          expectedRevision: current.revision,
          datasetId,
          view,
        },
      });
      if (result._tag === "Success") setSaved(result.value);
      else {
        const cause = squashAtomCommandFailure(result);
        setError(
          cause instanceof Error
            ? cause.message
            : "Could not save this view. Read the latest revision and try again.",
        );
        props.refreshWorkspace();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save this view. Try again.");
      props.refreshWorkspace();
    } finally {
      mutationPending.current = false;
      setPending(false);
    }
  };
  const warnings = current.companies.flatMap((company) =>
    company.warnings.map((warning) => `${company.symbol}: ${warning}`),
  );
  const togglePinned = async () => {
    if (!canPin || mutationPending.current) return;
    mutationPending.current = true;
    setPending(true);
    setError(null);
    try {
      const result = await setPinned({
        environmentId,
        input: {
          threadId: current.threadId,
          answerId: current.id,
          expectedRevision: current.revision,
          pinned: !current.pinned,
        },
      });
      if (result._tag === "Success") setSaved(result.value);
      else {
        const cause = squashAtomCommandFailure(result);
        setError(
          cause instanceof Error
            ? cause.message
            : "Could not save the pin. Read the latest revision and try again.",
        );
        props.refreshWorkspace();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the pin. Try again.");
      props.refreshWorkspace();
    } finally {
      mutationPending.current = false;
      setPending(false);
    }
  };
  return (
    <View className="my-3 gap-4 rounded-2xl border border-border-subtle bg-screen p-4">
      <Text accessibilityRole="header" className="font-t3-semibold text-xl text-foreground">
        {current.spec.title}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: summaryExpanded }}
        onPress={() => setSummaryExpanded(!summaryExpanded)}
      >
        <Text
          selectable
          numberOfLines={summaryExpanded ? undefined : 2}
          className="text-sm text-foreground"
        >
          {current.spec.summary}
        </Text>
        <Text className="text-xs text-primary-text">
          {summaryExpanded ? "Less summary" : "Read summary"}
        </Text>
      </Pressable>
      <Text className="text-xs text-foreground-muted">
        Revision {current.revision} · Updated {current.updatedAt}
        {current.pinned ? " · Pinned" : ""}
      </Text>
      <View className="flex-row flex-wrap gap-2">
        <Choice
          label="Guided"
          selected={level === "guided"}
          onPress={() => setDetail({ baseline: current.spec.level, value: "guided" })}
        />
        <Choice
          label="Analyst"
          selected={level === "analyst"}
          onPress={() => setDetail({ baseline: current.spec.level, value: "analyst" })}
        />
      </View>
      <View className="flex-row flex-wrap gap-2">
        <Button
          label={current.pinned ? "Unpin answer" : "Pin answer"}
          loading={pending}
          disabled={!canPin || pending}
          onPress={() => {
            void togglePinned();
          }}
        />
        {props.onWorkspace ? (
          <Button label="Pinned workspace" tone="text" onPress={props.onWorkspace} />
        ) : null}
      </View>
      {!canPin ? (
        <Text className="text-sm text-foreground-muted">
          This connection does not have permission to change pins.
        </Text>
      ) : null}
      {error ? (
        <View className="gap-2">
          <Text accessibilityRole="alert" className="text-sm text-danger">
            {error}
          </Text>
          <Button label="Read latest revision" tone="text" onPress={props.refreshWorkspace} />
        </View>
      ) : null}
      {pending ? (
        <Text accessibilityRole="progressbar" className="text-xs text-foreground-muted">
          Saving research state…
        </Text>
      ) : null}
      {(current.datasets?.length ?? 0) > 0 && !canSetView ? (
        <Text className="text-sm text-foreground-muted">
          This connection can read research but does not have permission to change saved views.
        </Text>
      ) : null}
      {current.spec.queries
        ?.filter((query) => !current.datasets?.some((dataset) => dataset.id === query.id))
        .map((query) => (
          <Text key={query.id} accessibilityRole="alert" className="text-sm text-danger">
            Research dataset {query.id} has not loaded. Read the latest revision or retry the
            research request.
          </Text>
        ))}
      {current.datasets?.map((dataset) => (
        <NativeResearchControls
          key={`${dataset.id}:${current.lastPresentedRunId ?? ""}`}
          dataset={dataset}
          view={nativeResearchView(current, dataset)}
          disabled={!canSetView || pending}
          analyst={level === "analyst"}
          onChange={(view) => {
            void changeResearchView(dataset.id, view);
          }}
        />
      ))}
      {current.companies.length === 0 &&
      (current.spec.symbols.length > 0 ||
        current.spec.blocks.some(
          (block) =>
            block.kind === "company" ||
            block.kind === "metric" ||
            block.kind === "chart" ||
            block.kind === "table" ||
            block.kind === "filings",
        )) ? (
        <Text className="text-sm text-foreground-muted">
          No company data was returned for this answer.
        </Text>
      ) : null}
      {warnings.length > 0 ? (
        <View className="gap-1">
          <Button
            label={`${showWarnings ? "Hide" : "Show"} data warnings (${warnings.length})`}
            tone="text"
            onPress={() => setShowWarnings(!showWarnings)}
          />
          {showWarnings
            ? warnings.map((warning) => (
                <Text key={warning} className="text-sm text-foreground-muted">
                  {warning}
                </Text>
              ))
            : null}
        </View>
      ) : null}
      <ScrollView horizontal nestedScrollEnabled contentContainerStyle={{ gap: 8 }}>
        {sections.map((section) => (
          <Choice
            key={section.id}
            label={section.label}
            selected={selected?.id === section.id}
            onPress={() => setSelectedSectionId(section.id)}
          />
        ))}
      </ScrollView>
      <ScrollView
        key={selected?.id}
        nestedScrollEnabled
        style={current.datasets?.length ? undefined : { maxHeight: 360 }}
        onLayout={(event) => setPanelWidth(event.nativeEvent.layout.width)}
      >
        <View className="flex-row flex-wrap gap-3">
          {selected?.blockIds.map((id) => {
            const block = current.spec.blocks.find((candidate) => candidate.id === id);
            return block ? (
              <View
                key={`${block.id}:${current.lastPresentedRunId ?? ""}`}
                style={{
                  width: columns === 1 ? "100%" : (panelWidth - 12 * (columns - 1)) / columns,
                }}
                className="rounded-xl border border-border-subtle p-3"
              >
                <AnswerBlock
                  environmentId={environmentId}
                  answer={current}
                  block={block}
                  analyst={level === "analyst"}
                  researchDisabled={!canSetView || pending}
                  onResearchChange={(datasetId, view) => {
                    void changeResearchView(datasetId, view);
                  }}
                />
              </View>
            ) : null;
          })}
        </View>
      </ScrollView>
      <AgentNotes notes={props.additionalNotes} renderNote={props.renderAdditionalNote} />
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: provenance }}
        onPress={() => setProvenance(!provenance)}
        className="min-h-11 justify-center"
      >
        <Text className="text-sm text-primary-text">
          {provenance ? "Hide research provenance" : "Research provenance"}
        </Text>
      </Pressable>
      {provenance ? (
        <View className="gap-3">
          {level === "guided" && current.companies.length > 0 ? (
            <Text className="text-sm text-foreground-muted">
              Values come from SEC filings, not model estimates. USD means US dollars; % means
              percent. Each value shows its exact reporting period. Open its source to check the
              filing.
            </Text>
          ) : null}
          {current.companies.map((company) => (
            <View key={company.symbol}>
              <Text className="font-t3-semibold text-foreground">
                {company.symbol} · {company.name} · CIK {company.cik}
              </Text>
              {company.sources.length ? (
                company.sources.map((source) => (
                  <SourceLink key={`${source.url}:${source.label}`} url={source.url}>
                    {source.label} · Retrieved {source.fetchedAt}
                  </SourceLink>
                ))
              ) : (
                <Text className="text-sm text-foreground-muted">
                  No company-level source metadata available.
                </Text>
              )}
            </View>
          ))}
          {current.datasets?.map((dataset) => (
            <NativeResearchSources key={dataset.id} dataset={dataset} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

function PinnedWorkspace(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [showAll, setShowAll] = useState(false);
  const workspace = useEnvironmentQuery(
    matrixEnvironment.workspace({
      environmentId: props.environmentId,
      input: { threadId: props.threadId },
    }),
  );
  const answers = workspace.data?.answers.filter((answer) => showAll || answer.pinned) ?? [];
  return (
    <Modal
      visible
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={props.onClose}
    >
      <GestureHandlerRootView style={{ flex: 1 }}>
        <View
          className="flex-1 bg-screen"
          style={{ paddingTop: insets.top, paddingBottom: insets.bottom }}
        >
          <SheetHeader
            presentation="inline"
            title="Research workspace"
            onClose={props.onClose}
            accessibilityLabel="Close research workspace"
          />
          <ScrollView
            className="flex-1"
            contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 24 }}
          >
            <Text className="text-sm text-foreground-muted">
              Saved to this conversation on the connected environment. Follow-up answers update
              these same views.
            </Text>
            <View className="my-3 flex-row flex-wrap gap-2">
              <Choice label="Pinned" selected={!showAll} onPress={() => setShowAll(false)} />
              <Choice label="All answers" selected={showAll} onPress={() => setShowAll(true)} />
            </View>
            {workspace.isPending ? (
              <Text accessibilityRole="progressbar" className="py-4 text-sm text-foreground-muted">
                Loading workspace…
              </Text>
            ) : null}
            {workspace.error ? (
              <View className="gap-3 py-4">
                <Text accessibilityRole="alert" className="text-sm text-danger">
                  {workspace.error}
                </Text>
                <Button label="Reconnect workspace" onPress={workspace.refresh} />
              </View>
            ) : null}
            {workspace.data && answers.length === 0 ? (
              <Text className="py-6 text-base text-foreground-muted">
                {showAll
                  ? "No research answers in this conversation yet."
                  : "No pinned answers yet. Choose All answers to find and pin saved research."}
              </Text>
            ) : null}
            {answers.map((answer) => (
              <AnswerCard
                key={answer.id}
                environmentId={props.environmentId}
                answer={answer}
                refreshWorkspace={workspace.refresh}
              />
            ))}
          </ScrollView>
        </View>
      </GestureHandlerRootView>
    </Modal>
  );
}

export function MatrixWorkspaceButton(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const [open, setOpen] = useState(false);
  return (
    <View className="items-center py-3">
      <Button label="Research workspace" tone="text" onPress={() => setOpen(true)} />
      {open ? (
        <PinnedWorkspace
          environmentId={props.environmentId}
          threadId={props.threadId}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </View>
  );
}

export function ThreadMatrixAnswer(props: {
  readonly environmentId: EnvironmentId;
  readonly answer: MatrixAnswer;
  readonly additionalNotes?: readonly MatrixAgentNote[];
  readonly renderAdditionalNote?: (note: MatrixAgentNote) => ReactNode;
}) {
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const workspace = useEnvironmentQuery(
    matrixEnvironment.workspace({
      environmentId: props.environmentId,
      input: { threadId: props.answer.threadId },
    }),
  );
  const latest = workspace.data?.answers.find((answer) => answer.id === props.answer.id);
  const answer = latest && latest.revision >= props.answer.revision ? latest : props.answer;
  const missing =
    workspace.isSuccess &&
    !workspace.data?.answers.some((candidate) => candidate.id === props.answer.id);
  return (
    <View>
      {workspace.error ? (
        <View className="gap-2">
          <Text accessibilityRole="alert" className="text-sm text-danger">
            Workspace unavailable: {workspace.error}
          </Text>
          <Button label="Reconnect workspace" tone="text" onPress={workspace.refresh} />
        </View>
      ) : null}
      {missing ? (
        <View className="my-3 gap-3 rounded-2xl border border-border-subtle p-4">
          <Text className="text-base text-foreground-muted">
            This research answer is no longer available.
          </Text>
          <Button label="Pinned workspace" onPress={() => setWorkspaceOpen(true)} />
          <AgentNotes notes={props.additionalNotes} renderNote={props.renderAdditionalNote} />
        </View>
      ) : (
        <AnswerCard
          key={`${props.environmentId}:${answer.id}`}
          environmentId={props.environmentId}
          answer={answer}
          onWorkspace={() => setWorkspaceOpen(true)}
          refreshWorkspace={workspace.refresh}
          additionalNotes={props.additionalNotes}
          renderAdditionalNote={props.renderAdditionalNote}
        />
      )}
      {workspaceOpen ? (
        <PinnedWorkspace
          environmentId={props.environmentId}
          threadId={answer.threadId}
          onClose={() => setWorkspaceOpen(false)}
        />
      ) : null}
    </View>
  );
}
