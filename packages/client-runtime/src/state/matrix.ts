import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export function createMatrixEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    workspace: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:matrix:workspace",
      tag: WS_METHODS.matrixSubscribeWorkspace,
      idleTtlMs: 0,
    }),
    setPinned: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:matrix:set-pinned",
      tag: WS_METHODS.matrixSetAnswerPinned,
    }),
    setView: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:matrix:set-view",
      tag: WS_METHODS.matrixSetAnswerView,
    }),
  };
}
