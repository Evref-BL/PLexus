export interface PharoMcpHealthClient {
  check(port: number): Promise<boolean>;
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
    this.mcpPath = options.mcpPath ?? "/mcp";
    this.probeMethods = options.probeMethods ?? ["ping"];
    this.timeoutMs = options.timeoutMs ?? 1_000;
  }

  async check(port: number): Promise<boolean> {
    for (const method of this.probeMethods) {
      try {
        const response = await this.fetchWithTimeout(
          `http://${this.host}:${port}${this.mcpPath}`,
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
          `http://${this.host}:${port}${pathname}`,
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
    init: RequestInit = {},
  ): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      return await fetch(input, {
        ...init,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  private async isJsonRpcResponse(response: Response): Promise<boolean> {
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
