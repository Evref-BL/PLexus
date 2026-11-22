/**
 * What PLexus records about its own work, through the OpenTelemetry API
 * alone: every call here is a no-op until the application running PLexus
 * registers an SDK. A span carries names, kinds and outcomes, never a value:
 * no argument, result, image name, path or message, and no status
 * description, since that would be a message.
 *
 * Every span carries the `session.id` of the work it belongs to: the session
 * `plexus mcp` runs a call in, or else one made at random for the process.
 */
import { randomUUID } from "node:crypto";
import {
  context,
  createContextKey,
  propagation,
  SpanStatusCode,
  trace,
  type Attributes,
  type Context,
  type Span,
  type SpanKind,
} from "@opentelemetry/api";
import { PlexusError } from "../errors.js";
import { plexusVersion } from "../version.js";

const identifier = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;

/** A name chosen by code, kept as it is when it looks like an identifier, and `_OTHER` when it does not. */
export function identifierOrOther(name: string): string {
  return identifier.test(name) ? name : "_OTHER";
}

/**
 * The names of a call's arguments that look like identifiers, never their
 * values: those the tool declares as `plexus.argument.names`, and the others
 * as `plexus.argument.unknown_names`, so that a name the caller made up is
 * only ever in the second; the others not at all without `unknown`, when
 * what the tool declares is not known in full.
 */
export function argumentAttributes(
  args: Record<string, unknown>,
  declared: ReadonlySet<string>,
  options: { unknown?: boolean } = {},
): Attributes {
  const names = Object.keys(args).filter((name) => identifier.test(name));
  const known = names.filter((name) => declared.has(name));
  const unknown = options.unknown === false ? [] : names.filter((name) => !declared.has(name));
  return {
    ...(known.length === 0 ? {} : { "plexus.argument.names": known }),
    ...(unknown.length === 0 ? {} : { "plexus.argument.unknown_names": unknown }),
  };
}

const sessionKey = createContextKey("@evref-bl/plexus session");

let processSession: string | undefined;

/** The context with `id` as its session: on the spans made in it, and in the baggage what it forwards carries. */
export function withSession(active: Context, id: string): Context {
  return withBaggageEntry(active, "session.id", id).setValue(sessionKey, id);
}

/** The session the context runs in, or the process's own, made at random the first time it is asked for. */
export function sessionOf(active: Context): string {
  const id = active.getValue(sessionKey);
  return typeof id === "string" ? id : (processSession ??= randomUUID());
}

// A client names itself as a product does, and gives a version that starts
// with a digit.
const clientNamePattern = /^[A-Za-z][A-Za-z0-9 ._-]{0,63}$/;
const clientVersionPattern = /^\d[0-9A-Za-z.+-]{0,63}$/;

/**
 * Which agent host called, and which version of it, as its initialize
 * request named itself: each kept only when it reads as a product name or a
 * version.
 */
export function clientAttributes(client: { name?: unknown; version?: unknown } | undefined): Attributes {
  const name = client?.name;
  const version = client?.version;
  return {
    ...(typeof name === "string" && clientNamePattern.test(name) ? { "plexus.client.name": name } : {}),
    ...(typeof version === "string" && clientVersionPattern.test(version) ? { "plexus.client.version": version } : {}),
  };
}

/** Marks the span failed: status ERROR, with no description, and `error.type`. */
export function failed(span: Span, type: string): void {
  span.setAttribute("error.type", type);
  span.setStatus({ code: SpanStatusCode.ERROR });
}

/**
 * The kind of a failure: a PlexusError's code, else the error's class name.
 * Both are chosen by code, never by what the error is about.
 */
export function errorType(error: unknown): string {
  if (error instanceof PlexusError) {
    return error.code;
  }
  return error instanceof Error ? identifierOrOther(error.name) : "_OTHER";
}

/**
 * `work` inside a span that is active while it runs, ended with its outcome,
 * with the session it runs in. A rejection fails the span with the type
 * `typeOf` gives, unless it gives none, and is passed on.
 */
export function inSpan<T>(
  name: string,
  kind: SpanKind,
  attributes: Attributes,
  work: (span: Span) => Promise<T>,
  typeOf: (error: unknown) => string | undefined = errorType,
): Promise<T> {
  return trace
    .getTracer("@evref-bl/plexus", plexusVersion)
    .startActiveSpan(name, { kind, attributes: { ...attributes, "session.id": sessionOf(context.active()) } }, async (span) => {
      try {
        return await work(span);
      } catch (error) {
        const type = typeOf(error);
        if (type !== undefined) {
          failed(span, type);
        }
        throw error;
      } finally {
        span.end();
      }
    });
}

/**
 * The params with the active trace context in their `_meta`, under the
 * unprefixed `traceparent`, `tracestate` and `baggage` keys, beside whatever
 * `_meta` they already carry. Unchanged when there is no context to pass,
 * which is always the case while no SDK is registered.
 */
export function withTraceContext(
  params: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  if (Object.keys(carrier).length === 0) {
    return params;
  }
  const meta = isRecord(params?._meta) ? params._meta : {};
  return { ...params, _meta: { ...meta, ...carrier } };
}

/** The context with `key` set to `value` in its baggage, beside the entries it has. */
export function withBaggageEntry(active: Context, key: string, value: string): Context {
  const baggage = propagation.getBaggage(active) ?? propagation.createBaggage();
  return propagation.setBaggage(active, baggage.setEntry(key, { value }));
}

/** The trace context a request's `_meta` names, as the parent of what answers it. */
export function contextFromMeta(meta: unknown) {
  return propagation.extract(context.active(), isRecord(meta) ? meta : {}, {
    get: (carrier, key) => {
      const value = carrier[key];
      return typeof value === "string" ? value : undefined;
    },
    keys: (carrier) => Object.keys(carrier),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
