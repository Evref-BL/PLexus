import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  ImageCreateInput,
  ImageStartInput,
  LauncherCommandResult,
  LauncherProcess,
  TemplateUpdateResult,
} from "@evref-bl/pharo-launcher-mcp/launcher";
import { afterEach } from "vitest";
import { storeRoot } from "../../src/home.js";
import type { ImagesContext } from "../../src/images/context.js";
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

export function ok<T>(data?: T, message?: string): LauncherCommandResult<T> {
  return {
    ok: true,
    ...(data === undefined ? {} : { data }),
    ...(message === undefined ? {} : { data: { message } as T }),
    parser: { status: "parsed", format: "text" },
    command: { args: [], durationMs: 0, exitCode: 0, timedOut: false },
  };
}

export function failed(diagnostic: string, raw?: { stdout: string; stderr: string }): LauncherCommandResult<never> {
  return {
    ok: false,
    diagnostic,
    parser: { status: "skipped", format: "text" },
    ...(raw ? { raw: { ...raw, format: "text" as const } } : {}),
    command: { args: [], durationMs: 0, exitCode: 1, timedOut: false },
  };
}

type Answer<I> = (input: I) => LauncherCommandResult | Promise<LauncherCommandResult>;

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
  createAnswer?: Answer<ImageCreateInput>;
  prepareAnswer?: Answer<ImageStartInput>;
  launchAnswer?: Answer<ImageStartInput>;

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
    const vm = { pid, commandLine: `${pid} "${commandLine}"`, imagePath };
    this.processes.push(vm);
    return vm;
  }

  async createImage(input: ImageCreateInput): Promise<LauncherCommandResult> {
    this.calls.push({ method: "createImage", input });
    if (this.createAnswer) {
      return this.createAnswer(input);
    }
    writeLauncherImage(this.imageDir(input.newImageName), input.newImageName, input.templateName);
    return ok();
  }

  async startImage(input: ImageStartInput): Promise<LauncherCommandResult> {
    this.calls.push({ method: "startImage", input });
    if (!input.detached) {
      if (this.prepareAnswer) {
        return this.prepareAnswer(input);
      }
      const plexus = path.join(this.imageDir(input.imageName), "plexus");
      fs.mkdirSync(plexus, { recursive: true });
      fs.writeFileSync(path.join(plexus, "prepare-status.properties"), "status=ok\r");
      return ok();
    }
    if (this.launchAnswer) {
      return this.launchAnswer(input);
    }
    const imagePath = path.join(this.imageDir(input.imageName), `${input.imageName}.image`);
    const vm = this.run(imagePath, {
      headless: input.displayMode !== "interactive",
      ...(input.script ? { script: input.script } : {}),
    });
    writeEndpoint(this.imageDir(input.imageName), { port: 7001, pid: vm.pid });
    return launched(vm.pid, this.home);
  }

  async listProcesses(): Promise<LauncherCommandResult<LauncherProcess[]>> {
    this.calls.push({ method: "listProcesses", input: undefined });
    return ok([...this.processes]);
  }

  async killProcess(
    input: Parameters<LauncherPort["killProcess"]>[0],
  ): Promise<LauncherCommandResult> {
    this.calls.push({ method: "killProcess", input });
    const pid = "pid" in input ? Number(input.pid) : undefined;
    if (pid !== undefined && !this.immortal.has(pid)) {
      this.processes = this.processes.filter((vm) => vm.pid !== pid);
    }
    return ok();
  }

  async listTemplateCategories(): Promise<LauncherCommandResult<string[]>> {
    this.calls.push({ method: "listTemplateCategories", input: undefined });
    return ok([...this.categories]);
  }

  async listTemplates(
    input?: Parameters<LauncherPort["listTemplates"]>[0],
  ): Promise<LauncherCommandResult<Array<{ name: string; category: string }>>> {
    this.calls.push({ method: "listTemplates", input });
    const category = input?.templateCategory ?? "";
    const names = this.templatesByCategory[category];
    return names === undefined
      ? failed(`Image template category '${category}' not found`)
      : ok(names.map((name) => ({ name, category })));
  }

  async updateTemplates(): Promise<TemplateUpdateResult> {
    this.calls.push({ method: "updateTemplates", input: undefined });
    return ok();
  }

  called(method: keyof LauncherPort): unknown[] {
    return this.calls.filter((call) => call.method === method).map((call) => call.input);
  }
}

export function launched(pid: number, home: string): LauncherCommandResult {
  const logs = path.join(home, "profiles", "logs");
  return ok(undefined, [
    `Detached profile-scoped Pharo image pid ${pid}.`,
    "vm: /vms/140-x64/Pharo",
    "vmId: 140-x64",
    `stdout: ${path.join(logs, "launch.out.log")}`,
    `stderr: ${path.join(logs, "launch.err.log")}`,
  ].join("\n"));
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

export function writeEndpoint(dir: string, endpoint: { port: number; pid?: number }): void {
  fs.mkdirSync(path.join(dir, "plexus"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "plexus", "endpoint.properties"),
    `transport=http\rhost=127.0.0.1\rport=${endpoint.port}\rpath=/\r${
      endpoint.pid === undefined ? "" : `pid=${endpoint.pid}\r`
    }`,
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
    launcher: () => launcher,
    ping: async () => true,
    sleep: async (ms) => {
      clock.now += ms;
    },
    now: () => clock.now,
    pollMs: 250,
    vmAppearMs: 30_000,
    stopWaitMs: 10_000,
    clock,
    ...overrides,
  };
}
