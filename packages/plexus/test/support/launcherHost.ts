import type { PharoLauncherMcpToolClient } from "../../src/launcher/pharoLauncherMcpClient.js";

/**
 * A launcher client whose host is running exactly these VMs.
 *
 * Every listing asks the host what it is running, and a facade given no client
 * opens a real `pharo-launcher-mcp` subprocess to ask. A test that forgets to
 * say does not fail for it: it spawns the launcher, waits for whatever the
 * machine running the test answers, and passes slowly — until a machine where
 * enumerating processes costs seconds, and then it fails on timing nobody
 * wrote down. So a test says what the host runs, and nothing reaches out.
 */
export function launcherHostRunning(
  processes: { pid: number; imageName: string }[] = [],
): PharoLauncherMcpToolClient {
  const client: PharoLauncherMcpToolClient = {
    async callTool(name) {
      if (name === "pharo_launcher_process_list") {
        return {
          ok: true,
          data: processes.map((process) => ({
            ...process,
            commandLine: `pharo ${process.imageName}.image`,
          })),
        };
      }

      return { ok: true };
    },
  };

  return client;
}
