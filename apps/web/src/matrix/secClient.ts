import type { MatrixSecCompany } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { PrimaryEnvironmentHttpClient } from "../environments/primary/httpClient";
import { runPrimaryHttp } from "../lib/runtime";

export function fetchSecCompany(
  symbol: string,
): Promise<
  | { readonly ok: true; readonly data: MatrixSecCompany }
  | { readonly ok: false; readonly message: string }
> {
  return runPrimaryHttp(
    PrimaryEnvironmentHttpClient.pipe(
      Effect.flatMap((client) => client.matrix.secCompany({ headers: {}, query: { symbol } })),
      Effect.match({
        onSuccess: (data) => ({ ok: true as const, data }),
        onFailure: (error) => ({
          ok: false as const,
          message:
            error._tag.startsWith("MatrixSec") &&
            "message" in error &&
            typeof error.message === "string"
              ? error.message
              : "Matrix could not load SEC data. Check your environment connection and try again.",
        }),
      }),
    ),
  );
}
