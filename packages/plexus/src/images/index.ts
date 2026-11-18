import type {
  CreateOptions,
  Endpoint,
  ImageInfo,
  ImagesOptions,
  StartOptions,
  StopOptions,
  Template,
} from "../types.js";
import { imagesContext, type ImagesContext } from "./context.js";
import { create, type CreateResult } from "./create.js";
import { deleteImage } from "./delete.js";
import { endpointOf } from "./endpoint.js";
import { list } from "./list.js";
import { start, type StartResult } from "./start.js";
import { stop, type StopResult } from "./stop.js";
import { templates } from "./templates.js";

/**
 * Pharo images as directories and processes.
 *
 * An image exists when its directory holds its image file; it runs when a VM
 * runs that file. Every call looks at the store and the host when it is made
 * and keeps nothing between calls, so, like `ps`, its answer is as old as the
 * call that gave it.
 */
export class Images {
  private readonly context: ImagesContext;

  constructor(options: ImagesOptions = {}) {
    this.context = imagesContext(options);
  }

  templates(): Promise<Template[]> {
    return templates(this.context);
  }

  list(name?: string): Promise<ImageInfo[]> {
    return list(this.context, name);
  }

  create(name: string, options: CreateOptions): Promise<CreateResult> {
    return create(this.context, name, options);
  }

  start(name: string, options?: StartOptions): Promise<StartResult> {
    return start(this.context, name, options);
  }

  /** Kill the image's VMs, or, with `save`, have it save itself and quit. */
  stop(name: string, options?: StopOptions): Promise<StopResult> {
    return stop(this.context, name, options);
  }

  delete(name: string): Promise<{ name: string }> {
    return deleteImage(this.context, name);
  }

  /** Where a call to the image goes, or a refusal saying why none can and what to do. */
  async endpoint(name: string): Promise<Endpoint> {
    return endpointOf((await list(this.context, name))[0]);
  }
}
