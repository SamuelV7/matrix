import { createFileRoute, redirect } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useScratchProject } from "../hooks/useScratchProject";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { Button } from "../components/ui/button";
import { useStableCallback } from "../hooks/useStableCallback";
import { useActiveEnvironmentId } from "../state/entities";

export const Route = createFileRoute("/research")({
  beforeLoad: ({ context }) => {
    if (context.authGateState.status !== "authenticated") {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: ResearchLanding,
});

function ResearchLanding() {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const activeEnvironmentId = useActiveEnvironmentId();
  const { environments, isReady } = useEnvironments();
  const { scratchEnvironmentId, scratchWorkspaceRootFor, startScratchThread } = useScratchProject();
  const preferredEnvironmentId =
    scratchEnvironmentId(activeEnvironmentId ?? primaryEnvironmentId) ?? scratchEnvironmentId(null);
  const attemptedEnvironment = useRef<string | null>(null);
  const [starting, setStarting] = useState(false);
  const start = useStableCallback(
    async (environmentId: (typeof environments)[number]["environmentId"]) => {
      setStarting(true);
      try {
        await startScratchThread(environmentId);
      } finally {
        setStarting(false);
      }
    },
  );
  useEffect(() => {
    if (!preferredEnvironmentId || attemptedEnvironment.current !== null) return;
    attemptedEnvironment.current = preferredEnvironmentId;
    void start(preferredEnvironmentId);
  }, [preferredEnvironmentId, start]);

  return (
    <main className="scrollbar-gutter-both flex min-h-0 flex-1 items-center justify-center overflow-auto p-6">
      <div className="w-full max-w-xl space-y-6">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
            Matrix research
          </p>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight">
            A question opens a workspace.
          </h1>
          <p className="mt-3 text-sm text-muted-foreground">
            Explore economies, population, energy, agriculture and company filings through sourced
            maps and time series. Your conversation, selections and saved research stay together.
          </p>
        </div>
        {!isReady || starting ? (
          <p role="status" className="text-sm text-muted-foreground">
            Opening your research conversation…
          </p>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Choose a connected environment to start.
            </p>
            {environments
              .filter((environment) => scratchWorkspaceRootFor(environment.environmentId) !== null)
              .map((environment) => (
                <Button
                  key={environment.environmentId}
                  variant="outline"
                  onClick={() => void start(environment.environmentId)}
                >
                  Start research · {environment.label}
                </Button>
              ))}
            {!environments.some(
              (environment) => scratchWorkspaceRootFor(environment.environmentId) !== null,
            ) ? (
              <p role="status" className="text-sm text-muted-foreground">
                Waiting for a research environment. Manage connections from the sidebar settings.
              </p>
            ) : null}
          </div>
        )}
      </div>
    </main>
  );
}
