// The part of pi's extension API these extensions use (`ExtensionAPI`, `ExtensionContext` and `ToolDefinition` of
// `@earendil-works/pi-coding-agent`). Written out here so the package and its tests do not need pi installed;
// pi passes its full API, which has these members.

export interface ToolResult {
  content: { type: "text"; text: string }[];
  details: Record<string, unknown>;
}

export interface ToolContext {
  cwd: string;
  hasUI: boolean;
  ui: {
    /** In RPC mode this becomes an `extension_ui_request` the host answers. `undefined` when dismissed. */
    input(title: string, placeholder?: string): Promise<string | undefined>;
  };
}

export interface ToolDefinition {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: unknown;
  execute(
    toolCallId: string,
    params: any,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: ToolContext,
  ): Promise<ToolResult>;
}

export interface ToolCallEvent {
  toolName: string;
  toolCallId: string;
  input: Record<string, unknown>;
}

export interface PiApi {
  registerTool(tool: ToolDefinition): void;
  on(event: string, handler: (event: any, ctx: any) => unknown): void;
}

export function text(value: string): ToolResult {
  return { content: [{ type: "text", text: value }], details: {} };
}
