import type { Content, FunctionCall, FunctionResponse } from './types/antigravity.js';
import type { AcpTool, SessionConfig } from './types/acp.js';

export interface SessionState {
  id: string;
  model: string;
  systemInstruction?: string;
  tools: AcpTool[];
  contents: Content[];
  createdAt: number;
  abortController: AbortController | null;
}

export interface SessionManagerOptions {
  defaultModel?: string;
}

const DEFAULT_MODEL = 'gemini-2.0-flash';

export function createSessionManager(options: SessionManagerOptions = {}) {
  const sessions = new Map<string, SessionState>();
  const defaultModel = options.defaultModel || DEFAULT_MODEL;

  function createSession(config?: SessionConfig): SessionState {
    const id = `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const session: SessionState = {
      id,
      model: config?.model || defaultModel,
      systemInstruction: config?.systemInstruction || config?.systemPrompt,
      tools: config?.tools || [],
      contents: [],
      createdAt: Date.now(),
      abortController: null,
    };
    sessions.set(id, session);
    return session;
  }

  function getSession(sessionId: string): SessionState | undefined {
    return sessions.get(sessionId);
  }

  function deleteSession(sessionId: string): boolean {
    const session = sessions.get(sessionId);
    if (session?.abortController) {
      session.abortController.abort();
    }
    return sessions.delete(sessionId);
  }

  function addUserMessage(sessionId: string, text: string): void {
    const session = sessions.get(sessionId);
    if (!session) return;

    const userContent: Content = {
      role: 'user',
      parts: [{ text }],
    };
    session.contents.push(userContent);
  }

  function addAssistantMessage(sessionId: string, text: string): void {
    const session = sessions.get(sessionId);
    if (!session) return;

    const lastContent = session.contents[session.contents.length - 1];
    if (lastContent?.role === 'model') {
      const textPart = lastContent.parts.find(
        (p): p is { text: string } => 'text' in p && !('thought' in p)
      );
      if (textPart) {
        textPart.text += text;
        return;
      }
    }

    const assistantContent: Content = {
      role: 'model',
      parts: [{ text }],
    };
    session.contents.push(assistantContent);
  }

  function addToolCall(sessionId: string, functionCall: FunctionCall): void {
    const session = sessions.get(sessionId);
    if (!session) return;

    const lastContent = session.contents[session.contents.length - 1];
    if (lastContent?.role === 'model') {
      lastContent.parts.push({ functionCall });
    } else {
      const assistantContent: Content = {
        role: 'model',
        parts: [{ functionCall }],
      };
      session.contents.push(assistantContent);
    }
  }

  function addToolResult(
    sessionId: string,
    callId: string,
    name: string,
    result: unknown
  ): void {
    const session = sessions.get(sessionId);
    if (!session) return;

    const functionResponse: FunctionResponse = {
      name,
      response: typeof result === 'string' ? { output: result } : (result as Record<string, unknown>),
      id: callId,
    };

    const toolResultContent: Content = {
      role: 'user',
      parts: [{ functionResponse }],
    };
    session.contents.push(toolResultContent);
  }

  function setAbortController(sessionId: string, controller: AbortController | null): void {
    const session = sessions.get(sessionId);
    if (session) {
      session.abortController = controller;
    }
  }

  function cancelSession(sessionId: string): boolean {
    const session = sessions.get(sessionId);
    if (session?.abortController) {
      session.abortController.abort();
      session.abortController = null;
      return true;
    }
    return false;
  }

  function getContents(sessionId: string): Content[] {
    return sessions.get(sessionId)?.contents || [];
  }

  function clear(): void {
    for (const session of sessions.values()) {
      if (session.abortController) {
        session.abortController.abort();
      }
    }
    sessions.clear();
  }

  return {
    createSession,
    getSession,
    deleteSession,
    addUserMessage,
    addAssistantMessage,
    addToolCall,
    addToolResult,
    setAbortController,
    cancelSession,
    getContents,
    clear,
  };
}

export type SessionManager = ReturnType<typeof createSessionManager>;
