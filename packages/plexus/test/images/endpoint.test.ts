import { describe, expect, it } from "vitest";
import { endpointOf, noEndpointYet } from "../../src/images/endpoint.js";
import type { ImageInfo } from "../../src/types.js";

function row(fields: Partial<ImageInfo> = {}): ImageInfo {
  return {
    name: "spike",
    diskName: "Scope-spike",
    path: "/home/.plexus/profiles/images/Scope-spike/Scope-spike.image",
    running: false,
    pids: [],
    ...fields,
  };
}

function refusal(image: ImageInfo): unknown {
  try {
    endpointOf(image);
  } catch (error) {
    return error;
  }
  throw new Error("endpointOf answered an endpoint");
}

describe("endpointOf", () => {
  it("answers the endpoint of a running image that wrote one", () => {
    const endpoint = { url: "http://127.0.0.1:7001/", pid: 4242 };
    expect(endpointOf(row({ running: true, pids: [4242], endpoint }))).toEqual(endpoint);
  });

  it("says an image a create is making is being created, whatever VM runs it", () => {
    const image = row({
      running: true,
      pids: [4242],
      building: true,
      endpointProblem: "not started by this PLexus",
    });
    const error = refusal(image);
    expect(error).toMatchObject({
      code: "building",
      message: "Image spike is still being created; image_list shows it as creating until it is done.",
    });
    expect((error as { details?: unknown }).details).toBeUndefined();
  });

  it("says to start a stopped image, and how it starts", () => {
    expect(refusal(row())).toMatchObject({
      code: "not-running",
      message: "Image spike is not running. Start it with image_start; it starts as it was last saved.",
    });
  });

  it("says an image whose server has not written its endpoint yet is starting", () => {
    expect(
      refusal(row({ name: "dev", running: true, pids: [4242], endpointProblem: noEndpointYet })),
    ).toMatchObject({
      code: "no-endpoint",
      message: "Image dev is starting as pid 4242: its MCP server does not answer yet. Call it again once image_list shows it running.",
      details: { pids: [4242] },
    });
  });

  it("says what a stop would do to an image that takes no calls, giving the problem as it is", () => {
    expect(
      refusal(
        row({
          name: "legacy",
          running: true,
          pids: [5120],
          endpointProblem: "the endpoint names pid 9, which does not run this image",
        }),
      ),
    ).toMatchObject({
      code: "no-endpoint",
      message: "Image legacy runs as pid 5120 but takes no calls: the endpoint names pid 9, which does not run this image. image_stop kills that VM without saving; image_start then starts it as it was last saved.",
      details: { pids: [5120] },
    });
    expect(
      refusal(
        row({ name: "legacy", running: true, pids: [5120, 5121], endpointProblem: "not started by this PLexus" }),
      ),
    ).toMatchObject({
      message: "Image legacy runs as pids 5120, 5121 but takes no calls: not started by this PLexus. image_stop kills those VMs without saving; image_start then starts it as it was last saved.",
    });
  });
});
