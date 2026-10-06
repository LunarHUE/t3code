import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopConfig from "./DesktopConfig.ts";
import * as Credentials from "./DesktopAccountCredentials.ts";
import * as SafeStorage from "../electron/ElectronSafeStorage.ts";

const withStore = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  backend = "keychain",
  available = true,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-account-credentials-" });
    const layerEnvironment = DesktopEnvironment.layer({
      dirname: "/repo/apps/desktop/src",
      homeDirectory: baseDir,
      platform: "darwin",
      processArch: "arm64",
      appVersion: "1.2.3",
      appPath: "/repo",
      isPackaged: true,
      resourcesPath: "/missing/resources",
      runningUnderArm64Translation: false,
    }).pipe(
      Layer.provide(
        Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({ T3CODE_HOME: baseDir })),
      ),
    );

    const storage = Layer.succeed(SafeStorage.ElectronSafeStorage, {
      isEncryptionAvailable: Effect.succeed(available),
      selectedStorageBackend: Effect.succeed(Option.some(backend)),
      encryptString: (value) => Effect.succeed(new TextEncoder().encode(`protected:${value}`)),
      decryptString: (value) =>
        Effect.succeed(new TextDecoder().decode(value).slice("protected:".length)),
    });
    return yield* effect.pipe(
      Effect.provide(
        Credentials.layer.pipe(
          Layer.provide(Layer.mergeAll(layerEnvironment, storage, NodeServices.layer)),
        ),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

describe("encrypted account credentials", () => {
  it.effect("persists independently per relay and clears only the requested account", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* Credentials.DesktopAccountCredentials;
        expect(yield* store.read("https://one.test")).toBeNull();
        yield* store.write("https://one.test", "refresh-one");
        yield* store.write("https://two.test", "refresh-two");
        expect(yield* store.read("https://one.test/")).toBe("refresh-one");
        expect(yield* store.read("https://two.test")).toBe("refresh-two");
        yield* store.write("https://one.test", null);
        expect(yield* store.read("https://one.test")).toBeNull();
        expect(yield* store.read("https://two.test")).toBe("refresh-two");
      }),
    ),
  );
  it.effect("refuses Linux's plaintext fallback", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* Credentials.DesktopAccountCredentials;
        expect(yield* store.write("https://one.test", "secret").pipe(Effect.isFailure)).toBe(true);
        expect(yield* store.read("https://one.test")).toBeNull();
      }),
      "basic_text",
    ),
  );
  it.effect("refuses persistence without encryption and rejects non-origin keys", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* Credentials.DesktopAccountCredentials;
        expect(yield* store.write("https://one.test", "secret").pipe(Effect.isFailure)).toBe(true);
        expect(yield* store.read("https://one.test/private").pipe(Effect.isFailure)).toBe(true);
        expect(yield* store.write("http://one.test", "secret").pipe(Effect.isFailure)).toBe(true);
      }),
      "keychain",
      false,
    ),
  );
});
