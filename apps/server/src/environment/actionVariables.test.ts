import { describe, expect, it } from "vite-plus/test";
import { environmentActionVariables } from "./actionVariables.ts";

describe("environment action defaults", () => {
  it("advertises only explicit values using the documented casing rule", () => {
    expect(
      environmentActionVariables({
        T3CODE_ENV_SSHNAME: "dev1",
        T3CODE_ENV_REPO_HOST: "repos.example.test",
        T3CODE_ENV_NAME: "server",
        T3CODE_ENV_EMPTY: "",
        T3CODE_ENV_MISSING: undefined,
        T3CODE_ENV_: "invalid",
        SECRET: "must not leave the server",
      }),
    ).toEqual({ sshName: "dev1", repoHost: "repos.example.test", name: "server", empty: "" });
    expect(environmentActionVariables({ T3CODE_ENV_SSH_NAME: "dev2" })).toEqual({
      sshName: "dev2",
    });
  });
});
