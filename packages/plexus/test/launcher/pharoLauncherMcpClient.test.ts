import { describe, expect, it } from "vitest";
import { toolNames } from "@evref-bl/pharo-launcher-mcp";
import { openPharoLauncher } from "@evref-bl/pharo-launcher-mcp/launcher";
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
  // What the launcher answers for a waited launch, as the cache build makes
  // one, with the launcher's report on stdout and the VM's on stderr.
  async function failedLaunch(options: { stderr: string; includeRaw: boolean; vmUpdated?: boolean }) {
    const launcher = openPharoLauncher({
      runner: async () => ({
        exitCode: 1,
        stdout: [
          "Profile-scoped Pharo image launch.",
          "image: /home/me/.plexus/profiles/image-cache/images/Base/Base.image",
          "vm: /home/me/.plexus/profiles/vms/140-x64/Pharo.app/Contents/MacOS/Pharo",
          "vmId: 140-x64",
          `vmUpdated: ${options.vmUpdated ?? false}`,
        ].join("\n"),
        stderr: options.stderr,
        durationMs: 5,
        timedOut: false,
      }),
    });
    return launcher.startImage({
      imageName: "Base",
      detached: false,
      displayMode: "headless",
      script: "/home/me/prepare.st",
      includeRaw: options.includeRaw,
    });
  }
  const staleVm = "allocateHeap: Could not allocate codeZone in the expected place\nVM Error Fri Nov 13 10:02:44 2026";

  it("says how to renew the VM", async () => {
    const message = launcherToolFailureMessage(
      "pharo_launcher_image_start",
      await failedLaunch({ stderr: staleVm, includeRaw: true }),
    );

    expect(message).toContain("pharo-launcher-mcp tool failed: pharo_launcher_image_start: allocateHeap");
    expect(message).toContain("Remove /home/me/.plexus/profiles/vms/140-x64 and start again");
  });

  it("needs the launcher's raw result, which names the VM", async () => {
    const message = launcherToolFailureMessage(
      "pharo_launcher_image_start",
      await failedLaunch({ stderr: staleVm, includeRaw: false }),
    );

    expect(message).not.toContain("Remove");
  });

  it("says renewing will not help when the launch just installed the VM", async () => {
    const message = launcherToolFailureMessage(
      "pharo_launcher_image_start",
      await failedLaunch({ stderr: staleVm, includeRaw: true, vmUpdated: true }),
    );

    expect(message).toContain("was installed by this launch, so it is the current one");
    expect(message).not.toContain("Remove");
  });

  it("says nothing more when the image failed rather than its VM", async () => {
    const message = launcherToolFailureMessage(
      "pharo_launcher_image_start",
      await failedLaunch({ stderr: "Error: the script failed", includeRaw: true }),
    );

    expect(message).not.toContain("Remove");
  });
});
