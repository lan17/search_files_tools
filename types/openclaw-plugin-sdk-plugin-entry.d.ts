declare module "openclaw/plugin-sdk/plugin-entry" {
  export type AgentToolContent =
    | {
        type: "text";
        text: string;
      }
    | {
        type: string;
        [key: string]: unknown;
      };

  export type AgentToolResult<TDetails = unknown> = {
    content: AgentToolContent[];
    details?: TDetails;
  };

  export type AnyAgentTool = {
    name: string;
    label?: string;
    description?: string;
    parameters?: unknown;
    execute: (
      toolCallId: string,
      params: Record<string, unknown>,
      signal?: AbortSignal,
      onUpdate?: unknown,
    ) => AgentToolResult<unknown> | Promise<AgentToolResult<unknown>>;
  };

  export type OpenClawPluginToolContext = {
    fsPolicy?: {
      workspaceOnly?: boolean;
    };
    workspaceDir?: string;
    sandboxed?: boolean;
    agentId?: string;
    sessionKey?: string;
    sessionId?: string;
  };

  export type OpenClawPluginToolFactory = (
    context: OpenClawPluginToolContext,
  ) => AnyAgentTool | AnyAgentTool[] | null | undefined;

  export type OpenClawPluginApi = {
    id: string;
    name: string;
    version?: string;
    description?: string;
    source?: string;
    config?: Record<string, unknown>;
    pluginConfig?: unknown;
    logger?: {
      debug?(message: string): void;
      info(message: string): void;
      warn(message: string): void;
      error?(message: string): void;
    };
    registerTool(
      tool: AnyAgentTool | OpenClawPluginToolFactory,
      opts?: {
        name?: string;
        names?: string[];
        optional?: boolean;
      },
    ): void;
  };

  export type OpenClawDefinedPluginEntry = {
    id: string;
    name: string;
    description?: string;
    register(api: OpenClawPluginApi): unknown;
  };

  export function definePluginEntry<TEntry extends OpenClawDefinedPluginEntry>(
    entry: TEntry,
  ): TEntry;
}
