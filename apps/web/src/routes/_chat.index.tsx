import { createFileRoute, redirect } from "@tanstack/react-router";
import { HostedEmptyState } from "../components/HostedEmptyState";

export const Route = createFileRoute("/_chat/")({
  beforeLoad: ({ context }) => {
    if (context.authGateState.status === "authenticated") {
      throw redirect({ to: "/research", replace: true });
    }
  },
  component: HostedEmptyState,
});
