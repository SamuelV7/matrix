import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import * as DesktopUpdates from "./DesktopUpdates.ts";
import { makeHarness } from "./updatesTestHarness.ts";

describe("Matrix desktop distribution policy", () => {
  it.effect.each(["darwin", "linux", "win32"] as const)(
    "never starts release checks or installs on %s, including mock-feed configuration",
    (platform) => {
      const harness = makeHarness({ platform, packageType: "deb" });
      return Effect.scoped(
        Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;
          const reason = yield* updates.disabledReason;
          assert.isTrue(Option.isSome(reason));
          const state = yield* updates.getState;
          assert.isFalse(state.enabled);
          assert.equal(state.status, "disabled");
          assert.equal(state.message, Option.getOrThrow(reason));
          assert.isFalse((yield* updates.check("manual")).checked);
          assert.isFalse((yield* updates.download).accepted);
          assert.isFalse((yield* updates.install).accepted);
          assert.isFalse((yield* updates.installPrepared("9.0.0")).accepted);
          yield* TestClock.adjust("10 minutes");
          assert.equal(harness.listenerCount(), 0);
          assert.equal(harness.checkCount(), 0);
          assert.equal(harness.downloadCount(), 0);
          assert.equal(harness.quitAndInstalls(), 0);
        }),
      ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
    },
  );

  it.effect("keeps every channel disabled and publishes truthful state", () => {
    const harness = makeHarness();
    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        for (const channel of ["nightly", "latest"] as const) {
          const state = yield* updates.setChannel(channel);
          assert.equal(state.channel, channel);
          assert.equal(state.status, "disabled");
          assert.isFalse(state.enabled);
          assert.equal(harness.sentStates.at(-1)?.status, "disabled");
        }
        assert.equal(harness.checkCount(), 0);
      }),
    ).pipe(Effect.provide(harness.layer));
  });
});
