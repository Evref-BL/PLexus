import path from "node:path";
import { profileRoot } from "../home.js";

/**
 * PLexus's one launcher profile, as the launcher's own variables.
 *
 * One profile, so the launcher image, the VMs and the templates, which are
 * large and the same for every image, exist once per home.
 */
export function homeProfileEnvironment(home: string): Record<string, string> {
  const root = profileRoot(home);
  return {
    PHARO_LAUNCHER_MCP_PROFILE: "plexus",
    PHARO_LAUNCHER_MCP_STATE_ROOT: root,
    PHARO_LAUNCHER_MCP_LAUNCHER_IMAGE: path.join(root, "launcher", "PharoLauncher.image"),
    PHARO_LAUNCHER_MCP_IMAGES_DIR: path.join(root, "images"),
    PHARO_LAUNCHER_MCP_VMS_DIR: path.join(root, "vms"),
    PHARO_LAUNCHER_MCP_TEMPLATE_SOURCES_DIR: path.join(root, "templates"),
    PHARO_LAUNCHER_MCP_INIT_SCRIPTS_DIR: path.join(root, "init-scripts"),
    PHARO_LAUNCHER_MCP_LOGS_DIR: path.join(root, "logs"),
    PHARO_LAUNCHER_MCP_LAUNCHER_CONFIGURATION: path.join(
      root,
      "launcher",
      "pharo-launcher-cli-config.ston",
    ),
  };
}
