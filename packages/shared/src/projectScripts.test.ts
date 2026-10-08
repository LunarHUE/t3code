import type { ProjectScript } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { setupProjectScript } from "./projectScripts.ts";

describe("project setup scripts", () => {
  it("never launches a URL action as an automatic server command", () => {
    const url: ProjectScript = {
      id: "url",
      name: "Open editor",
      kind: "url",
      command: "vscode://workspace",
      icon: "play",
      runOnWorktreeCreate: true,
    };
    const command: ProjectScript = {
      id: "setup",
      name: "Setup",
      command: "pnpm install",
      icon: "play",
      runOnWorktreeCreate: true,
    };
    expect(setupProjectScript([url])).toBeNull();
    expect(setupProjectScript([url, command])).toBe(command);
  });
});
