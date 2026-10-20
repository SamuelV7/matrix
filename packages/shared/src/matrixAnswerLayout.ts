import type {
  MatrixAnswerBlock,
  MatrixAnswerCompany,
  MatrixAnswerSpec,
  MatrixMetricId,
} from "@t3tools/contracts";

export type MatrixAnswerSection = NonNullable<MatrixAnswerSpec["sections"]>[number];

/** Old persisted answers gain navigation without rewriting their event history. */
export function matrixAnswerSections(spec: MatrixAnswerSpec): readonly MatrixAnswerSection[] {
  if (spec.sections) return spec.sections;
  const groups: MatrixAnswerSection[] = [];
  const definitions = [
    {
      id: "overview",
      label: "Overview",
      columns: 2,
      kinds: ["company", "metric", "data-metrics", "actions"],
    },
    {
      id: "explore",
      label: "Explore",
      columns: 1,
      kinds: ["chart", "diagram", "map", "series", "scatter"],
    },
    { id: "numbers", label: "Numbers", columns: 1, kinds: ["table", "data-table"] },
    { id: "context", label: "Context", columns: 1, kinds: ["explanation"] },
    { id: "filings", label: "Filings", columns: 1, kinds: ["filings"] },
  ] as const;
  const ordered = spec.blocks.some((block) => "dataset" in block)
    ? [
        ...definitions.filter((group) => group.id === "explore"),
        ...definitions.filter((group) => group.id !== "explore"),
      ]
    : definitions;
  for (const group of ordered) {
    const blockIds = spec.blocks
      .filter((block) => (group.kinds as readonly string[]).includes(block.kind))
      .map((block) => block.id);
    if (blockIds.length)
      groups.push({ id: group.id, label: group.label, columns: group.columns, blockIds });
  }
  return groups;
}

/** Window each company's exact periods independently, without fabricating missing annual rows. */
export function matrixAnswerPeriodWindow(
  companies: readonly MatrixAnswerCompany[],
  metrics: readonly MatrixMetricId[],
  periods: number | undefined,
): readonly MatrixAnswerCompany[] {
  if (periods === undefined) return companies;
  const key = (observation: MatrixAnswerCompany["metrics"][number]["observations"][number]) =>
    `${observation.end}|${observation.start ?? ""}`;
  return companies.map((company) => {
    const selected = new Set(
      [
        ...new Set(
          company.metrics
            .filter((metric) => metrics.includes(metric.id))
            .flatMap((metric) => metric.observations.map(key)),
        ),
      ]
        .sort()
        .slice(-periods),
    );
    return {
      ...company,
      metrics: company.metrics.map((metric) =>
        metrics.includes(metric.id)
          ? {
              ...metric,
              observations: metric.observations.filter((value) => selected.has(key(value))),
            }
          : metric,
      ),
    };
  });
}

type Diagram = Extract<MatrixAnswerBlock, { kind: "diagram" }>;
export interface MatrixDiagramLayout {
  readonly width: number;
  readonly height: number;
  readonly nodes: readonly {
    readonly id: string;
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  }[];
  readonly edges: readonly {
    readonly from: { readonly x: number; readonly y: number };
    readonly to: { readonly x: number; readonly y: number };
    readonly label: string | undefined;
  }[];
}

/** Bounded, deterministic DAG layout shared by SVG and native SVG renderers. */
export function matrixDiagramLayout(diagram: Diagram): MatrixDiagramLayout | null {
  const nodes = new Map(diagram.nodes.map((node) => [node.id, node]));
  if (nodes.size !== diagram.nodes.length || nodes.size === 0) return null;
  const incoming = new Map(diagram.nodes.map((node) => [node.id, 0]));
  const outgoing = new Map(diagram.nodes.map((node) => [node.id, [] as string[]]));
  const seenEdges = new Set<string>();
  for (const edge of diagram.edges) {
    const key = `${edge.from}:${edge.to}`;
    if (!nodes.has(edge.from) || !nodes.has(edge.to) || edge.from === edge.to || seenEdges.has(key))
      return null;
    seenEdges.add(key);
    outgoing.get(edge.from)!.push(edge.to);
    incoming.set(edge.to, incoming.get(edge.to)! + 1);
  }
  const queue = diagram.nodes.filter((node) => incoming.get(node.id) === 0).map((node) => node.id);
  const levels = new Map(diagram.nodes.map((node) => [node.id, 0]));
  for (let index = 0; index < queue.length; index++) {
    const id = queue[index]!;
    for (const target of outgoing.get(id)!) {
      levels.set(target, Math.max(levels.get(target)!, levels.get(id)! + 1));
      const remaining = incoming.get(target)! - 1;
      incoming.set(target, remaining);
      if (remaining === 0) queue.push(target);
    }
  }
  if (queue.length !== nodes.size) return null;
  const rows: string[][] = [];
  for (const node of diagram.nodes) (rows[levels.get(node.id)!] ??= []).push(node.id);
  const width = Math.max(560, ...rows.map((row) => row.length * 190 + 40));
  const positions = rows.flatMap((row, level) =>
    row.map((id, index) => ({
      id,
      x: width / 2 - (row.length * 190) / 2 + index * 190 + 15,
      y: 20 + level * 120,
      width: 160,
      height: 64,
    })),
  );
  const byId = new Map(positions.map((position) => [position.id, position]));
  return {
    width,
    height: rows.length * 120,
    nodes: positions,
    edges: diagram.edges.map((edge) => {
      const from = byId.get(edge.from)!;
      const to = byId.get(edge.to)!;
      return {
        from: { x: from.x + from.width / 2, y: from.y + from.height },
        to: { x: to.x + to.width / 2, y: to.y },
        label: edge.label,
      };
    }),
  };
}
