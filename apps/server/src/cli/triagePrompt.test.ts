import { assert, it } from "@effect/vitest";

import { buildTriageLaunchPrompt } from "./triagePrompt.ts";

it("launch prompt stays a single argv-safe line naming the prompt file", () => {
  // The launch argument goes through cmd.exe on Windows (.cmd shims), which
  // cannot carry newlines; the playbook itself must stay on disk.
  const launch = buildTriageLaunchPrompt(
    String.raw`C:\Users\a b\.matrix\userdata\triage\x\prompt.md`,
  );
  assert.notInclude(launch, "\n");
  assert.include(launch, String.raw`C:\Users\a b\.matrix\userdata\triage\x\prompt.md`);
  assert.isBelow(launch.length, 1_000);
});
