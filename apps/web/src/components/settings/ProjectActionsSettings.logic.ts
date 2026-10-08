import type { ProjectScript, ProjectSettingsOverrides } from "@t3tools/contracts";

/** Remove the project action and unhide the global action in the same override update. */
export function resetProjectGlobalAction(
  previous: ProjectSettingsOverrides | undefined,
  scripts: readonly ProjectScript[],
  hiddenIds: readonly string[],
  id: string,
) {
  return {
    ...previous,
    defaultProjectScripts: scripts.filter((script) => script.id !== id),
    hiddenGlobalActionIds: hiddenIds.filter((hiddenId) => hiddenId !== id),
  };
}
