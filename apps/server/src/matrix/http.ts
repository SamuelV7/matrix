import {
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
  MatrixSecInvalidSymbol,
  MatrixSecNotFound,
  MatrixSecRateLimited,
  MatrixSecUnavailable,
  MatrixSecUpstreamError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { annotateEnvironmentRequest, requireEnvironmentScope } from "../auth/http.ts";
import * as SecData from "./SecData.ts";

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "matrix",
  Effect.fnUntraced(function* (handlers) {
    const sec = yield* SecData.SecData;
    return handlers.handle(
      "secCompany",
      Effect.fn("matrix.sec.company")(function* (args) {
        yield* annotateEnvironmentRequest(args.endpoint.name);
        yield* requireEnvironmentScope(AuthOrchestrationReadScope);
        return yield* sec.company(args.query.symbol).pipe(
          Effect.mapError((error) => {
            switch (error.reason) {
              case "invalid_symbol":
                return new MatrixSecInvalidSymbol({});
              case "not_found":
                return new MatrixSecNotFound({});
              case "rate_limited":
                return new MatrixSecRateLimited({});
              case "unavailable":
                return new MatrixSecUnavailable({});
              case "upstream":
                return new MatrixSecUpstreamError({});
            }
          }),
        );
      }),
    );
  }),
);
