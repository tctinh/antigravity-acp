import * as readline from 'readline';
import type {
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcNotification,
  InitializeParams,
  InitializeResult,
  NewSessionParams,
  NewSessionResult,
  PromptParams,
  PromptResult,
  ToolResultParams,
  CancelParams,
  AcpTool,
  JsonRpcErrorCode,
} from './types/acp.js';
import { createSessionManager } from './session.js';
import { createAntigravityClient, type AntigravityClient } from './antigravity-client.js';
import { createStreamAdapter } from './stream-adapter.js';
import { ACP_TOOLS, acpToolsToFunctionDeclarations } from './tools.js';
import { loadAuthFromConfig, type AuthConfig } from './auth.js';

const SERVER_NAME = 'antigravity-acp';
const SERVER_VERSION = '0.1.0';

export interface AcpServerOptions {
  auth?: AuthConfig;
  defaultModel?: string;
  tools?: AcpTool[];
}

export function createAcpServer(options: AcpServerOptions = {}) {
  const sessionManager = createSessionManager({ defaultModel: options.defaultModel });
  const tools = options.tools || ACP_TOOLS;
  let antigravityClient: AntigravityClient | null = null;
  let initialized = false;

  function sendResponse(response: JsonRpcResponse): void {
    process.stdout.write(JSON.stringify(response) + '\n');
  }

  function sendNotification(notification: JsonRpcNotification): void {
    process.stdout.write(JSON.stringify(notification) + '\n');
  }

  function sendError(id: string | number | null, code: JsonRpcErrorCode, message: string): void {
    sendResponse({
      jsonrpc: '2.0',
      id,
      error: { code, message },
    });
  }

  async function handleInitialize(
    id: string | number,
    _params: InitializeParams
  ): Promise<void> {
    const auth = options.auth || (await loadAuthFromConfig());
    
    if (auth) {
      antigravityClient = createAntigravityClient({
        accessToken: auth.accessToken,
        refreshToken: auth.refreshToken,
        projectId: auth.projectId,
      });
    }

    initialized = true;

    const result = {
      protocolVersion: 1,
      agentCapabilities: {
        promptCapabilities: {
          image: false,
          embeddedContext: true,
        },
        mcpCapabilities: {
          http: false,
          sse: false,
        },
        sessionCapabilities: {},
      },
      agentInfo: {
        name: SERVER_NAME,
        title: 'Antigravity',
        version: SERVER_VERSION,
      },
      authMethods: [
        {
          id: 'antigravity-login',
          name: 'Log in with Google (Antigravity)',
          description: 'Run `antigravity-acp login` in your terminal to authenticate with Google OAuth',
        },
      ],
    };

    sendResponse({ jsonrpc: '2.0', id, result });
  }

  function handleNewSession(id: string | number, params: NewSessionParams): void {
    if (!initialized) {
      sendError(id, -32002, 'Server not initialized');
      return;
    }

    if (!antigravityClient) {
      sendResponse({
        jsonrpc: '2.0',
        id,
        error: {
          code: -32001,
          message: 'Authentication required',
          data: { type: 'authRequired' },
        },
      });
      return;
    }

    const session = sessionManager.createSession(params.config);

    const result: NewSessionResult = {
      sessionId: session.id,
    };

    sendResponse({ jsonrpc: '2.0', id, result });
  }

  async function handlePrompt(id: string | number, params: PromptParams): Promise<void> {
    if (!initialized || !antigravityClient) {
      sendError(id, -32002, 'Server not initialized');
      return;
    }

    const session = sessionManager.getSession(params.sessionId);
    if (!session) {
      sendError(id, -32001, `Session not found: ${params.sessionId}`);
      return;
    }

    const userText = params.messages
      .filter((m) => m.role === 'user')
      .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
      .join('\n');

    if (userText) {
      sessionManager.addUserMessage(params.sessionId, userText);
    }

    const abortController = new AbortController();
    sessionManager.setAbortController(params.sessionId, abortController);

    try {
      const functionDeclarations = acpToolsToFunctionDeclarations(
        session.tools.length > 0 ? session.tools : tools
      );

      const stream = await antigravityClient.streamGenerateContent({
        model: session.model,
        contents: sessionManager.getContents(params.sessionId),
        systemInstruction: session.systemInstruction
          ? { parts: [{ text: session.systemInstruction }] }
          : undefined,
        tools: functionDeclarations.length > 0 ? [{ functionDeclarations }] : undefined,
        signal: abortController.signal,
      });

      const adapter = createStreamAdapter(params.sessionId);
      let pendingToolCalls: Array<{ id: string; name: string }> = [];

      for await (const event of stream) {
        const notifications = adapter.processEvent(event);

        for (const notification of notifications) {
          sendNotification(notification);

          if (notification.params.update.kind === 'tool_call') {
            const toolCall = notification.params.update;
            pendingToolCalls.push({ id: toolCall.callId, name: toolCall.tool.name });
            sessionManager.addToolCall(params.sessionId, {
              name: toolCall.tool.name,
              args: toolCall.input || {},
              id: toolCall.callId,
            });
          }

          if (notification.params.update.kind === 'finish') {
            const fullText = adapter.getAccumulatedText();
            if (fullText) {
              sessionManager.addAssistantMessage(params.sessionId, fullText);
            }
          }
        }
      }

      const result: PromptResult = {
        pending: pendingToolCalls.length > 0 ? pendingToolCalls : undefined,
      };
      sendResponse({ jsonrpc: '2.0', id, result });
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        sendError(id, -32001, 'Request cancelled');
      } else {
        sendError(id, -32000, (error as Error).message || 'Unknown error');
      }
    } finally {
      sessionManager.setAbortController(params.sessionId, null);
    }
  }

  async function handleToolResult(id: string | number, params: ToolResultParams): Promise<void> {
    if (!initialized || !antigravityClient) {
      sendError(id, -32002, 'Server not initialized');
      return;
    }

    const session = sessionManager.getSession(params.sessionId);
    if (!session) {
      sendError(id, -32001, `Session not found: ${params.sessionId}`);
      return;
    }

    sessionManager.addToolResult(
      params.sessionId,
      params.callId,
      params.tool.name,
      params.result
    );

    const abortController = new AbortController();
    sessionManager.setAbortController(params.sessionId, abortController);

    try {
      const functionDeclarations = acpToolsToFunctionDeclarations(
        session.tools.length > 0 ? session.tools : tools
      );

      const stream = await antigravityClient.streamGenerateContent({
        model: session.model,
        contents: sessionManager.getContents(params.sessionId),
        systemInstruction: session.systemInstruction
          ? { parts: [{ text: session.systemInstruction }] }
          : undefined,
        tools: functionDeclarations.length > 0 ? [{ functionDeclarations }] : undefined,
        signal: abortController.signal,
      });

      const adapter = createStreamAdapter(params.sessionId);
      let pendingToolCalls: Array<{ id: string; name: string }> = [];

      for await (const event of stream) {
        const notifications = adapter.processEvent(event);

        for (const notification of notifications) {
          sendNotification(notification);

          if (notification.params.update.kind === 'tool_call') {
            const toolCall = notification.params.update;
            pendingToolCalls.push({ id: toolCall.callId, name: toolCall.tool.name });
            sessionManager.addToolCall(params.sessionId, {
              name: toolCall.tool.name,
              args: toolCall.input || {},
              id: toolCall.callId,
            });
          }

          if (notification.params.update.kind === 'finish') {
            const fullText = adapter.getAccumulatedText();
            if (fullText) {
              sessionManager.addAssistantMessage(params.sessionId, fullText);
            }
          }
        }
      }

      const result: PromptResult = {
        pending: pendingToolCalls.length > 0 ? pendingToolCalls : undefined,
      };
      sendResponse({ jsonrpc: '2.0', id, result });
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        sendError(id, -32001, 'Request cancelled');
      } else {
        sendError(id, -32000, (error as Error).message || 'Unknown error');
      }
    } finally {
      sessionManager.setAbortController(params.sessionId, null);
    }
  }

  function handleCancel(id: string | number, params: CancelParams): void {
    const cancelled = sessionManager.cancelSession(params.sessionId);
    sendResponse({ jsonrpc: '2.0', id, result: { cancelled } });
  }

  function handleShutdown(id: string | number): void {
    sessionManager.clear();
    sendResponse({ jsonrpc: '2.0', id, result: {} });
    process.exit(0);
  }

  async function handleRequest(request: JsonRpcRequest): Promise<void> {
    const { id, method, params } = request;

    switch (method) {
      case 'initialize':
        await handleInitialize(id, params as InitializeParams);
        break;
      case 'newSession':
        handleNewSession(id, params as NewSessionParams);
        break;
      case 'prompt':
        await handlePrompt(id, params as unknown as PromptParams);
        break;
      case 'toolResult':
        await handleToolResult(id, params as unknown as ToolResultParams);
        break;
      case 'cancel':
        handleCancel(id, params as unknown as CancelParams);
        break;
      case 'shutdown':
        handleShutdown(id);
        break;
      default:
        sendError(id, -32601, `Method not found: ${method}`);
    }
  }

  function start(): void {
    const rl = readline.createInterface({
      input: process.stdin,
      terminal: false,
    });

    let pendingRequests = 0;
    let closing = false;

    const maybeExit = () => {
      if (closing && pendingRequests === 0) {
        sessionManager.clear();
        process.exit(0);
      }
    };

    rl.on('line', async (line) => {
      if (!line.trim()) return;

      pendingRequests++;
      try {
        const request = JSON.parse(line) as JsonRpcRequest;
        await handleRequest(request);
      } catch (error) {
        sendError(null, -32700, 'Parse error');
      } finally {
        pendingRequests--;
        maybeExit();
      }
    });

    rl.on('close', () => {
      closing = true;
      maybeExit();
    });
  }

  return { start };
}
