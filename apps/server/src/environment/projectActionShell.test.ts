import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import type { ProjectScript } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";

import { resolveProjectAction } from "../../../../packages/client-runtime/src/projectActions.ts";
import * as ProcessRunner from "../processRunner.ts";

it.layer(NodeServices.layer)("project action shell execution", (it) => {
  it.effect("passes metacharacters literally through the platform shell", () =>
    Effect.gen(function* () {
      const platform = yield* HostProcessPlatform;
      const runner = yield* ProcessRunner.ProcessRunner;
      const windows = platform === "win32";
      const shell = windows ? "powershell.exe" : "/bin/sh";
      const name = "a b/c?x'\"; $(printf INJECTED) `printf INJECTED` $HOME \\ end";
      const templates = windows
        ? [
            "[Console]::Write({{project.name}})",
            "[Console]::Write('{{project.name}}')",
            '[Console]::Write("{{project.name}}")',
          ]
        : [
            "printf '%s' {{project.name}}",
            "printf '%s' '{{project.name}}'",
            "printf '%s' \"{{project.name}}\"",
          ];
      for (const command of templates) {
        const action: ProjectScript = {
          id: "echo",
          name: "Echo",
          command,
          icon: "play",
          runOnWorktreeCreate: false,
        };
        const resolved = resolveProjectAction(action, {
          shell,
          project: { id: "project", name, root: "/repo" },
          environment: {
            id: "environment",
            label: "Development",
            os: windows ? "windows" : "linux",
          },
        });
        const result = yield* runner.run({
          command: shell,
          args: windows ? ["-NoProfile", "-Command", resolved] : ["-c", resolved],
        });
        expect(result.code).toBe(0);
        expect(result.stdout).toBe(name);
      }
    }).pipe(Effect.provide(ProcessRunner.layer)),
  );
});
