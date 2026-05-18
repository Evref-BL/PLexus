import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadProjectConfig,
  parseProjectConfig,
  projectConfigPath,
  ProjectConfigError,
  plexusProjectConfigFileName,
} from "./projectConfig.js";

const tempDirs: string[] = [];

function validProjectConfig() {
  return {
    name: "my-project",
    kanban: {
      provider: "vibe-kanban",
      projectId: "project-123",
    },
    images: [
      {
        id: "dev",
        imageName: "MyProject-dev",
        active: true,
        mcp: {
          port: 7123,
          loadScript: "pharo/load-mcp.st",
        },
        git: {
          transport: "ssh",
        },
      },
      {
        id: "baseline",
        imageName: "MyProject-baseline",
        active: false,
        mcp: {
          port: 7124,
          loadScript: "pharo/load-mcp.st",
        },
        git: {
          transport: "ssh",
        },
      },
    ],
  };
}

function defaultRuntimePolicy() {
  return {
    scope: "project",
    stateRoot: {
      mode: "project-local",
    },
    gateway: {
      mode: "project-local",
      host: "127.0.0.1",
      portRange: {
        start: 8_133,
        end: 8_199,
      },
      agentMcpPath: "/mcp",
      routeControlMcpPath: "/control-mcp",
    },
    imagePorts: {
      allocation: "configured-or-dynamic",
      range: {
        start: 7_100,
        end: 7_199,
      },
      coordination: {
        mode: "project-state",
      },
    },
    launcherProfile: {
      mode: "project-owned",
    },
  };
}

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("project config", () => {
  it("parses the prototype project config shape with runtime defaults", () => {
    expect(parseProjectConfig(validProjectConfig())).toEqual({
      ...validProjectConfig(),
      runtime: defaultRuntimePolicy(),
    });
  });

  it("loads plexus.project.json from the project root", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "plexus-project-"));
    tempDirs.push(projectRoot);
    fs.writeFileSync(
      path.join(projectRoot, plexusProjectConfigFileName),
      JSON.stringify(validProjectConfig(), null, 2),
      "utf8",
    );

    expect(projectConfigPath(projectRoot)).toBe(
      path.join(projectRoot, "plexus.project.json"),
    );
    expect(loadProjectConfig(projectRoot)).toEqual({
      ...validProjectConfig(),
      runtime: defaultRuntimePolicy(),
    });
  });

  it("allows image MCP ports to be allocated later", () => {
    const config = validProjectConfig();
    delete config.images[1].mcp.port;

    expect(parseProjectConfig(config)).toEqual({
      ...config,
      runtime: defaultRuntimePolicy(),
    });
  });

  it("allows projects with no declared images", () => {
    const config = {
      ...validProjectConfig(),
      images: [],
    };

    expect(parseProjectConfig(config)).toEqual({
      ...config,
      runtime: defaultRuntimePolicy(),
    });
  });

  it("parses the explicit project runtime policy shape", () => {
    const config: ReturnType<typeof validProjectConfig> & { runtime?: unknown } =
      validProjectConfig();
    config.runtime = {
      scope: "project",
      stateRoot: {
        mode: "external",
        path: "C:\\dev\\plexus-state",
      },
      gateway: {
        mode: "shared",
        agentMcpUrl: "http://gateway.local:8133/mcp",
        routeControlMcpUrl: "http://gateway.local:8133/control-mcp",
      },
      imagePorts: {
        allocation: "configured-or-dynamic",
        range: {
          start: 7_200,
          end: 7_299,
        },
        coordination: {
          mode: "host-local",
          root: "C:\\dev\\plexus-port-claims",
        },
      },
      launcherProfile: {
        mode: "project-owned",
        name: "my-project-isolated",
        root: "C:\\dev\\plexus-state\\profiles\\pharo-launcher",
      },
    };

    expect(parseProjectConfig(config)).toEqual(config);
  });

  it("allows external launcher profile policy as an explicit opt-out", () => {
    const config: ReturnType<typeof validProjectConfig> & { runtime?: unknown } =
      validProjectConfig();
    config.runtime = {
      launcherProfile: {
        mode: "external",
      },
    };

    expect(parseProjectConfig(config).runtime?.launcherProfile).toEqual({
      mode: "external",
    });
  });

  it("records project-local gateway host, fixed port, route path, and control path", () => {
    const config: ReturnType<typeof validProjectConfig> & { runtime?: unknown } =
      validProjectConfig();
    config.runtime = {
      gateway: {
        mode: "project-local",
        host: "0.0.0.0",
        port: 8_144,
        agentMcpPath: "/agent-mcp",
        routeControlMcpPath: "/route-control",
      },
    };

    expect(parseProjectConfig(config).runtime?.gateway).toEqual({
      mode: "project-local",
      host: "0.0.0.0",
      port: 8_144,
      agentMcpPath: "/agent-mcp",
      routeControlMcpPath: "/route-control",
    });
  });

  it("rejects shared gateway runtime policy without endpoint details", () => {
    const config: ReturnType<typeof validProjectConfig> & { runtime?: unknown } =
      validProjectConfig();
    config.runtime = {
      gateway: {
        mode: "shared",
      },
    };

    expect(() => parseProjectConfig(config)).toThrow(ProjectConfigError);

    try {
      parseProjectConfig(config);
    } catch (error) {
      expect((error as ProjectConfigError).issues).toEqual(
        expect.arrayContaining([
          "runtime.gateway.agentMcpUrl must be a valid URL",
          "runtime.gateway.routeControlMcpUrl must be a valid URL",
        ]),
      );
    }
  });

  it("leaves image git configuration absent when not specified", () => {
    const config = validProjectConfig();
    delete config.images[0].git;

    expect(parseProjectConfig(config).images[0].git).toBeUndefined();
  });

  it("parses image git transport and credentials", () => {
    const config = validProjectConfig();
    config.images[0].git = {
      transport: "https",
      plainCredentials: {
        username: "git-user",
        password: "token",
      },
    };
    config.images[1].git = {
      transport: "ssh",
      ssh: {
        publicKey: "C:\\Users\\me\\.ssh\\id_rsa.pub",
        privateKey: "C:\\Users\\me\\.ssh\\id_rsa",
      },
    };

    expect(parseProjectConfig(config).images.map((image) => image.git)).toEqual([
      {
        transport: "https",
        plainCredentials: {
          username: "git-user",
          password: "token",
        },
      },
      {
        transport: "ssh",
        ssh: {
          publicKey: "C:\\Users\\me\\.ssh\\id_rsa.pub",
          privateKey: "C:\\Users\\me\\.ssh\\id_rsa",
        },
      },
    ]);
  });

  it("rejects git credentials that do not match the selected transport", () => {
    const config = validProjectConfig();
    config.images[0].git = {
      transport: "ssh",
      plainCredentials: {
        username: "git-user",
        password: "token",
      },
    };
    config.images[1].git = {
      transport: "https",
      ssh: {
        publicKey: "C:\\Users\\me\\.ssh\\id_rsa.pub",
        privateKey: "C:\\Users\\me\\.ssh\\id_rsa",
      },
    };

    expect(() => parseProjectConfig(config)).toThrow(ProjectConfigError);

    try {
      parseProjectConfig(config);
    } catch (error) {
      expect((error as ProjectConfigError).issues).toEqual(
        expect.arrayContaining([
          "images[0].git.plainCredentials can only be used with https or http",
          "images[1].git.ssh can only be used with ssh",
        ]),
      );
    }
  });

  it("rejects invalid or incomplete project configs with collected issues", () => {
    expect(() =>
      parseProjectConfig({
        name: "",
        kanban: {
          provider: "other",
        },
        images: [
          {
            id: "dev",
            imageName: "Shared",
            active: true,
            mcp: {
              port: 0,
              loadScript: "",
            },
            git: {
              transport: "git",
            },
          },
          {
            id: "dev",
            imageName: "Shared",
            active: "yes",
            mcp: {
              port: 0,
              loadScript: "pharo/load-mcp.st",
            },
            git: {
              ssh: {
                publicKey: "",
                privateKey: "",
              },
            },
          },
        ],
      }),
    ).toThrow(ProjectConfigError);

    try {
      parseProjectConfig({
        name: "",
        kanban: {
          provider: "other",
        },
        images: [
          {
            id: "dev",
            imageName: "Shared",
            active: true,
            mcp: {
              port: 0,
              loadScript: "",
            },
            git: {
              transport: "git",
            },
          },
          {
            id: "dev",
            imageName: "Shared",
            active: "yes",
            mcp: {
              port: 0,
              loadScript: "pharo/load-mcp.st",
            },
            git: {
              ssh: {
                publicKey: "",
                privateKey: "",
              },
            },
          },
        ],
      });
    } catch (error) {
      expect(error).toBeInstanceOf(ProjectConfigError);
      expect((error as ProjectConfigError).issues).toEqual(
        expect.arrayContaining([
          "config.name must be a non-empty string",
          "kanban.provider must be \"vibe-kanban\"",
          "kanban.projectId must be a non-empty string",
          "images[0].mcp.port must be an integer between 1 and 65535",
          "images[0].mcp.loadScript must be a non-empty string",
          "images[0].git.transport must be one of ssh, https, http",
          "images[1].active must be a boolean",
          "images[1].mcp.port must be an integer between 1 and 65535",
          "images[1].git.ssh.publicKey must be a non-empty string",
          "images[1].git.ssh.privateKey must be a non-empty string",
          "image ids must be unique: dev",
          "image names must be unique: Shared",
        ]),
      );
    }
  });

  it("rejects duplicate active image ports", () => {
    const config = validProjectConfig();
    config.images[1].mcp.port = config.images[0].mcp.port;

    expect(() => parseProjectConfig(config)).toThrow(ProjectConfigError);
  });
});
