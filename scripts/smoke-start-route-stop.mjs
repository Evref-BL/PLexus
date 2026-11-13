#!/usr/bin/env node
/**
 * The live smoke: create an image, start it, list its tools through the
 * forwarding PLexus does, stop it and delete it, in a scratch scope.
 *
 *   npm run smoke:start-route-stop -- [--template "Pharo 14.0 - 64bit"] [--category <c>]
 *     [--home <dir>] [--scope plexus-smoke-<id>] [--name smoke] [--timeout <seconds>]
 *     [--tool class_search --arguments '{"name":"MCPToolRegistry"}' --expect class=MCPToolRegistry]
 *     [--keep]
 *
 * It runs on the real launcher and starts a real VM, so it is never part of
 * `npm test`. The first run of a template builds its base, which takes
 * minutes; later runs copy it.
 */
import { callTool, Images, listTools } from "../packages/plexus/dist/index.js";
import {
  checkListedTools,
  checkToolResult,
  formatFailure,
  parseSmokeArgs,
  resolveTemplate,
  smokeSteps,
} from "./live-smoke-policy.mjs";

async function main(argv) {
  let options;
  try {
    options = parseSmokeArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }

  const images = new Images({
    ...(options.home === undefined ? {} : { home: options.home }),
    scope: options.scope,
  });
  const report = (step, value) => console.log(`${step}: ${JSON.stringify(value)}`);
  console.log(`smoke: ${smokeSteps(options).join(", ")} in scope ${options.scope}`);

  let step = "templates";
  let created = false;
  try {
    const template = resolveTemplate(options, await images.templates());

    step = "create";
    const image = await images.create(options.name, { template: template.name, category: template.category });
    created = true;
    report(step, { template: template.name, fromBase: image.fromBase, seconds: image.seconds });

    step = "start";
    const started = await images.start(options.name, { timeoutMs: options.timeoutMs });
    report(step, { pids: started.pids, endpoint: started.endpoint.url, seconds: started.seconds });

    step = "listTools";
    const tools = await listTools(await images.endpoint(options.name));
    checkListedTools(tools, options.tool);
    report(step, { count: tools.length });

    if (options.tool !== undefined) {
      step = "callTool";
      checkToolResult(
        await callTool(started.endpoint, options.tool, options.toolArguments),
        options.expectedText,
      );
      report(step, { tool: options.tool });
    }

    if (options.keep) {
      console.log(`kept: image ${options.name} runs in scope ${options.scope}`);
      return 0;
    }
    step = "stop";
    report(step, await images.stop(options.name));
    step = "delete";
    report(step, await images.delete(options.name));
    created = false;
    console.log("smoke passed");
    return 0;
  } catch (error) {
    console.error(formatFailure(step, error));
    return 1;
  } finally {
    if (created && !options.keep) {
      await images.stop(options.name).catch(() => undefined);
      await images.delete(options.name).catch((error) => {
        console.error(formatFailure("cleanup", error));
      });
    }
  }
}

process.exitCode = await main(process.argv.slice(2));
