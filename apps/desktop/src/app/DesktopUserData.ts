import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

export const resolveUserDataPath = Effect.fn("desktop.userData.resolveUserDataPath")(
  function* (input: { readonly appDataDirectory: string; readonly isDevelopment: boolean }) {
    const path = yield* Path.Path;
    return path.join(input.appDataDirectory, input.isDevelopment ? "matrix-dev" : "matrix");
  },
);
