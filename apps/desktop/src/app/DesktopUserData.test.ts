import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { resolveUserDataPath } from "./DesktopUserData.ts";

it.effect.each([
  { isDevelopment: false, name: "matrix" },
  { isDevelopment: true, name: "matrix-dev" },
])("isolates the $name profile without importing upstream credentials", ({ isDevelopment, name }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "matrix-profile-" });
    for (const upstream of ["t3code", "t3code-v2", "T3 Code (Alpha)", "T3 Code (Dev)"]) {
      const source = path.join(directory, upstream);
      yield* fs.makeDirectory(source);
      yield* fs.writeFileString(path.join(source, "Local State"), "upstream-credentials");
    }

    const destination = yield* resolveUserDataPath({ appDataDirectory: directory, isDevelopment });
    assert.equal(destination, path.join(directory, name));
    assert.isFalse(yield* fs.exists(destination));
    assert.equal(
      yield* fs.readFileString(path.join(directory, "t3code", "Local State")),
      "upstream-credentials",
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
