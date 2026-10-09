import { describe, expect, it } from "vite-plus/test";
import type { ProjectScript } from "@t3tools/contracts";
import { mergeProjectActions } from "@t3tools/client-runtime/project-actions";
import { resetProjectGlobalAction } from "./ProjectActionsSettings.logic";

const global: ProjectScript = {
  id: "open",
  name: "Open",
  command: "global-command",
  icon: "play",
  runOnWorktreeCreate: false,
};
const overridden = { ...global, command: "project-command" };
const local = { ...global, id: "local", name: "Local", command: "local-command" };

describe("reset to global action", () => {
  it("removes the override and unhides the action in one update without changing other settings", () => {
    const previous = {
      defaultProjectScripts: [overridden, local],
      hiddenGlobalActionIds: ["open", "other"],
      actionVariables: { host: "project-host" },
    };
    const next = resetProjectGlobalAction(
      previous,
      previous.defaultProjectScripts,
      previous.hiddenGlobalActionIds,
      "open",
    );
    expect(next.defaultProjectScripts).toEqual([local]);
    expect(next.hiddenGlobalActionIds).toEqual(["other"]);
    expect(next.actionVariables).toEqual(previous.actionVariables);
    expect(
      mergeProjectActions([global], next.defaultProjectScripts, next.hiddenGlobalActionIds)[0],
    ).toEqual({ action: global, source: "global", hidden: false });
    expect(previous.defaultProjectScripts).toEqual([overridden, local]);
    expect(previous.hiddenGlobalActionIds).toEqual(["open", "other"]);
  });

  it("resets a hidden inherited action using the effective action list", () => {
    const next = resetProjectGlobalAction(undefined, [overridden, local], ["open"], "open");
    expect(next.defaultProjectScripts).toEqual([local]);
    expect(next.hiddenGlobalActionIds).toEqual([]);
    expect(
      mergeProjectActions([global], next.defaultProjectScripts, next.hiddenGlobalActionIds)[0]
        ?.source,
    ).toBe("global");
  });
});
