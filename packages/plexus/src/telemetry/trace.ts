/**
 * What PLexus records about its own work, through the OpenTelemetry API
 * alone: every call here is a no-op until the application running PLexus
 * registers an SDK. A span carries names, kinds and outcomes, never a value:
 * no argument, result, image name, path or message, and no status
 * description, since that would be a message.
 */
import {
  context,
  propagation,
  SpanStatusCode,
  trace,
  type Attributes,
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
 * `work` inside a span that is active while it runs, ended with its outcome.
 * A rejection fails the span with the type `typeOf` gives, and is passed on.
 */
export function inSpan<T>(
  name: string,
  kind: SpanKind,
  attributes: Attributes,
  work: (span: Span) => Promise<T>,
  typeOf: (error: unknown) => string = errorType,
): Promise<T> {
  return trace
    .getTracer("@evref-bl/plexus", plexusVersion)
    .startActiveSpan(name, { kind, attributes }, async (span) => {
      try {
        return await work(span);
      } catch (error) {
        failed(span, typeOf(error));
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
