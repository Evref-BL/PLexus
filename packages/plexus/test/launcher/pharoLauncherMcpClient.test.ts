import os from "node:os";
import path from "node:path";
import { openPharoLauncher } from "@evref-bl/pharo-launcher-mcp/launcher";
import { describe, expect, it } from "vitest";
import { plexusHome, storeRoot } from "../../src/home.js";
import {
  launcherFailureMessage,
  launchLogPaths,
} from "../../src/launcher/pharoLauncherMcpClient.js";
import { homeProfileEnvironment } from "../../src/launcher/pharoLauncherProfile.js";

describe("the home", () => {
  it("is PLEXUS_HOME, or ~/.plexus", () => {
    expect(plexusHome({ PLEXUS_HOME: "relative/home" })).toBe(path.resolve("relative/home"));
    expect(plexusHome({})).toBe(path.join(os.homedir(), ".plexus"));
  });

  it("holds one launcher profile, whose images are the store", () => {
    const home = path.resolve(path.sep, "tmp", "plexus-home");
    const profile = path.join(home, "profiles");
    expect(homeProfileEnvironment(home)).toEqual({
      PHARO_LAUNCHER_MCP_PROFILE: "plexus",
      PHARO_LAUNCHER_MCP_STATE_ROOT: profile,
      PHARO_LAUNCHER_MCP_LAUNCHER_IMAGE: path.join(profile, "launcher", "PharoLauncher.image"),
      PHARO_LAUNCHER_MCP_IMAGES_DIR: storeRoot(home),
      PHARO_LAUNCHER_MCP_VMS_DIR: path.join(profile, "vms"),
      PHARO_LAUNCHER_MCP_TEMPLATE_SOURCES_DIR: path.join(profile, "templates"),
      PHARO_LAUNCHER_MCP_INIT_SCRIPTS_DIR: path.join(profile, "init-scripts"),
      PHARO_LAUNCHER_MCP_LOGS_DIR: path.join(profile, "logs"),
      PHARO_LAUNCHER_MCP_LAUNCHER_CONFIGURATION: path.join(profile, "launcher", "pharo-launcher-cli-config.ston"),
    });
  });
});

describe("launcher failures", () => {
  it("say what the launcher said went wrong", () => {
    expect(launcherFailureMessage("createImage", { ok: false, message: "Destination image already exists." })).toBe(
      "Pharo Launcher createImage failed: Destination image already exists.",
    );
    expect(
      launcherFailureMessage("createImage", { ok: false, diagnostic: "Image not found.", action: "Create it first." }),
    ).toBe("Pharo Launcher createImage failed: Image not found. Create it first.");
    expect(launcherFailureMessage("listProcesses", { ok: false })).toBe("Pharo Launcher listProcesses failed");
  });

  it("keep a launcher log out of the message", () => {
    const message = launcherFailureMessage("startImage", { ok: false, diagnostic: "x".repeat(4_000) });
    expect(message.length).toBeLessThan(600);
    expect(message.endsWith("…")).toBe(true);
  });
});

describe("a waited launch whose VM cannot run an image", () => {
  // What the launcher answers for a waited launch, as preparing an image makes
  // one: its report on stdout and the VM's on stderr.
  async function failedLaunch(options: { stderr: string; includeRaw: boolean; vmUpdated?: boolean }) {
    const launcher = openPharoLauncher({
      runner: async () => ({
        exitCode: 1,
        stdout: [
          "Profile-scoped Pharo image launch.",
          "image: /home/me/.plexus/profiles/images/plexus-build-1/plexus-build-1.image",
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
      imageName: "plexus-build-1",
      detached: false,
      displayMode: "headless",
      script: "/home/me/prepare.st",
      includeRaw: options.includeRaw,
    });
  }
  const staleVm = "allocateHeap: Could not allocate codeZone in the expected place\nVM Error Fri Nov 13 10:02:44 2026";

  it("says how to renew the VM", async () => {
    const message = launcherFailureMessage("startImage", await failedLaunch({ stderr: staleVm, includeRaw: true }));
    expect(message).toContain("Pharo Launcher startImage failed: allocateHeap");
    expect(message).toContain("Remove /home/me/.plexus/profiles/vms/140-x64 and start again");
  });

  it("needs the launcher's raw result, which names the VM", async () => {
    const message = launcherFailureMessage("startImage", await failedLaunch({ stderr: staleVm, includeRaw: false }));
    expect(message).not.toContain("Remove");
  });

  it("says renewing will not help when the launch just installed the VM", async () => {
    const message = launcherFailureMessage(
      "startImage",
      await failedLaunch({ stderr: staleVm, includeRaw: true, vmUpdated: true }),
    );
    expect(message).toContain("was installed by this launch, so it is the current one");
    expect(message).not.toContain("Remove");
  });

  it("says nothing more when the image failed rather than its VM", async () => {
    const message = launcherFailureMessage(
      "startImage",
      await failedLaunch({ stderr: "Error: the script failed", includeRaw: true }),
    );
    expect(message).not.toContain("Remove");
  });
});

describe("a detached launch", () => {
  it("names the logs the VM writes to", () => {
    expect(
      launchLogPaths({
        ok: true,
        data: {
          message: [
            "Detached profile-scoped Pharo image pid 42.",
            "vm: /vms/140-x64/Pharo",
            "stdout: /logs/a.out.log",
            "stderr: /logs/a.err.log",
          ].join("\n"),
        },
      }),
    ).toEqual(["/logs/a.out.log", "/logs/a.err.log"]);
    expect(launchLogPaths({ ok: false })).toEqual([]);
  });
});
