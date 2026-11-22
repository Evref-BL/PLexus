import type { LauncherLaunchReport } from "@evref-bl/pharo-launcher-mcp/launcher";
import { describe, expect, it } from "vitest";
import { launchedVmSlot, vmRenewalHint } from "../../src/launcher/vmRenewal.js";

// What macOS 27 printed for a Pharo VM from 2025.
const staleVmOutput = [
  "[ERROR] 2026-11-13 10:02:44.000 allocateHeap (gcc3x-cointerp.c:93203):Could not allocate codeZone in the expected place (0x320000000), got 0x7000000000",
  "[ERROR] 2026-11-13 10:02:44.000 error (src/debug.c:45):Error allocating",
  "VM Error Fri Nov 13 10:02:44 2026",
].join("\n");

const report: LauncherLaunchReport = {
  by: "vm",
  imagePath: "/home/me/.plexus/profiles/images/Base/Base.image",
  displayMode: "headless",
  vmPath: "/home/me/.plexus/profiles/vms/140-x64/Pharo.app/Contents/MacOS/Pharo",
  vmId: "140-x64",
  vmDirectory: "/home/me/.plexus/profiles/vms/140-x64",
  vmUpdated: false,
};

describe("a VM that cannot run an image", () => {
  it("names its slot and the repair", () => {
    const hint = vmRenewalHint(staleVmOutput, report);

    expect(hint).toContain("The Pharo VM 140-x64 stopped before its image ran");
    expect(hint).toContain("Remove /home/me/.plexus/profiles/vms/140-x64 and start again");
  });

  it("says nothing when the VM did not stop with its own report", () => {
    // An image that fails while it runs prints a Smalltalk error, not the VM's.
    expect(vmRenewalHint("MessageNotUnderstood: nil>>foo", report)).toBeUndefined();
  });

  it("says nothing when the launch named no VM", () => {
    expect(vmRenewalHint(staleVmOutput, { by: "launcher", pid: 42 })).toBeUndefined();
    expect(vmRenewalHint(staleVmOutput, undefined)).toBeUndefined();
  });

  it("says renewing will not help when the launch just installed it", () => {
    const hint = vmRenewalHint(staleVmOutput, { ...report, vmUpdated: true });

    expect(hint).toContain("was installed by this launch, so it is the current one");
    expect(hint).not.toContain("Remove");
  });

  it("names the slot as the launcher reports it, on Windows too", () => {
    expect(
      launchedVmSlot({
        ...report,
        vmPath: "C:\\Users\\me\\.plexus\\profiles\\vms\\140-x64\\Pharo.exe",
        vmDirectory: "C:\\Users\\me\\.plexus\\profiles\\vms\\140-x64",
      }),
    ).toEqual({ vmId: "140-x64", slot: "C:\\Users\\me\\.plexus\\profiles\\vms\\140-x64", installedNow: false });
  });
});
