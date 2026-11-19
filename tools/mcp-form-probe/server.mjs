import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer({ name: "form-probe", version: "1.0.0" });
server.registerTool(
  "probe_form",
  {
    description: "Display a synthetic confirmation form and return only its decision. No external access.",
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async () => {
    const capability = server.server.getClientCapabilities()?.elicitation;
    if (!capability || (!("form" in capability) && "url" in capability)) {
      return { content: [{ type: "text", text: "form-not-negotiated" }] };
    }
    const { action } = await server.server.elicitInput({
      mode: "form",
      message: "No-write probe. Confirm this synthetic two-case Manual Test batch?",
      requestedSchema: { type: "object", properties: {} },
    });
    return { content: [{ type: "text", text: action }] };
  },
);

await server.connect(new StdioServerTransport());
