import { describe, expect, it } from "vitest";
import { launchedVmSlot, vmRenewalHint } from "../../src/launcher/vmRenewal.js";

// What macOS 27 printed for a Pharo VM from 2025, through the launcher's
// report of the launch.
const staleVmOutput = [
  "[ERROR] 2026-11-13 10:02:44.000 allocateHeap (gcc3x-cointerp.c:93203):Could not allocate codeZone in the expected place (0x320000000), got 0x7000000000",
  "[ERROR] 2026-11-13 10:02:44.000 error (src/debug.c:45):Error allocating",
  "VM Error Fri Nov 13 10:02:44 2026",
].join("\n");

const report = [
  "Profile-scoped Pharo image launch.",
  "image: /home/me/.plexus/profiles/images/Base/Base.image",
  "vm: /home/me/.plexus/profiles/vms/140-x64/Pharo.app/Contents/MacOS/Pharo",
  "vmId: 140-x64",
].join("\n");

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
    expect(vmRenewalHint(staleVmOutput, "Detached Pharo image pid 42.")).toBeUndefined();
  });

  it("finds the slot on Windows paths too", () => {
    expect(
      launchedVmSlot("vm: C:\\Users\\me\\.plexus\\profiles\\vms\\140-x64\\Pharo.exe\nvmId: 140-x64"),
    ).toEqual({ vmId: "140-x64", slot: "C:\\Users\\me\\.plexus\\profiles\\vms\\140-x64" });
  });
});
