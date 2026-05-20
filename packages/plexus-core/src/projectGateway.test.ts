import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { projectGatewayChildEnvironment } from "./projectGateway.js";

const pharoEvalTool: Tool = {
  name: "pharo_eval",
  description: "Evaluate Smalltalk code in a routed Pharo image.",
  inputSchema: {
    type: "object",
    properties: {
      code: { type: "string" },
    },
    required: ["code"],
    additionalProperties: false,
  },
};

describe("project gateway child environment", () => {
  it("projects explicit Pharo facade tools and contract into the HTTP gateway", () => {
    const env = projectGatewayChildEnvironment({
      env: {
        PLEXUS_GATEWAY_SURFACE: "route-control",
        PLEXUS_PHARO_TOOLS_JSON: "[]",
      },
      pharoTools: [pharoEvalTool],
      pharoMcpContract: {
        id: "mcp-pharo",
        hash: "sha256:expected",
      },
    });

    expect(env.PLEXUS_GATEWAY_SURFACE).toBe("gateway");
    expect(JSON.parse(env.PLEXUS_PHARO_TOOLS_JSON ?? "")).toEqual([
      pharoEvalTool,
    ]);
    expect(JSON.parse(env.PLEXUS_PHARO_MCP_CONTRACT_JSON ?? "")).toEqual({
      id: "mcp-pharo",
      hash: "sha256:expected",
    });
  });

  it("preserves an environment-projected Pharo facade contract when no explicit override is supplied", () => {
    const env = projectGatewayChildEnvironment({
      env: {
        PLEXUS_PHARO_TOOLS_JSON: JSON.stringify([pharoEvalTool]),
        PLEXUS_PHARO_MCP_CONTRACT_JSON: JSON.stringify({
          id: "env-contract",
        }),
      },
    });

    expect(JSON.parse(env.PLEXUS_PHARO_TOOLS_JSON ?? "")).toEqual([
      pharoEvalTool,
    ]);
    expect(JSON.parse(env.PLEXUS_PHARO_MCP_CONTRACT_JSON ?? "")).toEqual({
      id: "env-contract",
    });
  });
});
