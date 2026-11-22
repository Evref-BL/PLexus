/**
 * What to do about a Pharo VM that cannot run an image.
 *
 * A launcher fills a VM slot (`140-x64`) once and runs from it for good, so a
 * VM gets old, and a system update can leave it unable to start an image: the
 * one PLexus built its image cache with aborted on macOS 27 while allocating
 * the heap. It still answers `--version`, so nothing short of a launch shows
 * it. Removing the slot is the repair: the launcher installs a VM that is
 * missing, the current one. PLexus says so rather than doing it, since a VM
 * error from another cause would remove a VM that running images use.
 */

import type { LauncherLaunchReport } from "@evref-bl/pharo-launcher-mcp/launcher";

// The Pharo VM's own report of a fatal error, printed before it exits, so
// before any image code could have run.
const vmFatalErrorBanner = "VM Error";

/**
 * The VM slot a launch ran, the directory of that VM under the profile's VMs,
 * and whether the launch installed that VM itself, which makes it the current
 * one. Only a launch that ran the VM itself names it.
 */
export function launchedVmSlot(
  launch: LauncherLaunchReport | undefined,
): { vmId: string; slot: string; installedNow: boolean } | undefined {
  if (launch?.by !== "vm") {
    return undefined;
  }
  const { vmPath, vmId } = launch;
  const match = new RegExp(`^(.*[\\\\/]${escapeRegExp(vmId)})[\\\\/]`).exec(vmPath);
  if (!match) {
    return undefined;
  }
  return { vmId, slot: match[1], installedNow: launch.vmUpdated };
}

/**
 * The repair for a launch whose VM stopped with its fatal-error report, or
 * nothing when the output shows no such report or the slot is unknown.
 *
 * @param vmOutput what the VM wrote before it stopped
 * @param launch the launcher's report of the launch, naming the VM
 */
export function vmRenewalHint(
  vmOutput: string,
  launch: LauncherLaunchReport | undefined,
): string | undefined {
  if (!vmOutput.includes(vmFatalErrorBanner)) {
    return undefined;
  }
  const vm = launchedVmSlot(launch);
  if (!vm) {
    return undefined;
  }
  if (vm.installedNow) {
    // Removing it again would download the same VM and fail the same way.
    return `The Pharo VM ${vm.vmId} was installed by this launch, so it is the current one,`
      + " and it still stopped before its image ran: renewing it will not help on this system.";
  }
  return `The Pharo VM ${vm.vmId} stopped before its image ran, which a VM older than this system can do.`
    + ` Remove ${vm.slot} and start again: the current VM is installed in its place.`;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
