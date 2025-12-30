export interface AntigravityRequest {
  project: string;
  model: string;
  request: GeminiRequest;
  userAgent?: string;
  requestId?: string;
}

export interface GeminiRequest {
  contents: GeminiContent[];
  systemInstruction?: GeminiSystemInstruction;
  generationConfig?: GenerationConfig;
  tools?: GeminiTool[];
}

export type Content = GeminiContent;
export type Part = GeminiPart;

export interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

export type GeminiPart =
  | GeminiTextPart
  | GeminiThoughtPart
  | GeminiInlineDataPart
  | GeminiFunctionCallPart
  | GeminiFunctionResponsePart;

export interface GeminiTextPart {
  text: string;
}

export interface GeminiThoughtPart {
  text: string;
  thought: boolean;
}

export interface GeminiInlineDataPart {
  inlineData: {
    mimeType: string;
    data: string;
  };
}

export interface FunctionCall {
  name: string;
  args: Record<string, unknown>;
  id?: string;
}

export interface GeminiFunctionCallPart {
  functionCall: FunctionCall;
}

export interface FunctionResponse {
  name: string;
  response: Record<string, unknown>;
  id?: string;
}

export interface GeminiFunctionResponsePart {
  functionResponse: FunctionResponse;
}

export interface GeminiSystemInstruction {
  parts: GeminiTextPart[];
}

export interface GenerationConfig {
  temperature?: number;
  maxOutputTokens?: number;
  topP?: number;
  topK?: number;
  thinkingConfig?: ThinkingConfig;
}

export interface ThinkingConfig {
  thinkingBudget?: number;
  includeThoughts?: boolean;
}

export interface GeminiTool {
  functionDeclarations: FunctionDeclaration[];
}

export interface FunctionDeclaration {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface JsonSchema {
  type: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  description?: string;
  items?: JsonSchema;
  enum?: string[];
}

export interface AntigravityResponse {
  response: GeminiResponse;
  traceId?: string;
}

export interface GeminiResponse {
  candidates: GeminiCandidate[];
  usageMetadata?: UsageMetadata;
}

export interface GeminiCandidate {
  content: GeminiContent;
  finishReason?: FinishReason;
}

export type FinishReason =
  | 'STOP'
  | 'MAX_TOKENS'
  | 'SAFETY'
  | 'RECITATION'
  | 'OTHER'
  | 'TOOL_USE';

export interface UsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
}

export interface AntigravityStreamEvent {
  response?: GeminiResponse;
  error?: { code: number; message: string; status?: string };
}

export interface AntigravityError {
  error: {
    code: number;
    message: string;
    status?: string;
  };
}

export interface StoredAccount {
  email: string;
  refreshToken: string;
  projectId: string;
  accessToken?: string;
  expiresAt?: number;
}

export interface AntigravityConfig {
  accounts: StoredAccount[];
  activeAccountIndex?: number;
  endpoint?: 'daily' | 'autopush' | 'prod';
}

export const ANTIGRAVITY_ENDPOINTS = {
  daily: 'https://cloudcode-pa-daily.sandbox.googleapis.com',
  autopush: 'https://cloudcode-pa-autopush.sandbox.googleapis.com',
  prod: 'https://cloudcode-pa.googleapis.com',
} as const;

export const SUPPORTED_MODELS = [
  'gemini-2.0-flash',
  'gemini-3-pro-low',
  'gemini-3-pro-high',
  'gemini-3-flash',
  'claude-sonnet-4-5',
  'claude-sonnet-4-5-thinking-low',
  'claude-sonnet-4-5-thinking-medium',
  'claude-sonnet-4-5-thinking-high',
  'claude-opus-4-5-thinking-low',
  'claude-opus-4-5-thinking-medium',
  'claude-opus-4-5-thinking-high',
  'gpt-oss-120b-medium',
] as const;

export type SupportedModel = (typeof SUPPORTED_MODELS)[number];

export const DEFAULT_MODEL: SupportedModel = 'gemini-2.0-flash';
