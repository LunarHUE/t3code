import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as Schema from "effect/Schema";
import * as AccountCredentials from "../../app/DesktopAccountCredentials.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

class AccountCredentialSenderError extends Schema.TaggedError<AccountCredentialSenderError>()(
  "AccountCredentialSenderError",
  {},
) {
  override get message(): string {
    return "Account credential request was rejected.";
  }
}
const ensureTrustedSender = Effect.fn(function* (
  event: DesktopIpc.DesktopIpcInvokeEvent | undefined,
) {
  const main = yield* (yield* ElectronWindow.ElectronWindow).main;
  if (
    !event ||
    Option.isNone(main) ||
    main.value.webContents.id !== event.sender.id ||
    event.senderFrame?.parent !== null ||
    event.senderFrame.url !== main.value.webContents.getURL()
  ) {
    return yield* new AccountCredentialSenderError();
  }
});

export const readAccountCredential = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.READ_ACCOUNT_CREDENTIAL_CHANNEL,
  payload: Schema.String,
  result: Schema.NullOr(Schema.String),
  handler: Effect.fn(function* (relayUrl, event) {
    yield* ensureTrustedSender(event);
    return yield* (yield* AccountCredentials.DesktopAccountCredentials).read(relayUrl);
  }),
});

export const writeAccountCredential = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.WRITE_ACCOUNT_CREDENTIAL_CHANNEL,
  payload: Schema.Struct({ relayUrl: Schema.String, value: Schema.NullOr(Schema.String) }),
  result: Schema.Void,
  handler: Effect.fn(function* ({ relayUrl, value }, event) {
    yield* ensureTrustedSender(event);
    yield* (yield* AccountCredentials.DesktopAccountCredentials).write(relayUrl, value);
  }),
});
