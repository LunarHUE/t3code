import { describe, expect, it } from "vite-plus/test";
import type { ProjectScript } from "@t3tools/contracts";
import {
  mergeProjectActions,
  resolveProjectAction,
  validateProjectActionUrl,
  type ProjectActionContext,
} from "./projectActions.ts";

const action = (
  command: string,
  kind: "url" | "command" = "command",
  id = "editor",
): ProjectScript => ({
  id,
  name: "Open editor",
  command,
  kind,
  icon: "play",
  runOnWorktreeCreate: false,
});
const context: ProjectActionContext = {
  project: { id: "project-1", name: "abstract", root: "/repos/abstract" },
  environment: { id: "dev-1", label: "Development" },
  environmentDefaults: { sshName: "dev1" },
};

describe("project actions", () => {
  it("resolves the SSH example with current project and environment values", () => {
    expect(
      resolveProjectAction(
        action(
          "vscode://vscode-remote/ssh-remote+{{project.name}}.{{env.sshName}}.repos/workspace?windowId=_blank",
          "url",
        ),
        context,
      ),
    ).toBe("vscode://vscode-remote/ssh-remote+abstract.dev1.repos/workspace?windowId=_blank");
  });
  it("prefers project variables over built-ins and client overrides over server defaults", () => {
    const resolved = resolveProjectAction(
      action(
        "https://example.test/{{project.name}}/{{env.sshName}}/{{project.id}}/{{environment.id}}/{{environment.label}}/{{project.root}}",
        "url",
      ),
      {
        ...context,
        projectVariables: { name: "alias" },
        environmentOverrides: { sshName: "override" },
      },
    );
    expect(resolved).toBe(
      "https://example.test/alias/override/project-1/dev-1/Development/%2Frepos%2Fabstract",
    );
    expect(
      resolveProjectAction(action("https://example.test/{{env.sshName}}", "url"), {
        ...context,
        environmentOverrides: { sshName: "" },
      }),
    ).toBe("https://example.test/");
  });
  it("encodes substituted delimiters in host and path without changing template delimiters", () => {
    const resolved = resolveProjectAction(
      action("vscode://vscode-remote/ssh-remote+{{project.name}}.{{env.sshName}}/workspace", "url"),
      {
        ...context,
        project: { ...context.project, name: "a b/c?x" },
      },
    );
    expect(resolved).toBe("vscode://vscode-remote/ssh-remote+a%20b%2Fc%3Fx.dev1/workspace");
    expect(new URL(resolved).search).toBe("");
  });
  it.each(["vscode", "vscode-insiders", "cursor", "http", "https"])("allows %s URLs", (scheme) => {
    expect(validateProjectActionUrl(`${scheme}://example.test/workspace`)).toBe(
      `${scheme}://example.test/workspace`,
    );
  });
  it.each(["file", "javascript", "data", "custom", "mailto"])(
    "refuses %s URLs from project actions too",
    (scheme) => {
      expect(() =>
        resolveProjectAction(action(`${scheme}://example.test/workspace`, "url"), context),
      ).toThrow("scheme");
    },
  );
  it.each([
    "project.missing",
    "env.missing",
    "environment.missing",
    "project.name.extra",
    "unknown.name",
  ])("reports unknown %s", (name) => {
    expect(() => resolveProjectAction(action(`echo {{${name}}}`), context)).toThrow(
      "Unknown action variable",
    );
  });
  it("rejects malformed template syntax but allows braces inside values", () => {
    expect(() => resolveProjectAction(action("echo {{project.name"), context)).toThrow(
      "invalid template",
    );
    expect(
      resolveProjectAction(action("echo {{project.name}}"), {
        ...context,
        projectVariables: { name: "{{literal}}" },
      }),
    ).toBe("echo '{{literal}}'");
  });
  it.each(["{{{{", "{{{{z", "{{", "{{z"])(
    "rejects whitespace-heavy unterminated templates starting with %s",
    (prefix) => {
      expect(() =>
        resolveProjectAction(
          action(`https://example.test/${prefix}${"\t".repeat(100_000)}`, "url"),
          context,
        ),
      ).toThrow("invalid template");
    },
  );
  it("resolves padded adjacent variables and rejects stray closing delimiters", () => {
    expect(
      resolveProjectAction(action("echo {{ \tproject.name\t }}{{ env.sshName }}"), context),
    ).toBe("echo 'abstract''dev1'");
    expect(() => resolveProjectAction(action("echo }}"), context)).toThrow("invalid template");
  });
  it("quotes spaces, URL delimiters, and apostrophes in POSIX command values", () => {
    expect(
      resolveProjectAction(action("echo {{project.name}}"), {
        ...context,
        projectVariables: { name: "a b/c?x" },
      }),
    ).toBe("echo 'a b/c?x'");
    expect(
      resolveProjectAction(action("echo {{project.name}}"), {
        ...context,
        projectVariables: { name: "a'b" },
      }),
    ).toBe("echo 'a'\\''b'");
  });
  it("refuses shell contexts whose quote rules differ", () => {
    expect(() =>
      resolveProjectAction(action('echo "$(printf "{{project.name}}")"'), context),
    ).toThrow("shell substitutions");
  });
  it.each([
    "echo $'{{project.name}}'",
    'echo $"{{project.name}}"',
    "echo ${prefix:-{{project.name}}}",
    "cat <<EOF\n{{project.name}}\nEOF",
    "echo ready # unmatched quote '\necho {{project.name}}",
  ])("refuses nested shell grammar in %s", (template) => {
    expect(() => resolveProjectAction(action(template), context)).toThrow("shell substitutions");
  });
  it.each(["\x03; printf INJECTED", "\x15; printf INJECTED", "a\nb", "a\tb", "\x7F"])(
    "refuses terminal controls in command substitutions",
    (name) => {
      expect(() =>
        resolveProjectAction(action("echo {{project.name}}"), {
          ...context,
          projectVariables: { name },
        }),
      ).toThrow("terminal control characters");
    },
  );
  it("refuses unknown shells and unknown Windows shells when substituting command values", () => {
    expect(() =>
      resolveProjectAction(action("echo {{project.name}}"), {
        ...context,
        shell: "cmd.exe",
      }),
    ).toThrow("terminal shell");
    expect(() =>
      resolveProjectAction(action("echo {{project.name}}"), {
        ...context,
        environment: { ...context.environment, os: "windows" },
      }),
    ).toThrow("terminal shell");
    expect(resolveProjectAction(action("echo hello"), { ...context, shell: "cmd.exe" })).toBe(
      "echo hello",
    );
  });
  it("uses PowerShell quoting for values containing apostrophes", () => {
    expect(
      resolveProjectAction(action("Write-Output {{project.name}}"), {
        ...context,
        shell: "powershell.exe",
        environment: { ...context.environment, os: "windows" },
        projectVariables: { name: "a'b" },
      }),
    ).toBe("Write-Output 'a''b'");
  });
  it("replaces global actions by id, hides them, and resets by removing overrides and hidden ids", () => {
    const global = action("https://global.test", "url");
    const override = action("https://project.test", "url");
    const local = action("pnpm test", "command", "test");
    expect(mergeProjectActions([global], [override, local], [global.id])).toEqual([
      { action: override, source: "override", hidden: true },
      { action: local, source: "project", hidden: false },
    ]);
    expect(mergeProjectActions([global], [local])).toEqual([
      { action: global, source: "global", hidden: false },
      { action: local, source: "project", hidden: false },
    ]);
  });
});
