export interface PharoMcpHealthClient {
  check(port: number): Promise<boolean>;
}

export interface HttpPharoMcpHealthClientOptions {
  host?: string;
  paths?: string[];
  timeoutMs?: number;
}

export class HttpPharoMcpHealthClient implements PharoMcpHealthClient {
  private readonly host: string;
  private readonly paths: string[];
  private readonly timeoutMs: number;

  constructor(options: HttpPharoMcpHealthClientOptions = {}) {
    this.host = options.host ?? "127.0.0.1";
    this.paths = options.paths ?? ["/health"];
    this.timeoutMs = options.timeoutMs ?? 1_000;
  }

  async check(port: number): Promise<boolean> {
    for (const pathname of this.paths) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const response = await fetch(`http://${this.host}:${port}${pathname}`, {
          signal: controller.signal,
        });
        if (response.ok) {
          return true;
        }
      } catch {
        // Keep polling through transient startup failures.
      } finally {
        clearTimeout(timeout);
      }
    }

    return false;
  }
}
