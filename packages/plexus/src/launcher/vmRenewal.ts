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

// The Pharo VM's own report of a fatal error, printed before it exits, so
// before any image code could have run.
const vmFatalErrorBanner = "VM Error";

/** The VM slot a profile-scoped launch ran, from the launcher's report of it. */
export function launchedVmSlot(
  launcherReport: string,
): { vmId: string; slot: string } | undefined {
  const vmPath = /^vm: (.+)$/m.exec(launcherReport)?.[1]?.trim();
  const vmId = /^vmId: (.+)$/m.exec(launcherReport)?.[1]?.trim();
  if (!vmPath || !vmId) {
    return undefined;
  }
  const match = new RegExp(`^(.*[\\\\/]${escapeRegExp(vmId)})[\\\\/]`).exec(vmPath);
  return match ? { vmId, slot: match[1] } : undefined;
}

/**
 * The repair for a launch whose VM stopped with its fatal-error report, or
 * nothing when the output shows no such report or the slot is unknown.
 *
 * @param vmOutput what the VM wrote before it stopped
 * @param launcherReport the launcher's report of the launch, naming the VM
 */
export function vmRenewalHint(
  vmOutput: string,
  launcherReport: string,
): string | undefined {
  if (!vmOutput.includes(vmFatalErrorBanner)) {
    return undefined;
  }
  const vm = launchedVmSlot(launcherReport);
  if (!vm) {
    return undefined;
  }
  return `The Pharo VM ${vm.vmId} stopped before its image ran, which a VM older than this system can do.`
    + ` Remove ${vm.slot} and start again: the current VM is installed in its place.`;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
