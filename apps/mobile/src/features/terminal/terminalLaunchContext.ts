import type { EnvironmentId, ThreadId, ProjectScript } from "@t3tools/contracts";
import {
  resolveProjectAction,
  type ProjectActionContext,
} from "@t3tools/client-runtime/project-actions";

interface TerminalLocationLike {
  readonly cwd: string;
  readonly worktreePath: string | null;
}

interface PendingTerminalLaunchTarget {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly terminalId: string;
}

export interface PendingTerminalLaunch {
  readonly cwd: string;
  readonly worktreePath: string | null;
  readonly env?: Record<string, string>;
  readonly initialInput?: string;
  readonly action?: { readonly script: ProjectScript; readonly context: ProjectActionContext };
}

const pendingTerminalLaunches = new Map<string, PendingTerminalLaunch>();

function pendingTerminalLaunchKey(input: PendingTerminalLaunchTarget): string {
  return `${input.environmentId}:${input.threadId}:${input.terminalId}`;
}

export function stagePendingTerminalLaunch(input: {
  readonly target: PendingTerminalLaunchTarget;
  readonly launch: PendingTerminalLaunch;
}) {
  pendingTerminalLaunches.set(pendingTerminalLaunchKey(input.target), {
    cwd: input.launch.cwd,
    worktreePath: input.launch.worktreePath,
    env: input.launch.env ? { ...input.launch.env } : undefined,
    initialInput: input.launch.initialInput,
    ...(input.launch.action ? { action: input.launch.action } : {}),
  });
}

/** Quote a command for the shell the server actually opened. */
export function resolvePendingTerminalInput(
  launch: PendingTerminalLaunch,
  shell?: string,
): string | undefined {
  return launch.action
    ? `${resolveProjectAction(launch.action.script, { ...launch.action.context, shell })}\r`
    : launch.initialInput;
}

export function takePendingTerminalLaunch(
  target: PendingTerminalLaunchTarget,
): PendingTerminalLaunch | null {
  const key = pendingTerminalLaunchKey(target);
  const launch = pendingTerminalLaunches.get(key) ?? null;
  if (launch) {
    pendingTerminalLaunches.delete(key);
  }

  return launch;
}

export function resolvePreferredThreadWorktreePath(input: {
  readonly threadShellWorktreePath: string | null;
  readonly threadDetailWorktreePath: string | null;
}): string | null {
  return input.threadDetailWorktreePath ?? input.threadShellWorktreePath ?? null;
}

export function resolveTerminalOpenLocation(input: {
  readonly terminalLocation: TerminalLocationLike | null;
  readonly activeSessionLocation: TerminalLocationLike | null;
  readonly workspaceRoot: string;
  readonly threadShellWorktreePath: string | null;
  readonly threadDetailWorktreePath: string | null;
}): {
  readonly cwd: string;
  readonly worktreePath: string | null;
} {
  const preferredThreadWorktreePath = resolvePreferredThreadWorktreePath({
    threadShellWorktreePath: input.threadShellWorktreePath,
    threadDetailWorktreePath: input.threadDetailWorktreePath,
  });

  return {
    cwd:
      input.terminalLocation?.cwd ??
      input.activeSessionLocation?.cwd ??
      preferredThreadWorktreePath ??
      input.workspaceRoot,
    worktreePath:
      input.terminalLocation?.worktreePath ??
      input.activeSessionLocation?.worktreePath ??
      preferredThreadWorktreePath,
  };
}
