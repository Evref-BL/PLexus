/**
 * Why PLexus refused. A minor release may add a code, so a program that
 * switches on them keeps a default branch.
 */
export type PlexusErrorCode =
  // An option or argument a call cannot run with, such as everyStart without
  // a script.
  | "invalid-arguments"
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

/** What a refusal adds for a program, when it has it. */
export interface PlexusErrorDetails {
  /** The VMs running the image, of a refusal because it runs, starts or takes no calls. */
  pids?: number[];
  /** The process of this host making or starting the image, of `building` and `being-started`. */
  pid?: number;
  /** The categories that hold the template's name, of `ambiguous-template`. */
  categories?: string[];
}

/**
 * Every refusal PLexus makes. The code is what a caller branches on; the
 * message is what it shows, and says what to do where there is something.
 */
export class PlexusError extends Error {
  readonly code: PlexusErrorCode;
  readonly details?: PlexusErrorDetails;

  constructor(
    code: PlexusErrorCode,
    message: string,
    details?: PlexusErrorDetails,
  ) {
    super(message);
    this.name = "PlexusError";
    this.code = code;
    if (details !== undefined) {
      this.details = details;
    }
  }
}
