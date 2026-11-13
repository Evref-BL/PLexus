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

describe("a launch whose VM cannot run an image", () => {
  const raw = {
    stdout: [
      "Profile-scoped Pharo image launch.",
      "vm: /home/me/.plexus/profiles/vms/140-x64/Pharo.app/Contents/MacOS/Pharo",
      "vmId: 140-x64",
    ].join("\n"),
    stderr: "allocateHeap: Could not allocate codeZone in the expected place\nVM Error Fri Nov 13 10:02:44 2026",
  };

  it("says how to renew the VM", () => {
    const message = launcherToolFailureMessage("pharo_launcher_image_start", {
      ok: false,
      diagnostic: raw.stderr,
      raw,
    });

    expect(message).toContain("pharo-launcher-mcp tool failed: pharo_launcher_image_start: allocateHeap");
    expect(message).toContain("Remove /home/me/.plexus/profiles/vms/140-x64 and start again");
  });

  it("says nothing more when the image failed rather than its VM", () => {
    const message = launcherToolFailureMessage("pharo_launcher_image_start", {
      ok: false,
      diagnostic: "Error: the script failed",
      raw: { ...raw, stderr: "Error: the script failed" },
    });

    expect(message).not.toContain("Remove");
  });
});

