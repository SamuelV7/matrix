import { assert, it } from "@effect/vitest";
import type {
  DesktopTelemetryRequestDesktopUpdate,
  DesktopUpdateStatusReport,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as DesktopTelemetryPublisher from "../telemetry/DesktopTelemetryPublisher.ts";
import * as DesktopRemoteUpdates from "./DesktopRemoteUpdates.ts";
import * as DesktopUpdates from "./DesktopUpdates.ts";
import { makeHarness } from "./updatesTestHarness.ts";

it.effect.each(["latest", "nightly"] as const)(
  "reports remote requests as disabled without downloading or installing on %s",
  (channel) => {
    const harness = makeHarness();
    return Effect.scoped(
      Effect.gen(function* () {
        const requests = yield* Queue.unbounded<DesktopTelemetryRequestDesktopUpdate>();
        const terminal = yield* Deferred.make<DesktopUpdateStatusReport>();
        const publisher = DesktopTelemetryPublisher.DesktopTelemetryPublisher.of({
          latest: Effect.succeedNone,
          changes: Stream.empty,
          encoded: Stream.empty,
          handleControlForSource: () => Effect.void,
          removeControlSource: () => Effect.void,
          publishUpdateReport: (report) =>
            report.requestId === "matrix-policy" && report.outcome !== undefined
              ? Deferred.succeed(terminal, report).pipe(Effect.asVoid)
              : Effect.void,
          updateRequests: Stream.fromQueue(requests),
          updateCommits: Stream.empty,
          updateCancellations: Stream.empty,
        });
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        yield* updates.setChannel(channel);
        yield* DesktopRemoteUpdates.listen.pipe(
          Effect.provideService(DesktopTelemetryPublisher.DesktopTelemetryPublisher, publisher),
        );
        yield* Queue.offer(requests, {
          version: 1,
          type: "requestDesktopUpdate",
          requestId: "matrix-policy",
        });
        const report = yield* Deferred.await(terminal);
        assert.equal(report.outcome, "failed");
        assert.equal(report.state.status, "disabled");
        assert.isFalse(report.state.enabled);
        assert.equal(report.reason, report.state.message);
        assert.equal(harness.checkCount(), 0);
        assert.equal(harness.downloadCount(), 0);
        assert.equal(harness.quitAndInstalls(), 0);
      }),
    ).pipe(Effect.provide(harness.layer));
  },
);
