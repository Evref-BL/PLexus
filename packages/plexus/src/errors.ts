export type PlexusErrorCode =
  | "invalid-name"
  | "no-such-image"
  | "image-exists"
  | "image-running"
  | "being-started"
  | "building"
  | "not-running"
  // A start of this PLexus launched the image, and its server has not said
  // where it answers yet: asking again shortly will do.
  | "starting"
  // A VM runs the image and it takes no calls through PLexus.
  | "no-endpoint"
  | "unknown-template"
  | "ambiguous-template"
  | "script-not-found"
  | "create-failed"
  | "start-failed"
  | "stop-failed"
  // A stop asked to save: the image did not save and still runs, or its VM
  // has gone without writing its image file.
  | "save-failed"
  | "stopped-unsaved"
  | "launcher-failed";

/**
 * Every refusal PLexus makes. The code is what a caller branches on; the
 * message is what it shows, and says what to do where there is something.
 */
export class PlexusError extends Error {
  readonly code: PlexusErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(
    code: PlexusErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "PlexusError";
    this.code = code;
    if (details !== undefined) {
      this.details = details;
    }
  }
}
