import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

export class AccountCredentialStorageError extends Schema.TaggedError<AccountCredentialStorageError>()(
  "AccountCredentialStorageError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not access encrypted account credentials. Check that the system keyring is available.";
  }
}

export class DesktopAccountCredentials extends Context.Service<
  DesktopAccountCredentials,
  {
    readonly read: (
      relayUrl: string,
    ) => Effect.Effect<string | null, AccountCredentialStorageError>;
    readonly write: (
      relayUrl: string,
      value: string | null,
    ) => Effect.Effect<void, AccountCredentialStorageError>;
  }
>()("@t3tools/desktop/app/DesktopAccountCredentials") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const storage = yield* ElectronSafeStorage.ElectronSafeStorage;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const directory = path.join(environment.stateDir, "account-credentials");
  const fileFor = Effect.fn(function* (relayUrl: string) {
    const origin = yield* Effect.try(() => {
      const url = new URL(relayUrl);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.pathname !== "/" ||
        url.search ||
        url.hash
      ) {
        throw new Error("Expected an HTTPS relay origin");
      }
      return url.origin;
    });
    const digest = yield* crypto.digest("SHA-256", new TextEncoder().encode(origin));
    const key = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    return path.join(directory, `${key}.bin`);
  });
  const requireEncryption = Effect.gen(function* () {
    const available = yield* storage.isEncryptionAvailable;
    const backend = yield* storage.selectedStorageBackend;
    if (!available || Option.getOrNull(backend) === "basic_text") {
      return yield* Effect.fail(
        new AccountCredentialStorageError({ cause: new Error("Secure keyring unavailable") }),
      );
    }
  });
  return DesktopAccountCredentials.of({
    read: Effect.fn(
      function* (relayUrl) {
        const file = yield* fileFor(relayUrl);
        if (!(yield* fs.exists(file))) return null;
        yield* requireEncryption;
        return yield* storage.decryptString(yield* fs.readFile(file));
      },
      Effect.mapError((cause) => new AccountCredentialStorageError({ cause })),
    ),
    write: Effect.fn(
      function* (relayUrl, value) {
        const file = yield* fileFor(relayUrl);
        if (value === null) {
          yield* fs.remove(file, { force: true });
          return;
        }
        if (value.length > 32_768)
          return yield* Effect.fail(
            new AccountCredentialStorageError({
              cause: new Error("Credential exceeds size limit"),
            }),
          );
        yield* requireEncryption;
        const encrypted = yield* storage.encryptString(value);
        yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
        const temporary = `${file}.${yield* crypto.randomUUIDv4}.tmp`;
        yield* fs.writeFile(temporary, encrypted, { mode: 0o600 });
        yield* fs
          .rename(temporary, file)
          .pipe(Effect.ensuring(fs.remove(temporary, { force: true }).pipe(Effect.ignore)));
      },
      Effect.mapError((cause) => new AccountCredentialStorageError({ cause })),
    ),
  });
});

export const layer = Layer.effect(DesktopAccountCredentials, make);
