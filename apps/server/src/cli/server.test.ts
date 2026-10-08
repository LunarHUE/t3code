import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as NetService from "@t3tools/shared/Net";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { Command } from "effect/cli";
import { expect, vi } from "vite-plus/test";

import { makeCli } from "../binCli.ts";

const started = vi.hoisted(() => vi.fn());

vi.mock("../server.ts", async () => {
  const Effect = await import("effect/Effect");
  const ServerConfig = await import("../config.ts");
  return {
    runServer: Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      started(config);
    }),
  };
});

it.layer(NodeServices.layer)("attachment directory startup flags", (it) => {
  it.effect("passes --attachments-dir through the default, start, and serve commands", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cli-attachment-flags-" });
      for (const command of [[], ["start"], ["serve"]]) {
        const attachmentsDir = path.join(root, command[0] ?? "default", "attachments");
        yield* Command.runWith(makeCli(), { version: "0.0.0" })([
          ...command,
          "--base-dir",
          path.join(root, "home"),
          "--port",
          "3773",
          "--attachments-dir",
          attachmentsDir,
        ]).pipe(
          Effect.provide(
            Layer.mergeAll(
              NetService.layer,
              ConfigProvider.layer(
                ConfigProvider.fromEnv({
                  env: { T3CODE_ATTACHMENTS_DIR: path.join(root, "ignored") },
                }),
              ),
            ),
          ),
        );
        expect(started).toHaveBeenLastCalledWith(expect.objectContaining({ attachmentsDir }));
        expect((yield* fs.stat(attachmentsDir)).type).toBe("Directory");
      }
      expect(yield* fs.exists(path.join(root, "ignored"))).toBe(false);
    }),
  );
});
