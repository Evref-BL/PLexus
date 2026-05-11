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

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("project config", () => {
  it("parses the prototype project config shape", () => {
    expect(parseProjectConfig(validProjectConfig())).toEqual(validProjectConfig());
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
    expect(loadProjectConfig(projectRoot)).toEqual(validProjectConfig());
  });

  it("allows image MCP ports to be allocated later", () => {
    const config = validProjectConfig();
    delete config.images[1].mcp.port;

    expect(parseProjectConfig(config)).toEqual(config);
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
