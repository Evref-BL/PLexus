import { describe, expect, it } from "vitest";
import { toolNames } from "@evref-bl/pharo-launcher-mcp";
import {
  launcherToolFailureMessage,
  launcherToolNames,
} from "../../src/launcher/pharoLauncherMcpClient.js";

describe("the tools PLexus speaks", () => {
  it("names exactly what the launcher advertises", () => {
    expect([...launcherToolNames].sort()).toEqual([...toolNames].sort());
  });
});

describe("pharo-launcher-mcp tool failures", () => {
  function failure(payload: unknown): { message: string } {
    return {
      message: launcherToolFailureMessage(
        "pharo_launcher_image_copy_between_profiles",
        payload,
      ),
    };
  }

  it("reports what the launcher said went wrong", () => {
    expect(
      failure({
        ok: false,
        message:
          "Cannot copy image 'Base' in profile 'home' to 'Task' in profile 'project':"
          + " Destination image already exists at /images/Task.",
      }).message,
    ).toBe(
      "pharo-launcher-mcp tool failed: pharo_launcher_image_copy_between_profiles:"
      + " Cannot copy image 'Base' in profile 'home' to 'Task' in profile 'project':"
      + " Destination image already exists at /images/Task.",
    );
  });

  it("falls back to the diagnostic and the action a command answers with", () => {
    expect(
      failure({ ok: false, diagnostic: "Image not found.", action: "Create it first." }).message,
    ).toContain("Image not found. Create it first.");
  });

  it("keeps a launcher log out of the message", () => {
    const message = failure({ ok: false, diagnostic: "x".repeat(4_000) }).message;

    expect(message.length).toBeLessThan(600);
    expect(message.endsWith("…")).toBe(true);
  });

  it("still names the tool when the launcher explains nothing", () => {
    expect(failure({ ok: false }).message).toBe(
      "pharo-launcher-mcp tool failed: pharo_launcher_image_copy_between_profiles",
    );
  });
});
