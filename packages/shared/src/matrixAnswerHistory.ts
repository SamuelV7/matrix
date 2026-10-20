import type { MatrixAnswer } from "@t3tools/contracts";

/** Handoffs retain composition and latest evidence; full annual series stay in the durable answer. */
export function matrixAnswerHistoryText(answer: MatrixAnswer): string {
  return JSON.stringify({
    type: "matrix_answer",
    answerId: answer.id,
    revision: answer.revision,
    pinned: answer.pinned,
    spec: answer.spec,
    evidence: answer.companies.map((company) => ({
      symbol: company.symbol,
      cik: company.cik,
      name: company.name,
      metrics: company.metrics.map((metric) => ({
        id: metric.id,
        unit: metric.unit,
        latest: metric.observations.at(-1) ?? null,
      })),
      sources: company.sources,
      warnings: company.warnings,
    })),
    historyScope:
      "Latest observation per metric only. Use matrix_inspect_answers for current IDs and revisions; Matrix SEC tools retrieve the underlying financial evidence.",
  });
}
