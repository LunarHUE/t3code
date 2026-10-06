import * as Electron from "electron";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";

import { codexAuthDeliveryUrl, readCodexAuthHandoff } from "@t3tools/shared/codexAuthHandoff";
import { receiveCodexAuthCallback, CodexAuthCallbackError } from "./CodexAuthCallback.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import { providerAuthReturnUrl } from "@t3tools/shared/providerAuthReturnUrl";
import { HostProcessArguments } from "@t3tools/shared/hostProcess";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronProtocol from "../electron/ElectronProtocol.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopUserData from "./DesktopUserData.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

export class DesktopAccountAuth extends Context.Service<
  DesktopAccountAuth,
  {
    readonly configure: Effect.Effect<
      void,
      never,
      ElectronApp.ElectronApp | ElectronWindow.ElectronWindow | Scope.Scope
    >;
  }
>()("@t3tools/desktop/app/DesktopAccountAuth") {}

function acquireInstanceLock() {
  return {
    isPrimaryInstance: Electron.app.requestSingleInstanceLock(),
    cleanup: () => Electron.app.releaseSingleInstanceLock(),
  };
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const electronApp = yield* ElectronApp.ElectronApp;
  const shell = yield* ElectronShell.ElectronShell;

  // The desktop acquires Electron's profile-scoped single-instance lock.
  // Must not yield: the profile lock must precede window startup.
  const userDataPath = yield* DesktopUserData.resolveUserDataPath(environment);
  yield* electronApp.setPath("userData", userDataPath);

  const instanceLock = yield* Effect.acquireRelease(
    Effect.sync(() => acquireInstanceLock()),
    (lock) => Effect.sync(() => lock.cleanup()),
  );

  return DesktopAccountAuth.of({
    configure: Effect.gen(function* () {
      const electronApp = yield* ElectronApp.ElectronApp;
      const electronWindow = yield* ElectronWindow.ElectronWindow;
      const context = yield* Effect.context<ElectronWindow.ElectronWindow>();
      const runPromise = Effect.runPromiseWith(context);

      // The profile lock forwards OS deep links to the primary desktop.
      // A secondary instance quits before creating any windows.
      if (!instanceLock.isPrimaryInstance) {
        yield* electronApp.quit;
        return yield* Effect.interrupt;
      }

      const startProviderAuthHandoff = (value: string | undefined) => {
        if (!value) return false;
        const request = readCodexAuthHandoff(value, environment.isDevelopment);
        if (!request) return false;
        void runPromise(
          Effect.gen(function* () {
            yield* electronApp.whenReady;
            yield* Effect.tryPromise({
              try: () =>
                receiveCodexAuthCallback(
                  request.authorizationUrl,
                  (url) => runPromise(shell.openExternal(url)),
                  (callbackUrl) => codexAuthDeliveryUrl(request, callbackUrl),
                ),
              catch: () =>
                new CodexAuthCallbackError({
                  detail:
                    "Could not receive hosted web ChatGPT sign-in. Retry or use the redirect URL in the web app.",
                }),
            });
          }).pipe(
            Effect.catch(() => Effect.logWarning("Could not complete ChatGPT desktop handoff.")),
          ),
        );
        return true;
      };
      const resumeProviderAuth = (value: string | undefined) => {
        const destination = providerAuthReturnUrl(value);
        const expectedOrigin = `${ElectronProtocol.getDesktopScheme(environment.isDevelopment)}://app`;
        if (!destination?.startsWith(`${expectedOrigin}/`)) return false;
        void runPromise(
          Effect.gen(function* () {
            const mainWindow = yield* electronWindow.currentMainOrFirst;
            if (Option.isNone(mainWindow)) return;
            yield* Effect.promise(() => mainWindow.value.loadURL(destination));
            yield* electronWindow.reveal(mainWindow.value);
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Could not return to provider setup", cause),
            ),
          ),
        );
        return true;
      };
      const args = yield* HostProcessArguments;
      args.some((value) => startProviderAuthHandoff(value));
      yield* electronApp.on("open-url", (event: { preventDefault: () => void }, url: string) => {
        if (startProviderAuthHandoff(url) || resumeProviderAuth(url)) event.preventDefault();
      });
      yield* electronApp.on("second-instance", (_event: unknown, argv: readonly string[]) => {
        if (argv?.some((value) => startProviderAuthHandoff(value) || resumeProviderAuth(value)))
          return;
        void runPromise(
          Effect.gen(function* () {
            const mainWindow = yield* electronWindow.currentMainOrFirst;
            if (Option.isSome(mainWindow)) yield* electronWindow.reveal(mainWindow.value);
          }),
        );
      });
    }).pipe(Effect.withSpan("desktop.accountAuth.configure")),
  });
});

export const layer = Layer.effect(DesktopAccountAuth, make);
