import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  CreateImageInput,
  KillProcessResult,
  LauncherCommandResult,
  LauncherImage,
  LauncherProcess,
  MadeImageResult,
  ProcessListResult,
  StartImageInput,
  StartImageResult,
  TemplateCategoriesResult,
  TemplateListResult,
  TemplateUpdateResult,
} from "@evref-bl/pharo-launcher-mcp";
import { afterEach } from "vitest";
import { storeRoot } from "../../src/home.js";
import { homeTemplateSources } from "../../src/launcher/pharoLauncherProfile.js";
import type { ImagesContext } from "../../src/images/context.js";
import type { InternalImagesOptions } from "../../src/images/context.js";
import { Images } from "../../src/images/index.js";
import type { LauncherPort } from "../../src/launcher/pharoLauncherMcpClient.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

export function tempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plexus-test-"));
  tempDirs.push(dir);
  return dir;
}

export function ok<T = undefined>(data?: T): LauncherCommandResult<T> {
  return {
    ok: true,
    ...(data === undefined ? {} : { data }),
    command: { durationMs: 0, exitCode: 0, timedOut: false },
  };
}

/** A create or copy that made its image. */
export function made(): MadeImageResult {
  return ok<{ image?: LauncherImage }>();
}

export function failed(diagnostic: string): LauncherCommandResult<never> {
  return {
    ok: false,
    diagnostic,
    command: { durationMs: 0, exitCode: 1, timedOut: false },
  };
}

type Answer<I> = (input: I) => StartImageResult | Promise<StartImageResult>;

/**
 * A launcher over a temporary store: it makes image directories the way the
 * launcher lays them out, and answers for a host running what `processes`
 * says. Nothing here starts a process.
 */
export class FakeLauncher implements LauncherPort {
  readonly calls: Array<{ method: keyof LauncherPort; input: unknown }> = [];
  processes: LauncherProcess[] = [];
  categories: string[] = ["Official distributions"];
  templatesByCategory: Record<string, string[]> = {
    "Official distributions": ["Pharo 14.0 - 64bit"],
  };
  /** Pids a kill does not end. */
  immortal = new Set<number>();
  nextPid = 4_000;
  createAnswer?: (input: CreateImageInput) => MadeImageResult | Promise<MadeImageResult>;
  prepareAnswer?: Answer<StartImageInput>;
  launchAnswer?: Answer<StartImageInput>;
  updateAnswer?: () => TemplateUpdateResult;

  constructor(readonly home: string) {}

  imageDir(name: string): string {
    return path.join(storeRoot(this.home), name);
  }

  /** A VM on that image file, as the host's process list shows one. */
  run(imagePath: string, options: { headless?: boolean; script?: string } = {}): LauncherProcess {
    const pid = this.nextPid++;
    const commandLine = [
      "/vms/140-x64/Pharo",
      options.headless === false ? undefined : "--headless",
      imagePath,
      ...(options.script ? ["eval", options.script] : []),
    ]
      .filter(Boolean)
      .join(" ");
    const vm = {
      pid,
      commandLine: `${pid} "${commandLine}"`,
      imagePath,
      imageName: path.basename(imagePath, ".image"),
    };
    this.processes.push(vm);
    return vm;
  }

  async createImage(input: CreateImageInput): Promise<MadeImageResult> {
    this.calls.push({ method: "createImage", input });
    if (this.createAnswer) {
      return this.createAnswer(input);
    }
    writeLauncherImage(this.imageDir(input.image), input.image, input.template);
    return made();
  }

  async startImage(input: StartImageInput): Promise<StartImageResult> {
    this.calls.push({ method: "startImage", input });
    if (!input.detached) {
      if (this.prepareAnswer) {
        return this.prepareAnswer(input);
      }
      const plexus = path.join(this.imageDir(input.image), "plexus");
      fs.mkdirSync(plexus, { recursive: true });
      fs.writeFileSync(path.join(plexus, "prepare-status.properties"), "status=ok\r");
      return ok();
    }
    if (this.launchAnswer) {
      return this.launchAnswer(input);
    }
    const imagePath = path.join(this.imageDir(input.image), `${input.image}.image`);
    const vm = this.run(imagePath, {
      headless: input.displayMode !== "interactive",
      ...(input.script ? { script: input.script } : {}),
    });
    writeEndpoint(this.imageDir(input.image), { port: 7001, pid: vm.pid });
    return launched(vm.pid, this.home);
  }

  /** Throws this instead of deleting nothing. */
  deleteLogsFailure?: Error;

  async deleteLaunchLogs(input: { image: string }): Promise<void> {
    this.calls.push({ method: "deleteLaunchLogs", input });
    if (this.deleteLogsFailure) {
      throw this.deleteLogsFailure;
    }
  }

  async listProcesses(): Promise<ProcessListResult> {
    this.calls.push({ method: "listProcesses", input: undefined });
    return ok({ processes: [...this.processes] });
  }

  async killProcess(
    input: Parameters<LauncherPort["killProcess"]>[0],
  ): Promise<KillProcessResult> {
    this.calls.push({ method: "killProcess", input });
    const pid = "pid" in input ? input.pid : undefined;
    if (pid !== undefined && !this.immortal.has(pid)) {
      this.processes = this.processes.filter((vm) => vm.pid !== pid);
    }
    return ok({ killed: pid === undefined ? [] : [pid], failures: [] });
  }

  async listTemplateCategories(): Promise<TemplateCategoriesResult> {
    this.calls.push({ method: "listTemplateCategories", input: undefined });
    return ok({ categories: [...this.categories] });
  }

  async listTemplates(
    input?: Parameters<LauncherPort["listTemplates"]>[0],
  ): Promise<TemplateListResult> {
    this.calls.push({ method: "listTemplates", input });
    const category = input?.category ?? "";
    const names = this.templatesByCategory[category];
    return names === undefined
      ? {
          ...failed(`Image template category '${category}' not found`),
          failure: { kind: "unknown-category" },
        }
      : ok({ templates: names.map((name) => ({ name, category })) });
  }

  /**
   * Fetches the profile's sources list when it has none, as the launcher's update does. It
   * names no group, so the categories still come from the launcher.
   */
  async updateTemplates(): Promise<TemplateUpdateResult> {
    this.calls.push({ method: "updateTemplates", input: undefined });
    const answer = this.updateAnswer?.() ?? ok();
    if (answer.ok) {
      const sources = homeTemplateSources(this.home);
      fs.mkdirSync(path.dirname(sources), { recursive: true });
      if (!fs.existsSync(sources)) {
        fs.writeFileSync(sources, "OrderedCollection [ ]\n");
      }
    }
    return answer;
  }

  called(method: keyof LauncherPort): unknown[] {
    return this.calls.filter((call) => call.method === method).map((call) => call.input);
  }
}

export function launched(pid: number, home: string): StartImageResult {
  const logs = path.join(home, "profiles", "logs");
  return {
    ...ok(),
    launch: {
      by: "vm",
      imagePath: path.join(home, "profiles", "images", "x", "x.image"),
      displayMode: "headless",
      vmPath: "/vms/140-x64/Pharo",
      vmId: "140-x64",
      vmDirectory: "/vms/140-x64",
      vmUpdated: false,
      pid,
      logs: { stdout: path.join(logs, "launch.out.log"), stderr: path.join(logs, "launch.err.log") },
    },
  };
}

/** An image directory as the launcher makes one from a template. */
export function writeLauncherImage(dir: string, name: string, template = "Pharo 14.0 - 64bit"): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.image`), "image");
  fs.writeFileSync(path.join(dir, `${name}.changes`), "changes");
  fs.writeFileSync(path.join(dir, "Pharo14.0-64bit.sources"), "sources");
  fs.writeFileSync(path.join(dir, "pharo.version"), "140");
  fs.writeFileSync(
    path.join(dir, "meta-inf.ston"),
    [
      "PhLImage {",
      "\t#file : FileLocator {",
      "\t\t#origin : #launcherImagesLocation,",
      `\t\t#path : RelativePath [ '${name}', '${name}.image' ]`,
      "\t},",
      "\t#originTemplate : PhLRemoteTemplate {",
      `\t\t#name : '${template}',`,
      "\t\t#url : ZnUrl { #scheme : #https, #host : 'files.pharo.org' }",
      "\t},",
      "\t#pharoVersion : '140'",
      "}",
    ].join("\n"),
  );
}

/** The endpoint file a start script writes, with the lines it adds after the pid, such as what it says of telemetry. */
export function writeEndpoint(dir: string, endpoint: { port: number; pid?: number; more?: string[] }): void {
  fs.mkdirSync(path.join(dir, "plexus"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "plexus", "endpoint.properties"),
    `transport=http\rhost=127.0.0.1\rport=${endpoint.port}\rpath=/\r${
      endpoint.pid === undefined ? "" : `pid=${endpoint.pid}\r`
    }${(endpoint.more ?? []).map((line) => `${line}\r`).join("")}`,
  );
}

/**
 * A context on a clock that only sleeping moves, so a start that waits 30 s
 * for a VM takes no time at all.
 */
export function testContext(
  home: string,
  launcher: LauncherPort,
  overrides: Partial<ImagesContext> = {},
): ImagesContext & { clock: { now: number } } {
  const clock = { now: Date.parse("2026-11-13T12:00:00Z") };
  return {
    home,
    telemetry: false,
    launcher: () => launcher,
    ping: async () => true,
    listTools: async () => [],
    callTool: async () => {
      throw new Error("No image answers in this test.");
    },
    sleep: async (ms) => {
      clock.now += ms;
    },
    now: () => clock.now,
    pollMs: 250,
    vmAppearMs: 30_000,
    quitWaitMs: 3_000,
    stopWaitMs: 10_000,
    saveWaitMs: 60_000,
    clock,
    ...overrides,
  };
}

/** An `Images` on a fake launcher: the launcher is not a public option, so tests pass it through the internal type. */
export function imagesWith(options: InternalImagesOptions): Images {
  return new Images(options);
}
