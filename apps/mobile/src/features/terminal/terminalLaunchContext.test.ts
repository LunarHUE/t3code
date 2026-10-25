import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import {
  resolveTerminalOpenLocation,
  resolvePendingTerminalInput,
  stagePendingTerminalLaunch,
  takePendingTerminalLaunch,
} from "./terminalLaunchContext";

describe("resolveTerminalOpenLocation", () => {
  it("preserves the running terminal snapshot cwd when attaching to an existing session", () => {
    expect(
      resolveTerminalOpenLocation({
        terminalLocation: null,
        activeSessionLocation: {
          cwd: "/repo/worktrees/feature",
          worktreePath: "/repo/worktrees/feature",
        },
        workspaceRoot: "/repo/root",
        threadShellWorktreePath: null,
        threadDetailWorktreePath: "/repo/worktrees/other",
      }),
    ).toEqual({
      cwd: "/repo/worktrees/feature",
      worktreePath: "/repo/worktrees/feature",
    });
  });

  it("preserves checkout cwd and identity from the selected terminal or active session", () => {
    const checkout = { cwd: "/repo/root/packages/app", worktreePath: null };
    const threadLocation = {
      workspaceRoot: "/repo/root",
      threadShellWorktreePath: "/repo/worktrees/feature",
      threadDetailWorktreePath: "/repo/worktrees/feature",
    };

    expect(
      resolveTerminalOpenLocation({
        ...threadLocation,
        terminalLocation: checkout,
        activeSessionLocation: {
          cwd: "/repo/worktrees/other",
          worktreePath: "/repo/worktrees/other",
        },
      }),
    ).toEqual(checkout);

    expect(
      resolveTerminalOpenLocation({
        ...threadLocation,
        terminalLocation: null,
        activeSessionLocation: checkout,
      }),
    ).toEqual(checkout);
  });
});

describe("pending terminal launches", () => {
  it("resolves a staged command for the actual Windows shell and refuses unsupported shells", () => {
    const target = {
      environmentId: EnvironmentId.make("env-windows"),
      threadId: ThreadId.make("thread-action"),
      terminalId: "action-terminal",
    };
    stagePendingTerminalLaunch({
      target,
      launch: {
        cwd: "C:\\repos\\workspace",
        worktreePath: null,
        action: {
          script: {
            id: "open",
            name: "Open project",
            kind: "command",
            command: "Write-Output {{project.name}}",
            icon: "play",
            runOnWorktreeCreate: false,
          },
          context: {
            project: { id: "project", name: "a'b $x", root: "C:\\repos\\workspace" },
            environment: { id: "env-windows", label: "Windows", os: "windows" },
          },
        },
      },
    });
    const launch = takePendingTerminalLaunch(target)!;
    expect(resolvePendingTerminalInput(launch, "C:\\Program Files\\PowerShell\\7\\pwsh.exe")).toBe(
      "Write-Output 'a''b $x'\r",
    );
    expect(() => resolvePendingTerminalInput(launch, "cmd.exe")).toThrow("terminal shell");
    expect(() => resolvePendingTerminalInput(launch)).toThrow("terminal shell");
  });

  it("stages and consumes launch details for a specific terminal target", () => {
    const target = {
      environmentId: EnvironmentId.make("env-1"),
      threadId: ThreadId.make("thread-1"),
      terminalId: "term-2",
    };

    stagePendingTerminalLaunch({
      target,
      launch: {
        cwd: "/repo/worktrees/feature",
        worktreePath: "/repo/worktrees/feature",
        env: { FOO: "bar" },
        initialInput: "pnpm dev\r",
      },
    });

    expect(takePendingTerminalLaunch(target)).toEqual({
      cwd: "/repo/worktrees/feature",
      worktreePath: "/repo/worktrees/feature",
      env: { FOO: "bar" },
      initialInput: "pnpm dev\r",
    });
    expect(takePendingTerminalLaunch(target)).toBeNull();
  });
});
