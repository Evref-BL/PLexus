import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { storeRoot, tmpRoot } from "../../src/home.js";
import { imagesContext } from "../../src/images/context.js";
import { deleteImage } from "../../src/images/delete.js";
import { stop } from "../../src/images/stop.js";
import {
  failed,
  FakeLauncher,
  tempHome,
  testContext,
  writeEndpoint,
  writeLauncherImage,
} from "../support/fakeLauncher.js";

function setup() {
  const home = tempHome();
  const launcher = new FakeLauncher(home);
  const dir = launcher.imageDir("dev");
  writeLauncherImage(dir, "dev");
  return { home, launcher, dir, imagePath: path.join(dir, "dev.image"), context: testContext(home, launcher) };
}

describe("stop", () => {
  it("is done when nothing runs the image", async () => {
    const { launcher, context } = setup();
    expect(await stop(context, "dev")).toEqual({ name: "dev", killed: [] });
    expect(launcher.called("killProcess")).toEqual([]);
  });

  it("kills every VM on the image file, and only those", async () => {
    const { launcher, dir, imagePath, context } = setup();
    const first = launcher.run(imagePath);
    const second = launcher.run(imagePath, { headless: false });
    writeLauncherImage(launcher.imageDir("plugin-dev"), "plugin-dev");
    const bystander = launcher.run(path.join(launcher.imageDir("plugin-dev"), "plugin-dev.image"));
    writeEndpoint(dir, { port: 7001, pid: first.pid });

    expect(await stop(context, "dev")).toEqual({ name: "dev", killed: [first.pid, second.pid] });
    expect(launcher.called("killProcess")).toEqual([{ pid: first.pid }, { pid: second.pid }]);
    expect(launcher.processes).toEqual([bystander]);
    expect(fs.existsSync(path.join(dir, "plexus", "endpoint.properties"))).toBe(false);
  });

  it("names the VMs a kill did not end", async () => {
    const { launcher, imagePath, context } = setup();
    const vm = launcher.run(imagePath);
    launcher.immortal.add(vm.pid);

    await expect(stop(context, "dev")).rejects.toMatchObject({
      code: "stop-failed",
      message: `Image dev still runs as pid ${vm.pid} after being killed.`,
      details: { pids: [vm.pid] },
    });
    expect(context.clock.now - Date.parse("2026-11-13T12:00:00Z")).toBe(10_000);
  });

  it("says at once why the launcher would not kill a VM", async () => {
    const { launcher, imagePath, context } = setup();
    launcher.nextPid = process.pid;
    launcher.run(imagePath);
    launcher.killProcess = async (input) => {
      launcher.calls.push({ method: "killProcess", input });
      return failed("kill EPERM");
    };

    await expect(stop(context, "dev")).rejects.toMatchObject({
      code: "stop-failed",
      message: `Image dev still runs as pid ${process.pid}.\nKilling pid ${process.pid} failed: Pharo Launcher killProcess failed: kill EPERM`,
      details: { pids: [process.pid] },
    });
    expect(context.clock.now - Date.parse("2026-11-13T12:00:00Z")).toBe(0);
  });

  it("takes a kill that failed on a VM gone meanwhile for one that worked", async () => {
    const { launcher, imagePath, context } = setup();
    launcher.nextPid = 2_147_483_646;
    const vm = launcher.run(imagePath);
    launcher.killProcess = async () => {
      launcher.processes = [];
      return failed(`No matching Pharo process found for ${vm.pid}`);
    };

    expect(await stop(context, "dev")).toEqual({ name: "dev", killed: [vm.pid] });
  });

  it("refuses an image that is not there", async () => {
    const { context } = setup();
    await expect(stop(context, "other")).rejects.toMatchObject({
      code: "no-such-image",
      message: "There is no image other. image_list names the images there are; image_create makes one.",
    });
  });
});

/** An error as callTool rejects with: its message, and its kind with what that carries. */
function forwardFailure(message: string, kind: Record<string, unknown>): Error {
  return Object.assign(new Error(message), kind);
}

/** Moves the image file's modification time on, as a save writes the file. */
function writeImageFile(imagePath: string): void {
  const later = new Date(fs.statSync(imagePath).mtimeMs + 60_000);
  fs.utimesSync(imagePath, later, later);
}

const saveCode = { code: "Smalltalk snapshot: true andQuit: true" };
const killsInstead = "image_stop without save kills it, and image_start then starts it as it was last saved.";

/** An image a start of this PLexus runs, answering at its endpoint, and the calls a stop makes to it. */
function runningSetup() {
  const fixture = setup();
  const vm = fixture.launcher.run(fixture.imagePath);
  writeEndpoint(fixture.dir, { port: 7001, pid: vm.pid });
  const calls: Array<{ endpoint: unknown; name: string; args: unknown; options: unknown }> = [];
  fixture.context.listTools = async () => [{ name: "class_search" }, { name: "evaluate" }];
  // The call takes `takesMs` on the clock, then fails as `failure` says: by
  // default, the connection a quitting VM closes.
  const answer = (quit: { writes?: boolean; exits?: boolean; takesMs?: number; failure?: Error }) => {
    fixture.context.callTool = async (endpoint, name, args, options) => {
      calls.push({ endpoint, name, args, options });
      fixture.context.clock.now += quit.takesMs ?? 0;
      if (quit.writes) {
        writeImageFile(fixture.imagePath);
      }
      if (quit.exits) {
        fixture.launcher.processes = fixture.launcher.processes.filter((each) => each.pid !== vm.pid);
      }
      throw quit.failure ?? forwardFailure("socket hang up", { kind: "closed" });
    };
  };
  return { ...fixture, vm, calls, answer, endpointFile: path.join(fixture.dir, "plexus", "endpoint.properties") };
}

describe("stop with save", () => {
  it("has the image save itself and quit, and says it saved", async () => {
    const { launcher, vm, calls, answer, endpointFile, context } = runningSetup();
    answer({ writes: true, exits: true });

    expect(await stop(context, "dev", { save: true })).toEqual({ name: "dev", killed: [], saved: true });
    expect(calls).toEqual([
      {
        endpoint: { url: "http://127.0.0.1:7001/", pid: vm.pid },
        name: "evaluate",
        args: saveCode,
        options: { minimumMs: 60_000 },
      },
    ]);
    expect(launcher.called("killProcess")).toEqual([]);
    expect(fs.existsSync(endpointFile)).toBe(false);
  });

  it("evaluates with image_evaluate in an image whose MCP predates the rename", async () => {
    const { calls, answer, context } = runningSetup();
    context.listTools = async () => [{ name: "image_evaluate" }];
    answer({ writes: true, exits: true });

    expect((await stop(context, "dev", { save: true })).saved).toBe(true);
    expect(calls.map((call) => call.name)).toEqual(["image_evaluate"]);
  });

  it("says an image that lists no evaluate tool cannot save, and leaves it running", async () => {
    const { launcher, calls, context } = runningSetup();
    context.listTools = async () => [{ name: "class_get" }];

    await expect(stop(context, "dev", { save: true })).rejects.toMatchObject({
      code: "save-failed",
      message: "Image dev did not save: it lists no evaluate tool, so it cannot save. It still runs: image_stop without save kills it, and image_start then starts it as it was last saved.",
    });
    expect(calls).toEqual([]);
    expect(launcher.called("killProcess")).toEqual([]);
  });

  it("waits for the VM to quit once the connection has closed", async () => {
    const { launcher, answer, context } = runningSetup();
    answer({ writes: true });
    let polls = 0;
    const sleep = context.sleep;
    context.sleep = async (ms) => {
      await sleep(ms);
      if (++polls === 2) {
        launcher.processes = [];
      }
    };

    expect(await stop(context, "dev", { save: true })).toEqual({ name: "dev", killed: [], saved: true });
    expect(context.clock.now - Date.parse("2026-11-13T12:00:00Z")).toBe(500);
  });

  it("leaves an image that does not save and quit in time running, and says what it did", async () => {
    for (const [writes, message] of [
      [false, `Image dev did not save or stop within 60 s, and still runs: ${killsInstead}`],
      [
        true,
        "Image dev began writing its image file but did not stop within 60 s, and still runs: it may still be writing it, and a kill before it is done can leave the file broken. image_list shows when it has stopped.",
      ],
    ] as const) {
      const { launcher, vm, answer, endpointFile, context } = runningSetup();
      answer({ writes });

      await expect(stop(context, "dev", { save: true })).rejects.toMatchObject({
        code: "save-failed",
        message,
        details: { pids: [vm.pid] },
      });
      expect(context.clock.now - Date.parse("2026-11-13T12:00:00Z")).toBe(60_000);
      expect(launcher.processes).toEqual([vm]);
      expect(launcher.called("killProcess")).toEqual([]);
      expect(fs.existsSync(endpointFile)).toBe(true);
    }
  });

  it("says when the VM quit without writing its image file", async () => {
    const { answer, endpointFile, context } = runningSetup();
    answer({ exits: true });

    await expect(stop(context, "dev", { save: true })).rejects.toMatchObject({
      code: "stopped-unsaved",
      message:
        "Image dev stopped without writing its image file, so what it had not saved is lost. image_start starts it as it was last saved.",
    });
    expect(fs.existsSync(endpointFile)).toBe(false);
  });

  it("waits for the VM a minute from the connection closing, and no longer for a call left unanswered", async () => {
    const { launcher, answer, context } = runningSetup();
    // A handshake that took most of the minute leaves the quit all of it.
    answer({ writes: true, takesMs: 58_000 });
    let polls = 0;
    const sleep = context.sleep;
    context.sleep = async (ms) => {
      await sleep(ms);
      if (++polls === 40) {
        launcher.processes = [];
      }
    };
    expect(await stop(context, "dev", { save: true })).toEqual({ name: "dev", killed: [], saved: true });
    expect(context.clock.now - Date.parse("2026-11-13T12:00:00Z")).toBe(68_000);

    const unanswered = runningSetup();
    unanswered.answer({
      takesMs: 60_000,
      failure: forwardFailure("MCP request timed out after 60000ms", { kind: "timeout", waitedMs: 60_000 }),
    });
    await expect(stop(unanswered.context, "dev", { save: true })).rejects.toMatchObject({
      code: "save-failed",
      message: `Image dev did not save or stop within 60 s, and still runs: ${killsInstead}`,
      details: { pids: [unanswered.vm.pid] },
    });
    expect(unanswered.context.clock.now - Date.parse("2026-11-13T12:00:00Z")).toBe(60_000);
    expect(unanswered.launcher.processes).toEqual([unanswered.vm]);
  });

  it("reads a call that failed on a VM that has gone as a stop, not as a refusal", async () => {
    const { answer, endpointFile, context } = runningSetup();
    answer({ exits: true, failure: forwardFailure("HTTP 502 Bad Gateway", { kind: "other" }) });

    await expect(stop(context, "dev", { save: true })).rejects.toMatchObject({
      code: "stopped-unsaved",
      message:
        "Image dev stopped without writing its image file, so what it had not saved is lost. image_start starts it as it was last saved.",
    });
    expect(fs.existsSync(endpointFile)).toBe(false);
  });

  it("leaves the image running when it does not take the save, saying why at once", async () => {
    const reject = (error: Error) => async () => {
      throw error;
    };
    const cases: Array<[string, (context: ReturnType<typeof runningSetup>["context"]) => void, string]> = [
      [
        "a listing that times out",
        (context) => {
          context.listTools = reject(forwardFailure("MCP request timed out after 10000ms", { kind: "timeout", waitedMs: 10_000 }));
        },
        "it did not answer within 10 s",
      ],
      [
        "a handshake that times out",
        (context) => {
          context.callTool = reject(forwardFailure("MCP initialize timed out after 60000ms", { kind: "no-handshake", waitedMs: 60_000 }));
        },
        "it did not answer within 60 s",
      ],
      [
        "a refused connection",
        (context) => {
          context.callTool = reject(forwardFailure("connect ECONNREFUSED 127.0.0.1:7001", { kind: "refused" }));
        },
        "it refused the connection",
      ],
      [
        "a JSON-RPC error",
        (context) => {
          context.callTool = reject(forwardFailure("MCP error -32601: Method not found", { kind: "answered", rpcCode: -32601 }));
        },
        "it answered MCP error -32601: Method not found",
      ],
      [
        "a listing whose connection closed",
        (context) => {
          context.listTools = reject(forwardFailure("socket hang up", { kind: "closed" }));
        },
        "it closed the connection",
      ],
      [
        "a listing with no tools in it",
        (context) => {
          context.listTools = reject(new Error("MCP tools/list response did not include result.tools"));
        },
        "it gave no answer an MCP client can read",
      ],
      [
        "an HTTP error status",
        (context) => {
          context.callTool = reject(forwardFailure("HTTP 500 Internal Server Error", { kind: "other" }));
        },
        "it gave no answer an MCP client can read",
      ],
      [
        "an answer that is not JSON",
        (context) => {
          context.callTool = reject(
            forwardFailure("MCP response was not valid JSON: Unexpected token '<'", { kind: "other" }),
          );
        },
        "it gave no answer an MCP client can read",
      ],
      [
        "an error result",
        (context) => {
          context.callTool = async () => ({
            content: [{ type: "text", text: "Evaluation failed: the image is read-only\nStopped in: Foo>>bar" }],
            isError: true,
          });
        },
        'evaluate answered "Evaluation failed: the image is read-only"',
      ],
    ];
    for (const [label, arrange, reason] of cases) {
      const { launcher, vm, endpointFile, context } = runningSetup();
      arrange(context);

      await expect(stop(context, "dev", { save: true }), label).rejects.toMatchObject({
        code: "save-failed",
        message: `Image dev did not save: ${reason}. It still runs: ${killsInstead}`,
        details: { pids: [vm.pid] },
      });
      expect(context.clock.now - Date.parse("2026-11-13T12:00:00Z"), label).toBe(0);
      expect(launcher.processes, label).toEqual([vm]);
      expect(launcher.called("killProcess"), label).toEqual([]);
      expect(fs.existsSync(endpointFile), label).toBe(true);
    }
  });

  it("says an image that takes no calls cannot save itself, and one that is starting cannot yet", async () => {
    const { launcher, imagePath, dir, context } = setup();
    const listed: unknown[] = [];
    context.listTools = async (endpoint) => {
      listed.push(endpoint);
      return [];
    };
    const vm = launcher.run(imagePath);

    await expect(stop(context, "dev", { save: true })).rejects.toMatchObject({
      code: "save-failed",
      message: `Image dev runs as pid ${vm.pid} but takes no calls: not started by this PLexus, so it cannot save itself. image_stop without save kills that VM; image_start then starts it as it was last saved.`,
      details: { pids: [vm.pid] },
    });

    launcher.processes = [];
    const starting = launcher.run(imagePath, { script: path.join(dir, "plexus", "start.st") });
    await expect(stop(context, "dev", { save: true })).rejects.toMatchObject({
      code: "starting",
      message: `Image dev is starting as pid ${starting.pid}: its MCP server does not answer yet. Call it again once image_list shows it running.`,
    });
    expect(listed).toEqual([]);
    expect(launcher.called("killProcess")).toEqual([]);
  });

  it("kills a VM left on the image beside the one that saved", async () => {
    const { launcher, imagePath, answer, context } = runningSetup();
    const other = launcher.run(imagePath, { headless: false });
    answer({ writes: true, exits: true });

    expect(await stop(context, "dev", { save: true })).toEqual({ name: "dev", killed: [other.pid], saved: true });
    expect(launcher.called("killProcess")).toEqual([{ pid: other.pid }]);
    expect(launcher.processes).toEqual([]);
  });

  it("takes the connection a quitting VM drops for the save, over HTTP", async () => {
    const { launcher, dir, imagePath, context } = setup();
    const vm = launcher.run(imagePath);
    const evaluated: unknown[] = [];
    const server = http.createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        const message = JSON.parse(body) as { id?: string; method: string; params?: { arguments?: unknown } };
        if (message.method === "tools/call") {
          // The save writes the file, and the VM's exit closes the socket unanswered.
          evaluated.push(message.params?.arguments);
          writeImageFile(imagePath);
          launcher.processes = [];
          request.socket.destroy();
          return;
        }
        const result =
          message.method === "tools/list"
            ? { tools: [{ name: "evaluate", inputSchema: { type: "object" } }] }
            : { protocolVersion: "2025-06-18", capabilities: {} };
        response.writeHead(message.id === undefined ? 202 : 200, { "content-type": "application/json" });
        response.end(message.id === undefined ? "" : JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      writeEndpoint(dir, { port: (server.address() as AddressInfo).port, pid: vm.pid });
      const { listTools, callTool } = imagesContext({ home: context.home });

      expect(await stop({ ...context, listTools, callTool }, "dev", { save: true })).toEqual({
        name: "dev",
        killed: [],
        saved: true,
      });
      expect(evaluated).toEqual([saveCode]);
    } finally {
      server.close();
    }
  });

  it("is done when nothing runs the image, asking nothing", async () => {
    const { context } = setup();
    context.listTools = async () => {
      throw new Error("asked");
    };
    expect(await stop(context, "dev", { save: true })).toEqual({ name: "dev", killed: [] });
  });
});

describe("delete", () => {
  it("removes the image's directory", async () => {
    const { home, context } = setup();
    expect(await deleteImage(context, "dev")).toEqual({ name: "dev" });
    expect(fs.readdirSync(storeRoot(home))).toEqual([]);
    expect(fs.readdirSync(tmpRoot(home))).toEqual([]);
  });

  it("removes an image whose create ended before it was done", async () => {
    const { home, context } = setup();
    fs.mkdirSync(path.join(storeRoot(home), "half", "plexus"), { recursive: true });
    fs.writeFileSync(
      path.join(storeRoot(home), "half", "plexus", "building"),
      JSON.stringify({ pid: 2_147_483_646, at: new Date(context.now()).toISOString() }),
    );

    await deleteImage(context, "half");
    expect(fs.readdirSync(storeRoot(home))).toEqual(["dev"]);
  });

  it("refuses an image a create is still making", async () => {
    const { dir, context } = setup();
    fs.mkdirSync(path.join(dir, "plexus"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "plexus", "building"),
      JSON.stringify({ pid: process.pid, at: new Date(context.now()).toISOString() }),
    );

    await expect(deleteImage(context, "dev")).rejects.toMatchObject({
      code: "building",
      message: `Image dev is still being created by process ${process.pid}; image_list shows it as creating until it is done.`,
      details: { pid: process.pid },
    });
    expect(fs.existsSync(dir)).toBe(true);
  });

  it("refuses an image whose create has not written its claim yet", async () => {
    const { dir, context } = setup();
    fs.mkdirSync(path.join(dir, "plexus"), { recursive: true });
    fs.writeFileSync(path.join(dir, "plexus", "building"), "");
    const now = new Date(context.now());
    fs.utimesSync(path.join(dir, "plexus", "building"), now, now);

    const refused = await deleteImage(context, "dev").catch((caught: unknown) => caught);
    expect(refused).toMatchObject({
      code: "building",
      message: "Image dev is still being created; image_list shows it as creating until it is done.",
    });
    expect((refused as { details?: unknown }).details).toBeUndefined();
    expect(fs.existsSync(dir)).toBe(true);
  });

  it("refuses while a VM runs the image", async () => {
    const { launcher, imagePath, dir, context } = setup();
    const vm = launcher.run(imagePath);

    await expect(deleteImage(context, "dev")).rejects.toMatchObject({
      code: "image-running",
      message: `Image dev is running as pid ${vm.pid}. Stop it with image_stop before deleting it.`,
      details: { pids: [vm.pid] },
    });
    expect(fs.existsSync(dir)).toBe(true);
  });

  it("refuses while a start is launching it", async () => {
    const { dir, context } = setup();
    fs.mkdirSync(path.join(dir, "plexus"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "plexus", "launch.lock"),
      JSON.stringify({ pid: process.pid, at: new Date(context.now()).toISOString() }),
    );

    await expect(deleteImage(context, "dev")).rejects.toMatchObject({
      code: "being-started",
      message: `Image dev is being started by process ${process.pid}. Its tools take calls once image_list shows it running.`,
    });
    expect(fs.existsSync(dir)).toBe(true);
  });

  it("refuses an image that is not there", async () => {
    const { context } = setup();
    await expect(deleteImage(context, "other")).rejects.toMatchObject({
      code: "no-such-image",
      message: "There is no image other. image_list names the images there are; image_create makes one.",
    });
  });
});
