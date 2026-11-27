import { SpanKind } from "@opentelemetry/api";
import { inSpan } from "../telemetry/trace.js";
import type {
  CreateOptions,
  CreateResult,
  DeleteResult,
  Endpoint,
  ImageInfo,
  ImagesOptions,
  StartOptions,
  StartResult,
  StopOptions,
  StopResult,
  Template,
} from "../types.js";
import { imagesContext, type ImagesContext } from "./context.js";
import { create } from "./create.js";
import { deleteImage } from "./delete.js";
import { endpointOf } from "./endpoint.js";
import { answeringFromEndpoints, list, type Answering } from "./list.js";
import { start } from "./start.js";
import { stop } from "./stop.js";
import { templates } from "./templates.js";

/**
 * Pharo images as directories and processes.
 *
 * An image exists when its directory holds its image file; it runs when a VM
 * runs that file. Every call looks at the store and the host when it is made,
 * so, like `ps`, its answer is as old as the call that gave it.
 *
 * Making, starting, stopping and deleting are each an INTERNAL span,
 * `plexus.image.create`, `.start`, `.stop` and `.delete`, that says how it
 * ended and nothing of the image.
 */
export class Images {
  private readonly context: ImagesContext;

  constructor(options: ImagesOptions = {}) {
    this.context = imagesContext(options);
  }

  templates(): Promise<Template[]> {
    return templates(this.context);
  }

  /** The VM each look saw answering for an image, by image name. */
  private readonly seen = new Map<string, number>();

  async list(name?: string): Promise<ImageInfo[]> {
    const rows = await list(this.context, name);
    for (const row of rows) {
      if (row.state === "running" && row.endpoint?.pid !== undefined) {
        this.seen.set(row.name, row.endpoint.pid);
      } else {
        this.seen.delete(row.name);
      }
    }
    return rows;
  }

  /**
   * Where a forwarded call goes, when an earlier look saw the VM that
   * answers for it and that VM still runs: the image named, or, naming
   * none, the only image that answers. Undefined when only `list` can say.
   *
   * @internal `plexus mcp`'s routing, left out of the published types.
   */
  answering(name?: string): Answering | undefined {
    return answeringFromEndpoints(this.context, this.seen, name);
  }

  create(name: string, options: CreateOptions = {}): Promise<CreateResult> {
    return inSpan("plexus.image.create", SpanKind.INTERNAL, {}, async (span) => {
      const { fromBase, ...created } = await create(this.context, name, options);
      span.setAttribute("plexus.image.from_base", fromBase);
      return created;
    });
  }

  start(name: string, options?: StartOptions): Promise<StartResult> {
    return inSpan("plexus.image.start", SpanKind.INTERNAL, {}, () => start(this.context, name, options));
  }

  /** Have the image quit without saving and kill what is left, or, with `save`, have it save itself and quit. */
  stop(name: string, options?: StopOptions): Promise<StopResult> {
    return inSpan("plexus.image.stop", SpanKind.INTERNAL, { "plexus.image.save": options?.save === true }, () =>
      stop(this.context, name, options),
    );
  }

  delete(name: string): Promise<DeleteResult> {
    return inSpan("plexus.image.delete", SpanKind.INTERNAL, {}, () => deleteImage(this.context, name));
  }

  /** Where a call to the image goes, or a refusal saying why none can and what to do. */
  async endpoint(name: string): Promise<Endpoint> {
    return endpointOf((await this.list(name))[0]);
  }
}
