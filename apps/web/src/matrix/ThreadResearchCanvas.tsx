import { useState } from "react";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { ConnectedAnswer } from "../components/chat/MatrixAnswerCard";
import { Button } from "../components/ui/button";
import { matrixEnvironment } from "../state/matrix";
import { useEnvironmentQuery } from "../state/query";

export interface ThreadResearchCanvasProps {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  onAsk: (prompt: string) => void;
  enabled?: boolean;
  running?: boolean;
}

export function ThreadResearchCanvas({
  environmentId,
  threadId,
  onAsk,
  enabled = true,
  running = false,
}: ThreadResearchCanvasProps) {
  const workspace = useEnvironmentQuery(
    enabled ? matrixEnvironment.workspace({ environmentId, input: { threadId } }) : null,
  );
  const [selection, setSelection] = useState<{ threadId: ThreadId; answerId: string | null }>({
    threadId,
    answerId: null,
  });
  const selectedId = selection.threadId === threadId ? selection.answerId : null;
  const answers = (workspace.data?.answers ?? []).toSorted((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
  const current = answers.find((answer) => answer.id === selectedId) ?? answers[0];
  const pinned = answers.filter((answer) => answer.pinned);
  const select = (answerId: string | null) => setSelection({ threadId, answerId });
  return (
    <section
      className="min-w-0 space-y-6 px-4 py-5 sm:px-7 sm:py-7 xl:px-10"
      aria-label="Research terminal"
    >
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-4">
        <div>
          <p className="text-3xs font-semibold uppercase tracking-widest text-primary">
            Research terminal
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            A live workspace for the question, evidence and comparisons.
          </p>
        </div>
        {answers.length ? (
          <div className="flex flex-wrap gap-2">
            <Button
              variant={selectedId === null ? "secondary" : "ghost"}
              size="compact"
              aria-pressed={selectedId === null}
              onClick={() => select(null)}
            >
              Latest research
            </Button>
            <label className="sr-only" htmlFor={`research-answer-${threadId}`}>
              Open saved research answer
            </label>
            <select
              id={`research-answer-${threadId}`}
              className="min-h-8 max-w-64 rounded-md border border-border bg-background px-2 text-xs"
              value={current?.id ?? ""}
              onChange={(event) => select(event.target.value)}
            >
              {answers.map((answer) => (
                <option key={answer.id} value={answer.id}>
                  {answer.pinned ? "Pinned · " : ""}
                  {answer.spec.title}
                </option>
              ))}
            </select>
          </div>
        ) : null}
      </header>
      {workspace.error ? (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4">
          <p role="alert" className="min-w-0 flex-1 text-sm text-destructive">
            {workspace.error}
            {current
              ? " Showing the last received answer; reconnect before retrying a failed save."
              : " No research data has been substituted."}
          </p>
          <Button variant="outline" size="sm" onClick={workspace.refresh}>
            Reconnect workspace
          </Button>
        </div>
      ) : null}
      {running ? (
        <p
          role="status"
          className="rounded-lg border border-info/20 bg-info/5 px-4 py-3 text-xs text-muted-foreground"
        >
          {current
            ? "Research is running. The current workspace remains available while new evidence is prepared."
            : "Research is running. Charts will appear when sourced data and an answer are saved."}
        </p>
      ) : null}
      {enabled && !workspace.data && !workspace.error ? (
        <p role="status" className="py-12 text-sm text-muted-foreground">
          Loading this conversation’s saved research…
        </p>
      ) : null}
      {current ? (
        <ConnectedAnswer
          key={current.id}
          answer={current}
          environmentId={environmentId}
          layout="canvas"
          onAsk={onAsk}
        />
      ) : (!enabled || workspace.data) && !workspace.error ? (
        <div className="mx-auto flex max-w-3xl flex-col items-start gap-5 py-12 sm:py-20">
          <p className="text-xs uppercase tracking-widest text-muted-foreground">
            Start with a question
          </p>
          <h2 className="max-w-xl text-3xl font-medium leading-tight sm:text-4xl">
            Explore the world through evidence.
          </h2>
          <p className="max-w-xl text-sm leading-relaxed text-muted-foreground">
            Ask an ordinary question about economies, people, energy, agriculture or the
            environment. Research can become a country map, linked historical series and sourced
            comparisons here. Your follow-ups revise the workspace, not a separate dashboard.
          </p>
          <div className="flex flex-wrap gap-2">
            {[
              "How has economic growth differed between Brazil and the United States?",
              "Compare renewable electricity across countries over time.",
              "How has corn output changed around the world?",
            ].map((prompt) => (
              <Button
                key={prompt}
                variant="outline"
                size="sm-multiline"
                disabled={running}
                onClick={() => onAsk(prompt)}
              >
                {prompt}
              </Button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            No dataset has been loaded yet. Historical source data is not a live estimate or a
            forecast.
          </p>
        </div>
      ) : null}
      {pinned.length > 0 ? (
        <nav
          className="flex flex-wrap items-center gap-2 border-t border-border pt-4"
          aria-label="Pinned research"
        >
          <span className="mr-2 text-xs text-muted-foreground">Pinned research</span>
          {pinned.map((answer) => (
            <Button
              key={answer.id}
              variant={current?.id === answer.id ? "secondary" : "ghost"}
              size="compact"
              onClick={() => select(answer.id)}
            >
              {answer.spec.title}
            </Button>
          ))}
        </nav>
      ) : null}
    </section>
  );
}
