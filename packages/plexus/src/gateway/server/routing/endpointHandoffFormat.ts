/**
 * The endpoint handoff format, written by an image and read by whoever needs
 * to reach it.
 *
 * It lived twice: once here for routing, once outside the gateway for the
 * runtime observation `image_list` reports. The two copies disagreed about
 * what counts as valid — a port of `08080` or `8080abc` was refused by one and
 * routed to by the other — so an image could read as stopped while the gateway
 * sent its tool calls somewhere. One definition, read from both sides; the
 * gateway boundary allows that because this reaches nothing outside itself.
 */
export interface EndpointHandoff {
  transport: "http";
  host: string;
  port: number;
  path: string;
  /**
   * The process that bound the port, when the image could tell. A port
   * outlives the process that bound it, so this is what separates an endpoint
   * from the memory of one. Images that cannot tell their own pid write no
   * pid line, and a reader without one has only the port to go on.
   */
  pid?: number;
}

export function parseEndpointHandoff(source: string): EndpointHandoff {
  return validatedEndpoint(parseProperties(source));
}

function parseProperties(source: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  // Image-side writers use Pharo's cr, so a bare CR separates the lines.
  for (const rawLine of source.split(/\r\n|\n|\r/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const separator = line.indexOf("=");
    if (separator <= 0) {
      throw new Error(`Invalid endpoint handoff line: ${rawLine}`);
    }

    parsed[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }

  return parsed;
}

function pidProperty(value: string | undefined): { pid?: number } {
  if (value === undefined) {
    return {};
  }

  const pid = Number.parseInt(value, 10);
  if (!Number.isInteger(pid) || String(pid) !== value || pid < 1) {
    throw new Error(`MCP endpoint pid must be a positive integer, got ${value}`);
  }

  return { pid };
}

function validatedEndpoint(
  properties: Record<string, string>,
): EndpointHandoff {
  const transport = properties.transport;
  if (transport !== "http") {
    throw new Error(
      `MCP endpoint transport must be http, got ${transport || "<missing>"}`,
    );
  }

  const host = properties.host;
  if (!host) {
    throw new Error("MCP endpoint host is missing");
  }

  const port = Number.parseInt(properties.port ?? "", 10);
  if (
    !Number.isInteger(port) ||
    String(port) !== properties.port ||
    port < 1 ||
    port > 65_535
  ) {
    throw new Error(
      `MCP endpoint port must be an integer between 1 and 65535, got ${properties.port ?? "<missing>"}`,
    );
  }

  const path = properties.path;
  if (!path || !path.startsWith("/")) {
    throw new Error("MCP endpoint path must start with /");
  }

  return { transport, host, port, path, ...pidProperty(properties.pid) };
}
