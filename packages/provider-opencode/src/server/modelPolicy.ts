import {
  ProviderDriverKind,
  TextGenerationError,
  type ModelSelection,
  type ServerProviderModel,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type { ProviderTextGeneration } from "@t3tools/provider-core/server/textGeneration";

/** The catalog and all model-bearing request boundaries share the same exact-slug policy. */
export function makeOpenCodeModelPolicy(allowedModels: readonly string[]) {
  const allowed = new Set(allowedModels);
  const unrestricted = allowed.size === 0;
  const rejection = (selection: ModelSelection | undefined) =>
    selection === undefined || unrestricted || allowed.has(selection.model)
      ? undefined
      : `OpenCode model '${selection.model}' is not allowed for this provider instance`;

  const guard =
    <I extends { readonly modelSelection?: ModelSelection }, A, E, R, F>(
      operation: (input: I) => Effect.Effect<A, E, R>,
      error: (detail: string) => F,
    ) =>
    (input: I): Effect.Effect<A, E | F, R> =>
      Effect.suspend<A, E | F, R>(() => {
        const detail = rejection(input.modelSelection);
        return detail === undefined ? operation(input) : Effect.fail(error(detail));
      });
  const protocolError = (detail: string) =>
    new ProviderAdapter.ProviderAdapterProtocolError({
      driver: ProviderDriverKind.make("opencode"),
      detail,
    });

  return {
    filterSnapshot: <S extends { readonly models: readonly ServerProviderModel[] }>(
      snapshot: S,
    ): S => {
      if (unrestricted) return snapshot;
      const models = snapshot.models.filter((model) => allowed.has(model.slug));
      // Removing the discovered default must not leave the remaining catalog without one.
      if (models.length > 0 && !models.some((model) => model.isDefault)) {
        models[0] = { ...models[0]!, isDefault: true };
      }
      return { ...snapshot, models };
    },
    wrapAdapter: (
      adapter: ProviderAdapter.ProviderAdapterV2["Service"],
    ): ProviderAdapter.ProviderAdapterV2["Service"] => {
      if (unrestricted) return adapter;
      return {
        ...adapter,
        openSession: guard(
          (input: ProviderAdapter.ProviderAdapterV2OpenSessionInput) =>
            adapter.openSession(input).pipe(
              Effect.map((runtime): ProviderAdapter.ProviderAdapterV2SessionRuntime => {
                const guarded = {
                  ensureThread: guard(runtime.ensureThread, protocolError),
                  resumeThread: guard(runtime.resumeThread, protocolError),
                  startTurn: guard(runtime.startTurn, protocolError),
                  ...(runtime.compactThread === undefined
                    ? {}
                    : { compactThread: guard(runtime.compactThread, protocolError) }),
                  forkThread: guard(runtime.forkThread, protocolError),
                };
                // providerSession is a live getter in the v2 runtime, not a snapshot.
                return Object.create(Object.getPrototypeOf(runtime), {
                  ...Object.getOwnPropertyDescriptors(runtime),
                  ...Object.getOwnPropertyDescriptors(guarded),
                });
              }),
            ),
          protocolError,
        ),
      };
    },
    wrapTextGeneration: (generation: ProviderTextGeneration): ProviderTextGeneration => {
      if (unrestricted) return generation;
      const protect = <I extends { readonly modelSelection: ModelSelection }, A>(
        operation: string,
        generate: (input: I) => Effect.Effect<A, TextGenerationError>,
      ) => guard(generate, (detail) => new TextGenerationError({ operation, detail }));
      return {
        generateCommitMessage: protect("generateCommitMessage", generation.generateCommitMessage),
        generatePrContent: protect("generatePrContent", generation.generatePrContent),
        generateBranchName: protect("generateBranchName", generation.generateBranchName),
        generateThreadTitle: protect("generateThreadTitle", generation.generateThreadTitle),
        generateReviewGuide: protect("generateReviewGuide", generation.generateReviewGuide),
      };
    },
  };
}
