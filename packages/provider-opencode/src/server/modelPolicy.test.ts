import { assert, describe, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  TextGenerationError,
  ThreadId,
  type ModelSelection,
  type ServerProviderModel,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type { ProviderTextGeneration } from "@t3tools/provider-core/server/textGeneration";

import { OpenCodeSettings } from "../settings.ts";
import { makeOpenCodeModelPolicy } from "./modelPolicy.ts";

const GLM = "opencode/glm-5.3-flash-free";
const DEEPSEEK = "opencode/deepseek-v4.1-flash-free";
const PAID = "anthropic/claude-sonnet";
const instanceId = ProviderInstanceId.make("opencode-test");
const selection = (model: string): ModelSelection => ({ instanceId, model });
const policy = makeOpenCodeModelPolicy([GLM, DEEPSEEK]);
const decodeOpenCodeSettings = Schema.decodeSync(OpenCodeSettings);
const model = (slug: string, extra: Partial<ServerProviderModel> = {}): ServerProviderModel => ({
  slug,
  name: slug,
  capabilities: null,
  isCustom: false,
  ...extra,
});

// These boundary doubles consume only modelSelection, not the rest of a native request.
const selectedRequest = <I extends { readonly modelSelection?: ModelSelection }, A, E, R>(
  operation: (input: I) => Effect.Effect<A, E, R>,
  model: string,
) => operation({ modelSelection: selection(model) } as I);

const openInput = (model: string): ProviderAdapter.ProviderAdapterV2OpenSessionInput => ({
  threadId: ThreadId.make("thread-test"),
  providerSessionId: ProviderSessionId.make("session-test"),
  modelSelection: selection(model),
  runtimePolicy: {
    runtimeMode: "full-access",
    interactionMode: "default",
    cwd: null,
  },
});

describe("OpenCode model allowlist", () => {
  it("defaults to unrestricted and leaves unrestricted snapshots unchanged", () => {
    assert.deepStrictEqual(decodeOpenCodeSettings({}).allowedModels, []);
    const snapshot = { models: [model(PAID, { isDefault: true })] };
    assert.strictEqual(makeOpenCodeModelPolicy([]).filterSnapshot(snapshot), snapshot);
  });

  it("filters discovered and custom models with exact slugs and replaces a removed default", () => {
    const glm = model(GLM);
    const deepseek = model(DEEPSEEK, { isCustom: true });
    const snapshot = policy.filterSnapshot({
      models: [
        model(PAID, { isDefault: true }),
        model(`other/${GLM.split("/")[1]}`),
        model(`${GLM} `),
        glm,
        deepseek,
        model("opencode/paid", { isCustom: true }),
      ],
      marker: "retained",
    });
    assert.deepStrictEqual(snapshot.models, [{ ...glm, isDefault: true }, deepseek]);
    assert.strictEqual(snapshot.marker, "retained");
    assert.strictEqual(glm.isDefault, undefined);
    assert.deepStrictEqual(policy.filterSnapshot({ models: [model(PAID)] }).models, []);
  });

  it("retains a surviving default", () => {
    const models = [model(GLM), model(DEEPSEEK, { isDefault: true })];
    assert.deepStrictEqual(policy.filterSnapshot({ models }).models, models);
  });

  it.effect(
    "rejects open before delegation and guards changed selections on every model-bearing runtime operation",
    () =>
      Effect.gen(function* () {
        let opened = 0;
        let requested = 0;
        const delegated = new ProviderAdapter.ProviderAdapterProtocolError({
          driver: ProviderDriverKind.make("opencode"),
          detail: "delegated",
        });
        const request = () =>
          Effect.sync(() => requested++).pipe(Effect.andThen(Effect.fail(delegated)));
        let currentSession = { marker: "initial" };
        const nativeRuntime = {
          get providerSession() {
            return currentSession;
          },
          ensureThread: request,
          resumeThread: request,
          startTurn: request,
          compactThread: request,
          forkThread: request,
          events: { marker: "same event stream" },
          interruptTurn: request,
        } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime;
        const runtimePrototype = { marker: "runtime prototype" };
        Object.setPrototypeOf(nativeRuntime, runtimePrototype);
        const nativeAdapter = {
          instanceId,
          driver: ProviderDriverKind.make("opencode"),
          openSession: () =>
            Effect.sync(() => {
              opened++;
              return nativeRuntime;
            }),
        } as unknown as ProviderAdapter.ProviderAdapterV2["Service"];
        const adapter = policy.wrapAdapter(nativeAdapter);
        const refused = yield* adapter.openSession(openInput(PAID)).pipe(Effect.flip);
        assert.strictEqual(refused._tag, "ProviderAdapterProtocolError");
        assert.include(refused.message, PAID);
        assert.include(refused.message, "not allowed");
        assert.strictEqual(opened, 0);

        const runtime = yield* adapter.openSession(openInput(GLM));
        assert.strictEqual(opened, 1);
        assert.strictEqual(runtime.events, nativeRuntime.events);
        assert.strictEqual(runtime.interruptTurn, nativeRuntime.interruptTurn);
        assert.strictEqual(Object.getPrototypeOf(runtime), runtimePrototype);
        assert.strictEqual<unknown>(runtime.providerSession, currentSession);
        currentSession = { marker: "updated" };
        assert.strictEqual<unknown>(runtime.providerSession, currentSession);
        const methods = [
          runtime.ensureThread,
          runtime.resumeThread,
          runtime.startTurn,
          runtime.compactThread!,
          runtime.forkThread,
        ] as const;
        for (const method of methods) {
          // All of these methods are mocked with the same selection-only boundary above.
          const run = method as (input: {
            modelSelection: ModelSelection;
          }) => Effect.Effect<never, ProviderAdapter.ProviderAdapterV2Error>;
          const error = yield* selectedRequest(run, PAID).pipe(Effect.flip);
          assert.include(error.message, "not allowed");
        }
        assert.strictEqual(requested, 0);
        for (const method of methods) {
          const run = method as (input: {
            modelSelection: ModelSelection;
          }) => Effect.Effect<never, ProviderAdapter.ProviderAdapterV2Error>;
          assert.strictEqual(yield* selectedRequest(run, DEEPSEEK).pipe(Effect.flip), delegated);
        }
        assert.strictEqual(requested, methods.length);
        assert.strictEqual(makeOpenCodeModelPolicy([]).wrapAdapter(nativeAdapter), nativeAdapter);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "rejects all text operations including titles before delegation and allows both free models",
    () =>
      Effect.gen(function* () {
        let requested = 0;
        const delegated = new TextGenerationError({ operation: "test", detail: "delegated" });
        const request = () =>
          Effect.sync(() => requested++).pipe(Effect.andThen(Effect.fail(delegated)));
        const nativeGeneration: ProviderTextGeneration = {
          generateCommitMessage: request,
          generatePrContent: request,
          generateBranchName: request,
          generateThreadTitle: request,
          generateReviewGuide: request,
        };
        const generation = policy.wrapTextGeneration(nativeGeneration);
        for (const [operation, generate] of Object.entries(generation)) {
          const run = generate as (input: {
            modelSelection: ModelSelection;
          }) => Effect.Effect<never, TextGenerationError>;
          const error = yield* selectedRequest(run, PAID).pipe(Effect.flip);
          assert.strictEqual(error.operation, operation);
          assert.include(error.detail, PAID);
          assert.include(error.detail, "not allowed");
        }
        assert.strictEqual(requested, 0);
        for (const generate of Object.values(generation)) {
          const run = generate as (input: {
            modelSelection: ModelSelection;
          }) => Effect.Effect<never, TextGenerationError>;
          for (const freeModel of [GLM, DEEPSEEK]) {
            assert.strictEqual(yield* selectedRequest(run, freeModel).pipe(Effect.flip), delegated);
          }
        }
        assert.strictEqual(requested, 10);
        assert.strictEqual(
          makeOpenCodeModelPolicy([]).wrapTextGeneration(nativeGeneration),
          nativeGeneration,
        );
      }),
  );
});
