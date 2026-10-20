import * as Schema from "effect/Schema";

const SecObservation = Schema.Struct({
  start: Schema.NullOr(Schema.String),
  end: Schema.String,
  value: Schema.Number,
  filed: Schema.String,
  form: Schema.String,
  accession: Schema.String,
  tag: Schema.String,
  url: Schema.String,
});

export const MatrixSecCompany = Schema.Struct({
  company: Schema.Struct({
    cik: Schema.String,
    name: Schema.String,
    tickers: Schema.Array(Schema.String),
    exchanges: Schema.Array(Schema.String),
    sic: Schema.NullOr(Schema.String),
    industry: Schema.NullOr(Schema.String),
    fiscalYearEnd: Schema.NullOr(Schema.String),
  }),
  filings: Schema.Array(
    Schema.Struct({
      form: Schema.String,
      filed: Schema.String,
      reportDate: Schema.NullOr(Schema.String),
      accession: Schema.String,
      document: Schema.String,
      url: Schema.String,
    }),
  ),
  metrics: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      label: Schema.String,
      description: Schema.String,
      unit: Schema.String,
      observations: Schema.Array(SecObservation),
    }),
  ),
  sources: Schema.Array(
    Schema.Struct({
      label: Schema.String,
      url: Schema.String,
      fetchedAt: Schema.String,
    }),
  ),
  warnings: Schema.Array(Schema.String),
});
export type MatrixSecCompany = typeof MatrixSecCompany.Type;

export class MatrixSecInvalidSymbol extends Schema.TaggedError<MatrixSecInvalidSymbol>()(
  "MatrixSecInvalidSymbol",
  {},
  { httpApiStatus: 400 },
) {
  override get message() {
    return "Enter an SEC ticker, such as AAPL, or a CIK of 1 to 10 digits.";
  }
}

export class MatrixSecNotFound extends Schema.TaggedError<MatrixSecNotFound>()(
  "MatrixSecNotFound",
  {},
  { httpApiStatus: 404 },
) {
  override get message() {
    return "This company was not found in SEC data. Try its CIK instead.";
  }
}

export class MatrixSecRateLimited extends Schema.TaggedError<MatrixSecRateLimited>()(
  "MatrixSecRateLimited",
  {},
  { httpApiStatus: 429 },
) {
  override get message() {
    return "SEC access is temporarily rate limited. Please try again later.";
  }
}

export class MatrixSecUnavailable extends Schema.TaggedError<MatrixSecUnavailable>()(
  "MatrixSecUnavailable",
  {},
  { httpApiStatus: 503 },
) {
  override get message() {
    return "The Matrix data service is unavailable. Start Matrix with SEC_USER_AGENT configured using vp run dev.";
  }
}

export class MatrixSecUpstreamError extends Schema.TaggedError<MatrixSecUpstreamError>()(
  "MatrixSecUpstreamError",
  {},
  { httpApiStatus: 502 },
) {
  override get message() {
    return "SEC data could not be retrieved or decoded. No substitute data was used.";
  }
}
