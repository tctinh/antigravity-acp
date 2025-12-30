export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export type JsonRpcErrorCode = number;

export const JSON_RPC_ERRORS = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

export type AcpMethod =
  | 'initialize'
  | 'newSession'
  | 'prompt'
  | 'cancel'
  | 'shutdown'
  | 'toolResult';

export interface InitializeParams {
  clientInfo?: {
    name: string;
    version: string;
  };
  capabilities?: ClientCapabilities;
}

export interface ClientCapabilities {
  tools?: boolean;
  streaming?: boolean;
}

export interface AuthMethod {
  id: string;
  name: string;
  description: string;
}

export interface InitializeResult {
  serverInfo: {
    name: string;
    version: string;
  };
  capabilities: ServerCapabilities;
  authMethods?: AuthMethod[];
}

export interface ServerCapabilities {
  streaming?: boolean;
  tools?: boolean;
  prompts?: boolean;
  images?: boolean;
}

export interface NewSessionParams {
  config?: SessionConfig;
}

export interface SessionConfig {
  model?: string;
  systemPrompt?: string;
  systemInstruction?: string;
  temperature?: number;
  maxTokens?: number;
  tools?: AcpTool[];
  thinkingBudget?: number;
}

export interface NewSessionResult {
  sessionId: string;
}

export interface PromptParams {
  sessionId: string;
  messages: AcpMessage[];
}

export interface PromptResult {
  pending?: Array<{ id: string; name: string }>;
}

export interface AcpMessage {
  role: 'user' | 'assistant';
  content: string | AcpContent[];
}

export type AcpContent =
  | AcpTextContent
  | AcpImageContent
  | AcpToolUseContent
  | AcpToolResultContent;

export interface AcpTextContent {
  type: 'text';
  text: string;
}

export interface AcpImageContent {
  type: 'image';
  source: {
    type: 'base64';
    media_type: string;
    data: string;
  };
}

export interface AcpToolUseContent {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AcpToolResultContent {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export interface ToolResultParams {
  sessionId: string;
  toolUseId: string;
  callId: string;
  tool: { name: string; arguments?: Record<string, unknown> };
  result: string;
  isError?: boolean;
}

export interface CancelParams {
  sessionId: string;
}

export interface AcpTool {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

export interface JsonSchema {
  type: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  description?: string;
  items?: JsonSchema;
  enum?: string[];
  default?: unknown;
  additionalProperties?: boolean | JsonSchema;
}

export interface SessionUpdate {
  type: 'sessionUpdate';
  sessionId: string;
  update: SessionUpdatePayload;
}

export type SessionUpdatePayload =
  | AgentMessageChunk
  | AgentThoughtChunk
  | ToolCall
  | SessionComplete
  | SessionError;

export interface AgentMessageChunk {
  type: 'agent_message_chunk';
  kind?: 'message';
  messageId: string;
  index: number;
  chunk: string;
}

export interface AgentThoughtChunk {
  type: 'agent_thought_chunk';
  kind?: 'thought';
  thoughtId: string;
  index: number;
  chunk: string;
}

export interface ToolCall {
  type: 'tool_call';
  kind?: 'tool_call';
  callId: string;
  tool: AcpTool;
  input: Record<string, unknown>;
}

export interface SessionComplete {
  type: 'session_complete';
  kind?: 'finish';
  reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'error';
}

export interface SessionError {
  type: 'session_error';
  kind?: 'error';
  error: { code: string; message: string };
}

export interface SessionUpdateNotification {
  jsonrpc: '2.0';
  method: 'sessionUpdate';
  params: {
    sessionId: string;
    update: SessionUpdatePayload;
  };
}
