import { MatrixSecCompany } from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/http";

export class SecDataFailure extends Schema.TaggedError<SecDataFailure>()("SecDataFailure", {
  reason: Schema.Literals([
    "invalid_symbol",
    "not_found",
    "rate_limited",
    "unavailable",
    "upstream",
  ]),
  cause: Schema.optional(Schema.Defect()),
}) {}

export class SecData extends Context.Service<
  SecData,
  {
    readonly company: (symbol: string) => Effect.Effect<MatrixSecCompany, SecDataFailure>;
  }
>()("t3/matrix/SecData") {}

const make = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const configuredUrl = yield* Config.option(Config.String("MATRIX_DATA_URL"));
  const configuredToken = yield* Config.option(Config.String("MATRIX_DATA_TOKEN"));
  const baseUrl = Option.getOrUndefined(configuredUrl);
  const token = Option.getOrUndefined(configuredToken);
  // This is a private local process boundary, not an arbitrary HTTP proxy.
  const endpoint = baseUrl === undefined ? undefined : URL.parse(baseUrl);
  const configured =
    endpoint !== undefined &&
    endpoint !== null &&
    endpoint.protocol === "http:" &&
    endpoint.hostname === "127.0.0.1" &&
    endpoint.pathname === "/" &&
    !endpoint.username &&
    !endpoint.password &&
    !endpoint.search &&
    !endpoint.hash &&
    token !== undefined &&
    token.length >= 32;

  const company = Effect.fn("SecData.company")(function* (input: string) {
    const symbol = input.trim().toUpperCase();
    if (
      !/^(?:[A-Z][A-Z0-9.-]{0,19}|(?:CIK:)?[0-9]{1,10})$/.test(symbol) ||
      (/^(?:CIK:)?[0-9]+$/.test(symbol) && Number(symbol.replace(/^CIK:/, "")) === 0)
    ) {
      return yield* new SecDataFailure({ reason: "invalid_symbol" });
    }
    if (!configured || !endpoint || !token) {
      return yield* new SecDataFailure({ reason: "unavailable" });
    }
    const url = new URL("/sec/company", endpoint);
    url.searchParams.set("symbol", symbol);
    const response = yield* client
      .get(url.href, {
        headers: { authorization: `Bearer ${token}` },
      })
      .pipe(
        Effect.timeout("105 seconds"),
        Effect.mapError((cause) => new SecDataFailure({ reason: "unavailable", cause })),
      );
    if (response.status !== 200) {
      const reason =
        response.status === 400
          ? "invalid_symbol"
          : response.status === 404
            ? "not_found"
            : response.status === 429
              ? "rate_limited"
              : response.status === 503
                ? "unavailable"
                : "upstream";
      return yield* new SecDataFailure({ reason });
    }
    return yield* response.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(MatrixSecCompany)),
      Effect.mapError((cause) => new SecDataFailure({ reason: "upstream", cause })),
    );
  });
  return SecData.of({ company });
});

export const layer = Layer.effect(SecData, make);
