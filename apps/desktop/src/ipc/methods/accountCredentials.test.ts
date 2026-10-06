import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Electron from "electron";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as Credentials from "../../app/DesktopAccountCredentials.ts";
import { readAccountCredential, writeAccountCredential } from "./accountCredentials.ts";

const appUrl = "t3://app/";
const main = { webContents: { id: 42, getURL: () => appUrl } } as Electron.BrowserWindow;
const fixture = Layer.mergeAll(
  Layer.succeed(ElectronWindow.ElectronWindow, {
    main: Effect.succeedSome(main),
  } as ElectronWindow.ElectronWindow["Service"]),
  Layer.succeed(Credentials.DesktopAccountCredentials, {
    read: () => Effect.succeed("protected-credential"),
    write: () => Effect.void,
  }),
);

describe("account credential IPC boundary", () => {
  it.effect("allows the current main frame", () =>
    Effect.gen(function* () {
      const event = { sender: { id: 42 }, senderFrame: { parent: null, url: appUrl } };
      expect(yield* readAccountCredential.handler("https://relay.test", event)).toBe(
        "protected-credential",
      );
      yield* writeAccountCredential.handler({ relayUrl: "https://relay.test", value: null }, event);
    }).pipe(Effect.provide(fixture)),
  );
  it.effect("rejects another window, a child frame, and a navigated frame", () =>
    Effect.gen(function* () {
      const events = [
        { sender: { id: 9 }, senderFrame: { parent: null, url: appUrl } },
        { sender: { id: 42 }, senderFrame: { parent: {}, url: appUrl } },
        { sender: { id: 42 }, senderFrame: { parent: null, url: "https://untrusted.test/" } },
        { sender: { id: 42 } },
      ];
      for (const event of events) {
        expect(
          yield* readAccountCredential.handler("https://relay.test", event).pipe(Effect.isFailure),
        ).toBe(true);
        expect(
          yield* writeAccountCredential
            .handler({ relayUrl: "https://relay.test", value: "secret" }, event)
            .pipe(Effect.isFailure),
        ).toBe(true);
      }
    }).pipe(Effect.provide(fixture)),
  );
});
