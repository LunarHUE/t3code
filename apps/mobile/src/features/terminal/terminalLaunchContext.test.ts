import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import {
  resolvePreferredThreadWorktreePath,
  resolveTerminalOpenLocation,
  resolvePendingTerminalInput,
  stagePendingTerminalLaunch,
  takePendingTerminalLaunch,
} from "./terminalLaunchContext";

describe("resolvePreferredThreadWorktreePath", () => {
  it("prefers thread detail worktree paths over thread shell paths", () => {
    expect(
      resolvePreferredThreadWorktreePath({
        threadShellWorktreePath: "/repo/root",
        threadDetailWorktreePath: "/repo/worktrees/feature",
      }),
    ).toBe("/repo/worktrees/feature");
  });

  it("falls back to the thread shell worktree path when detail is unavailable", () => {
    expect(
      resolvePreferredThreadWorktreePath({
        threadShellWorktreePath: "/repo/worktrees/feature",
        threadDetailWorktreePath: null,
      }),
    ).toBe("/repo/worktrees/feature");
  });
});

describe("resolveTerminalOpenLocation", () => {
  it("uses the thread detail worktree path before the workspace root for a fresh mobile open", () => {
    expect(
      resolveTerminalOpenLocation({
        terminalLocation: null,
        activeSessionLocation: null,
        workspaceRoot: "/repo/root",
        threadShellWorktreePath: null,
        threadDetailWorktreePath: "/repo/worktrees/feature",
      }),
    ).toEqual({
      cwd: "/repo/worktrees/feature",
      worktreePath: "/repo/worktrees/feature",
    });
  });

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

  it("keeps pending launches isolated per terminal target", () => {
    const primaryTarget = {
      environmentId: EnvironmentId.make("env-1"),
      threadId: ThreadId.make("thread-1"),
      terminalId: "term-2",
    };
    const otherTarget = {
      environmentId: EnvironmentId.make("env-1"),
      threadId: ThreadId.make("thread-1"),
      terminalId: "term-3",
    };

    stagePendingTerminalLaunch({
      target: primaryTarget,
      launch: {
        cwd: "/repo/root",
        worktreePath: null,
        initialInput: "pnpm i\r",
      },
    });

    expect(takePendingTerminalLaunch(otherTarget)).toBeNull();
    expect(takePendingTerminalLaunch(primaryTarget)).toEqual({
      cwd: "/repo/root",
      worktreePath: null,
      env: undefined,
      initialInput: "pnpm i\r",
    });
  });
});
