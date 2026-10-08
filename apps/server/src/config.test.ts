import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { deriveServerPaths, ensureServerDirectories } from "./config.ts";

it.layer(NodeServices.layer)("attachment directory paths", (it) => {
  it.effect("defaults to the state directory for normal and development runs", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const baseDir = path.resolve("t3-test-home");
      for (const [devUrl, options, subdirectory] of [
        [undefined, {}, "userdata"],
        [new URL("http://localhost:5173"), {}, "dev"],
        [new URL("http://localhost:5173"), { baseDirIsExplicit: true }, "userdata"],
      ] as const) {
        const paths = yield* deriveServerPaths(baseDir, devUrl, options);
        expect(paths.attachmentsDir).toBe(path.join(baseDir, subdirectory, "attachments"));
      }
    }),
  );

  it.effect(
    "resolves an override and creates nested directories without moving existing files",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-attachments-paths-" });
        const baseDir = path.join(root, "home");
        const originalPaths = yield* deriveServerPaths(baseDir, undefined);
        yield* ensureServerDirectories(originalPaths);
        const originalFile = path.join(originalPaths.attachmentsDir, "existing.txt");
        yield* fs.writeFileString(originalFile, "existing attachment");
        const attachmentsDir = path.join(root, "external", "nested", "attachments");
        const paths = yield* deriveServerPaths(baseDir, undefined, {
          attachmentsDir: path.relative(process.cwd(), attachmentsDir),
        });
        expect(paths).toEqual({ ...originalPaths, attachmentsDir });
        yield* ensureServerDirectories(paths);
        expect((yield* fs.stat(attachmentsDir)).type).toBe("Directory");
        expect(yield* fs.readFileString(originalFile)).toBe("existing attachment");
        expect(yield* fs.readDirectory(attachmentsDir)).toEqual([]);
      }),
  );
});
