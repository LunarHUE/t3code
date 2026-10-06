import * as Effect from "effect/Effect";
import * as ByteSize from "effect/ByteSize";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";
import * as Option from "effect/Option";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as AuthBroker from "../auth/AuthBroker.ts";

export const layer = HttpRouter.add("*", "/auth/*", (request) =>
  Effect.gen(function* () {
    const broker = yield* AuthBroker.AuthBroker;
    const url = new URL(request.url, "https://relay.invalid");
    const body =
      request.method === "POST"
        ? yield* request.text.pipe(
            Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.fromInputUnsafe(8192)),
          )
        : "";
    const response = yield* broker.handle({
      method: request.method,
      path: url.pathname,
      query: url.search.slice(1),
      body,
      headers: request.headers,
      address: Option.getOrElse(request.remoteAddress, () => "unknown"),
    });
    return HttpServerResponse.text(response.body, {
      status: response.status,
      headers: response.headers,
    });
  }).pipe(
    Effect.catch(() =>
      HttpServerResponse.json(
        { error: "temporarily_unavailable" },
        { status: 503, headers: { "cache-control": "no-store" } },
      ),
    ),
  ),
);
