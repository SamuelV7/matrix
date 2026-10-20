import type { MatrixAnswerError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

// MCP writes recheck live caller ownership inside the orchestration command lock.
// Browser pinning intentionally has no live-run requirement; its RPC authorizes
// orchestration/operate instead. The caller check is never model-supplied input.
export const AnswerCallerCheck = Context.Reference<
  Effect.Effect<void, MatrixAnswerError> | undefined
>("t3/matrix/AnswerCallerCheck", { defaultValue: () => undefined });
