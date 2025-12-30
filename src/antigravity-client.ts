import type {
  AntigravityRequest,
  AntigravityResponse,
  AntigravityStreamEvent,
  GeminiContent,
  GeminiPart,
  GeminiTool,
  GeminiSystemInstruction,
  FunctionDeclaration,
  GenerationConfig,
  ThinkingConfig,
  StoredAccount,
  SupportedModel,
  JsonSchema,
  Content,
} from './types/index.js';
import type { AcpMessage, AcpContent, SessionConfig, AcpTool } from './types/index.js';
import { ANTIGRAVITY_ENDPOINTS, DEFAULT_MODEL } from './types/antigravity.js';
import { ensureValidToken, refreshAccessToken } from './auth.js';

const USER_AGENT = 'antigravity-acp/0.1.0';

export interface StreamChunk {
  type: 'text' | 'thinking' | 'function_call' | 'done' | 'error';
  text?: string;
  functionCall?: {
    name: string;
    args: Record<string, unknown>;
    id: string;
  };
  finishReason?: string;
  error?: string;
}

function isThinkingModel(model: string): boolean {
  return model.includes('-thinking-');
}

function getThinkingBudget(model: string): number | undefined {
  if (!isThinkingModel(model)) return undefined;

  if (model.includes('-low')) return 8000;
  if (model.includes('-medium')) return 16000;
  if (model.includes('-high')) return 32000;

  return 16000;
}

function acpContentToGeminiPart(content: AcpContent): GeminiPart | null {
  switch (content.type) {
    case 'text':
      return { text: content.text };

    case 'image':
      return {
        inlineData: {
          mimeType: content.source.media_type,
          data: content.source.data,
        },
      };

    case 'tool_use':
      return {
        functionCall: {
          name: content.name,
          args: content.input,
          id: content.id,
        },
      };

    case 'tool_result':
      return {
        functionResponse: {
          name: content.tool_use_id,
          response: { result: content.content },
          id: content.tool_use_id,
        },
      };

    default:
      return null;
  }
}

function acpMessageToGeminiContent(message: AcpMessage): GeminiContent {
  const parts: GeminiPart[] = [];

  for (const content of message.content) {
    if (typeof content === 'string') {
      parts.push({ text: content });
    } else {
      const part = acpContentToGeminiPart(content);
      if (part) parts.push(part);
    }
  }

  return {
    role: message.role === 'user' ? 'user' : 'model',
    parts,
  };
}

function toolDefinitionToFunctionDeclaration(tool: AcpTool): FunctionDeclaration {
  const defaultSchema: JsonSchema = { type: 'object', properties: {}, required: [] };
  return {
    name: tool.name,
    description: tool.description || '',
    parameters: tool.inputSchema ? {
      type: (tool.inputSchema.type as string) || 'object',
      properties: (tool.inputSchema.properties as Record<string, JsonSchema>) || {},
      required: (tool.inputSchema.required as string[]) || [],
    } : defaultSchema,
  };
}

export function buildAntigravityRequest(
  messages: AcpMessage[],
  config: SessionConfig,
  projectId: string
): AntigravityRequest {
  const model = (config.model as SupportedModel) || DEFAULT_MODEL;

  const contents: GeminiContent[] = messages.map(acpMessageToGeminiContent);

  const generationConfig: GenerationConfig = {
    temperature: config.temperature,
    maxOutputTokens: config.maxTokens || (isThinkingModel(model) ? 65536 : 8192),
  };

  if (isThinkingModel(model)) {
    const thinkingConfig: ThinkingConfig = {
      includeThoughts: true,
      thinkingBudget: config.thinkingBudget || getThinkingBudget(model),
    };
    generationConfig.thinkingConfig = thinkingConfig;
  }

  const tools: GeminiTool[] = [];
  if (config.tools && config.tools.length > 0) {
    tools.push({
      functionDeclarations: config.tools.map(toolDefinitionToFunctionDeclaration),
    });
  }

  const request: AntigravityRequest = {
    project: projectId,
    model,
    request: {
      contents,
      generationConfig,
    },
    userAgent: USER_AGENT,
    requestId: crypto.randomUUID(),
  };

  if (config.systemPrompt) {
    request.request.systemInstruction = {
      parts: [{ text: config.systemPrompt }],
    };
  }

  if (tools.length > 0) {
    request.request.tools = tools;
  }

  return request;
}

export async function* streamAntigravityRequest(
  request: AntigravityRequest,
  account: StoredAccount,
  endpoint: 'daily' | 'autopush' | 'prod' = 'prod'
): AsyncGenerator<StreamChunk> {
  const validAccount = await ensureValidToken(account);

  const baseUrl = ANTIGRAVITY_ENDPOINTS[endpoint];
  const url = `${baseUrl}/v1internal:streamGenerateContent`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${validAccount.accessToken}`,
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
    },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    const text = await response.text();
    yield { type: 'error', error: `API error ${response.status}: ${text}` };
    return;
  }

  if (!response.body) {
    yield { type: 'error', error: 'No response body' };
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
    }

    buffer = buffer.trim();
    if (!buffer) return;

    let jsonStr = buffer;
    if (buffer.startsWith('data:')) {
      jsonStr = buffer.slice(5).trim();
    }
    if (jsonStr === '[DONE]') return;

    const parsed = JSON.parse(jsonStr);
    const items = Array.isArray(parsed) ? parsed : [parsed];

    for (const item of items) {
      const data = (item.response ? item : { response: item }) as AntigravityResponse;
      yield* processAntigravityChunk(data);
    }
  } finally {
    reader.releaseLock();
  }

  yield { type: 'done' };
}

function* processAntigravityChunk(data: AntigravityResponse): Generator<StreamChunk> {
  const response = data.response;
  if (!response?.candidates?.length) return;

  const candidate = response.candidates[0];
  const content = candidate.content;

  if (!content?.parts) return;

  for (const part of content.parts) {
    if ('text' in part && part.text) {
      yield { type: 'text', text: part.text };
    }

    if ('functionCall' in part && part.functionCall) {
      const fc = part.functionCall;
      yield {
        type: 'function_call',
        functionCall: {
          name: fc.name,
          args: fc.args,
          id: fc.id || crypto.randomUUID(),
        },
      };
    }
  }

  if (candidate.finishReason) {
    yield { type: 'done', finishReason: candidate.finishReason };
  }
}

export async function sendAntigravityRequest(
  request: AntigravityRequest,
  account: StoredAccount,
  endpoint: 'daily' | 'autopush' | 'prod' = 'prod'
): Promise<AntigravityResponse> {
  const validAccount = await ensureValidToken(account);

  const baseUrl = ANTIGRAVITY_ENDPOINTS[endpoint];
  const url = `${baseUrl}/v1internal:generateContent`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${validAccount.accessToken}`,
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
    },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`API error ${response.status}: ${text}`);
  }

  return response.json() as Promise<AntigravityResponse>;
}

export interface AntigravityClientOptions {
  accessToken: string;
  refreshToken: string;
  projectId: string;
  endpoint?: 'daily' | 'autopush' | 'prod';
}

export interface StreamGenerateContentOptions {
  model: string;
  contents: Content[];
  systemInstruction?: GeminiSystemInstruction;
  tools?: GeminiTool[];
  signal?: AbortSignal;
}

export function createAntigravityClient(options: AntigravityClientOptions) {
  const { projectId, endpoint = 'prod' } = options;
  let account: StoredAccount = {
    email: '',
    refreshToken: options.refreshToken,
    projectId: options.projectId,
    accessToken: options.accessToken,
    expiresAt: Date.now() + 3600 * 1000,
  };

  async function ensureToken(): Promise<StoredAccount> {
    if (account.expiresAt && account.expiresAt > Date.now() + 5 * 60 * 1000) {
      return account;
    }
    account = await refreshAccessToken(account);
    return account;
  }

  async function* streamGenerateContent(
    opts: StreamGenerateContentOptions
  ): AsyncGenerator<AntigravityStreamEvent> {
    const validAccount = await ensureToken();
    const baseUrl = ANTIGRAVITY_ENDPOINTS[endpoint];
    const url = `${baseUrl}/v1internal:streamGenerateContent`;

    const request: AntigravityRequest = {
      project: projectId,
      model: opts.model as SupportedModel,
      request: {
        contents: opts.contents as GeminiContent[],
        generationConfig: {
          maxOutputTokens: opts.model.includes('-thinking-') ? 65536 : 8192,
        },
      },
      userAgent: USER_AGENT,
      requestId: crypto.randomUUID(),
    };

    if (opts.systemInstruction) {
      request.request.systemInstruction = opts.systemInstruction;
    }

    if (opts.tools && opts.tools.length > 0) {
      request.request.tools = opts.tools;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${validAccount.accessToken}`,
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
      },
      body: JSON.stringify(request),
      signal: opts.signal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`API error ${response.status}: ${text}`);
    }

    if (!response.body) {
      throw new Error('No response body');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      // Read entire response (API returns formatted JSON, not line-delimited)
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
      }

      buffer = buffer.trim();
      if (!buffer) return;

      // Parse the response - could be array or object
      const parsed = JSON.parse(buffer);
      const items = Array.isArray(parsed) ? parsed : [parsed];

      for (const item of items) {
        const resp = item.response || item;
        if (resp?.candidates) {
          yield { response: resp };
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  return {
    streamGenerateContent,
  };
}

export type AntigravityClient = ReturnType<typeof createAntigravityClient>;
