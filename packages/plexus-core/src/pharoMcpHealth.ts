import type { ProjectImageMcpEndpoint } from "./projectState.js";

export interface PharoMcpHealthClient {
  check(port: number): Promise<boolean>;
  checkEndpoint?(endpoint: ProjectImageMcpEndpoint): Promise<boolean>;
}

export interface HttpPharoMcpHealthClientOptions {
  host?: string;
  paths?: string[];
  mcpPath?: string;
  probeMethods?: string[];
  timeoutMs?: number;
}

export class HttpPharoMcpHealthClient implements PharoMcpHealthClient {
  private readonly host: string;
  private readonly paths: string[];
  private readonly mcpPath: string;
  private readonly probeMethods: string[];
  private readonly timeoutMs: number;

  constructor(options: HttpPharoMcpHealthClientOptions = {}) {
    this.host = options.host ?? "127.0.0.1";
    this.paths = options.paths ?? ["/health"];
    this.mcpPath = options.mcpPath ?? "/";
    this.probeMethods = options.probeMethods ?? ["ping"];
    this.timeoutMs = options.timeoutMs ?? 1_000;
  }

  async check(port: number): Promise<boolean> {
    return this.checkHttpTarget({
      host: this.host,
      port,
      mcpPath: this.mcpPath,
    });
  }

  async checkEndpoint(endpoint: ProjectImageMcpEndpoint): Promise<boolean> {
    if (endpoint.transport !== "http") {
      return false;
    }

    return this.checkHttpTarget({
      host: endpoint.host,
      port: endpoint.port,
      mcpPath: endpoint.path,
    });
  }

  private async checkHttpTarget(options: {
    host: string;
    port: number;
    mcpPath: string;
  }): Promise<boolean> {
    for (const method of this.probeMethods) {
      try {
        const response = await this.fetchWithTimeout(
          `http://${options.host}:${options.port}${options.mcpPath}`,
          {
            method: "POST",
            headers: {
              accept: "application/json, text/event-stream",
              "content-type": "application/json",
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: "plexus-health-check",
              method,
            }),
          },
        );

        if (await this.isJsonRpcResponse(response)) {
          return true;
        }
      } catch {
        // Keep polling through transient startup failures.
      }
    }

    for (const pathname of this.paths) {
      try {
        const response = await this.fetchWithTimeout(
          `http://${options.host}:${options.port}${pathname}`,
        );
        if (response.ok) {
          return true;
        }
      } catch {
        // Keep polling through transient startup failures.
      }
    }

    return false;
  }

  private async fetchWithTimeout(
    input: string,
    init: Record<string, unknown> = {},
  ): Promise<{ ok: boolean; json(): Promise<unknown> }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(input, {
        ...init,
        signal: controller.signal,
      });
      return response as { ok: boolean; json(): Promise<unknown> };
    } finally {
      clearTimeout(timeout);
    }
  }

  private async isJsonRpcResponse(
    response: { json(): Promise<unknown> },
  ): Promise<boolean> {
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return false;
    }

    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return false;
    }

    const candidate = payload as Record<string, unknown>;
    return (
      candidate.jsonrpc === "2.0" &&
      ("result" in candidate || "error" in candidate)
    );
  }
}
