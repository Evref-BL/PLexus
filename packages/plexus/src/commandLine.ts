/**
 * The `plexus` command: the image verbs over the library, and `plexus mcp`.
 * Every result is JSON on stdout; a refusal is `{"ok":false,...}` there too,
 * with exit status 1, and a command line it cannot read exits with 2.
 */
import { PlexusError } from "./errors.js";
import { Images } from "./images/index.js";
import { runPlexusMcpServer, type ImagesApi } from "./mcp/server.js";
import type { ImagesOptions, StartOptions } from "./types.js";

export interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
  env: NodeJS.ProcessEnv;
}

export interface CliDependencies {
  images(options: ImagesOptions): ImagesApi;
  serveMcp(images: ImagesApi): Promise<void>;
}

const defaultDependencies: CliDependencies = {
  images: (options) => new Images(options),
  serveMcp: (images) => runPlexusMcpServer({ images }),
};

type Verb = "templates" | "create" | "start" | "stop" | "delete" | "list";

interface CommandSpec {
  usage: string;
  summary: string;
  values: string[];
  flags: string[];
  positionals: { min: number; max: number };
}

const globalUsage = "[--home <dir>] [--scope <prefix>]";

const imageCommands: Record<Verb, CommandSpec> = {
  templates: {
    usage: "plexus image templates",
    summary: "List the templates an image can be created from.",
    values: [],
    flags: [],
    positionals: { min: 0, max: 0 },
  },
  create: {
    usage: "plexus image create <name> --template <t> [--category <c>] [--script <file> [--every-start]]",
    summary:
      "Create an image with MCP in it, not started. A script is filed in instead of loading the pinned MCP; --every-start files it in at every start too.",
    values: ["template", "category", "script"],
    flags: ["every-start"],
    positionals: { min: 1, max: 1 },
  },
  start: {
    usage: "plexus image start <name> [--display interactive] [--timeout <seconds>]",
    summary: "Start an image and wait until its MCP server answers. Refused while it runs.",
    values: ["display", "timeout"],
    flags: [],
    positionals: { min: 1, max: 1 },
  },
  stop: {
    usage: "plexus image stop <name>",
    summary: "Kill every VM running the image, without saving.",
    values: [],
    flags: [],
    positionals: { min: 1, max: 1 },
  },
  delete: {
    usage: "plexus image delete <name>",
    summary: "Delete the image's directory. Refused while it runs.",
    values: [],
    flags: [],
    positionals: { min: 1, max: 1 },
  },
  list: {
    usage: "plexus image list [<name>]",
    summary: "List the images and whether each runs, or only the one named.",
    values: [],
    flags: [],
    positionals: { min: 0, max: 1 },
  },
};

const mcpCommand: CommandSpec = {
  usage: "plexus mcp",
  summary:
    "Serve the image tools and the running images' own tools over stdio, in the scope given at launch.",
  values: [],
  flags: [],
  positionals: { min: 0, max: 0 },
};

class UsageError extends Error {
  constructor(
    message: string,
    readonly usage: string,
  ) {
    super(message);
  }
}

interface Parsed {
  positionals: string[];
  values: Map<string, string>;
  flags: Set<string>;
  help: boolean;
}

function parse(args: readonly string[], spec: CommandSpec): Parsed {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const positionals: string[] = [];
  let help = false;
  const allowedValues = new Set(["home", "scope", ...spec.values]);
  const allowedFlags = new Set(spec.flags);

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const [option, inline] = splitOption(arg.slice(2));
    if (allowedFlags.has(option)) {
      if (inline !== undefined) {
        throw new UsageError(`--${option} takes no value`, spec.usage);
      }
      flags.add(option);
    } else if (allowedValues.has(option)) {
      const value = inline ?? args[++index];
      if (value === undefined || (inline === undefined && value.startsWith("--"))) {
        throw new UsageError(`--${option} needs a value`, spec.usage);
      }
      values.set(option, value);
    } else {
      throw new UsageError(`Unknown option --${option}`, spec.usage);
    }
  }

  if (!help) {
    if (positionals.length < spec.positionals.min) {
      throw new UsageError("Missing the image name", spec.usage);
    }
    if (positionals.length > spec.positionals.max) {
      throw new UsageError(`Unexpected argument ${positionals[spec.positionals.max]}`, spec.usage);
    }
  }
  return { positionals, values, flags, help };
}

function splitOption(option: string): [string, string | undefined] {
  const equals = option.indexOf("=");
  return equals < 0 ? [option, undefined] : [option.slice(0, equals), option.slice(equals + 1)];
}

function imagesOptions(parsed: Parsed, env: NodeJS.ProcessEnv): ImagesOptions {
  const home = parsed.values.get("home") ?? env.PLEXUS_HOME;
  const scope = parsed.values.get("scope") ?? env.PLEXUS_SCOPE;
  return {
    ...(home ? { home } : {}),
    ...(scope ? { scope } : {}),
  };
}

function startOptions(parsed: Parsed, usage: string): StartOptions {
  const display = parsed.values.get("display");
  if (display !== undefined && display !== "headless" && display !== "interactive") {
    throw new UsageError("--display is headless or interactive", usage);
  }
  const timeout = parsed.values.get("timeout");
  const seconds = timeout === undefined ? undefined : Number(timeout);
  if (seconds !== undefined && !(Number.isFinite(seconds) && seconds > 0)) {
    throw new UsageError("--timeout is a number of seconds", usage);
  }
  return {
    ...(display === undefined ? {} : { display }),
    ...(seconds === undefined ? {} : { timeoutMs: Math.round(seconds * 1000) }),
  };
}

function help(): string {
  return [
    "Usage:",
    ...Object.values(imageCommands).map((spec) => `  ${spec.usage}`),
    `  ${mcpCommand.usage}`,
    "",
    `Every command takes ${globalUsage}.`,
    "  --home   where images, VMs and templates live (PLEXUS_HOME; ~/.plexus)",
    "  --scope  a name prefix: image dev is the directory <scope>-dev (PLEXUS_SCOPE)",
    "",
    "Results are JSON on stdout. A refusal is {\"ok\":false,\"code\":...,\"error\":...} and exits 1.",
  ].join("\n");
}

function commandHelp(spec: CommandSpec): string {
  return [`Usage: ${spec.usage} ${globalUsage}`, "", spec.summary].join("\n");
}

export async function runCli(
  argv: readonly string[],
  io: CliIo,
  dependencies: CliDependencies = defaultDependencies,
): Promise<number> {
  const print = (value: unknown) => io.stdout(`${JSON.stringify(value, null, 2)}\n`);
  try {
    const [noun, verb, ...rest] = argv;
    if (noun === undefined || noun === "--help" || noun === "-h") {
      (noun === undefined ? io.stderr : io.stdout)(`${help()}\n`);
      return noun === undefined ? 2 : 0;
    }

    if (noun === "mcp") {
      const parsed = parse(argv.slice(1), mcpCommand);
      if (parsed.help) {
        io.stdout(`${commandHelp(mcpCommand)}\n`);
        return 0;
      }
      await dependencies.serveMcp(dependencies.images(imagesOptions(parsed, io.env)));
      return 0;
    }

    if (noun !== "image") {
      throw new UsageError(`Unknown command ${noun}`, help());
    }
    if (verb === undefined || verb === "--help" || verb === "-h") {
      (verb === undefined ? io.stderr : io.stdout)(`${help()}\n`);
      return verb === undefined ? 2 : 0;
    }
    if (!(verb in imageCommands)) {
      throw new UsageError(`Unknown image command ${verb}`, help());
    }
    const spec = imageCommands[verb as Verb];
    const parsed = parse(rest, spec);
    if (parsed.help) {
      io.stdout(`${commandHelp(spec)}\n`);
      return 0;
    }

    const images = dependencies.images(imagesOptions(parsed, io.env));
    const [name] = parsed.positionals;
    switch (verb as Verb) {
      case "templates":
        print(await images.templates());
        break;
      case "create": {
        const template = parsed.values.get("template");
        if (template === undefined) {
          throw new UsageError("create needs --template", spec.usage);
        }
        const category = parsed.values.get("category");
        const script = parsed.values.get("script");
        print(
          await images.create(name, {
            template,
            ...(category === undefined ? {} : { category }),
            ...(script === undefined ? {} : { script }),
            ...(parsed.flags.has("every-start") ? { everyStart: true } : {}),
          }),
        );
        break;
      }
      case "start":
        print(await images.start(name, startOptions(parsed, spec.usage)));
        break;
      case "stop":
        print(await images.stop(name));
        break;
      case "delete":
        print(await images.delete(name));
        break;
      case "list":
        print(await images.list(name));
        break;
    }
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(`plexus: ${error.message}\n\n${error.usage}\n`);
      return 2;
    }
    print(
      error instanceof PlexusError
        ? {
            ok: false,
            code: error.code,
            error: error.message,
            ...(error.details ? { details: error.details } : {}),
          }
        : { ok: false, error: error instanceof Error ? error.message : String(error) },
    );
    return 1;
  }
}
