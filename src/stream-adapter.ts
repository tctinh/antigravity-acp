import type {
  SessionUpdate,
  AgentMessageChunk,
  AgentThoughtChunk,
  ToolCall,
  SessionComplete,
  SessionError,
  AcpTool,
  SessionUpdateNotification,
} from './types/acp.js';
import type { AntigravityStreamEvent, FunctionCall } from './types/antigravity.js';

export interface StreamAdapterOptions {
  sessionId: string;
  tools?: AcpTool[];
}

export function createStreamAdapter(sessionId: string, tools: AcpTool[] = []) {
  let messageIndex = 0;
  let accumulatedText = '';
  let currentToolCallId: string | null = null;
  const toolNameToAcpTool = new Map(tools.map((t) => [t.name, t]));

  function processEvent(event: AntigravityStreamEvent): SessionUpdateNotification[] {
    const notifications: SessionUpdateNotification[] = [];
    const candidates = event.response?.candidates;

    if (!candidates?.length) {
      return notifications;
    }

    for (const candidate of candidates) {
      const parts = candidate.content?.parts;
      if (!parts?.length) continue;

      for (const part of parts) {
        if ('thought' in part && part.thought) {
          notifications.push(createNotification(createThoughtChunk(part.text || '')));
        } else if ('text' in part && part.text && !('thought' in part)) {
          accumulatedText += part.text;
          notifications.push(createNotification(createMessageChunk(part.text)));
        } else if ('functionCall' in part && part.functionCall) {
          notifications.push(createNotification(createToolCall(part.functionCall)));
        }
      }

      if (candidate.finishReason === 'STOP') {
        notifications.push(createNotification(createSessionComplete('end_turn')));
      } else if (candidate.finishReason === 'TOOL_USE') {
        notifications.push(createNotification(createSessionComplete('tool_use')));
      } else if (candidate.finishReason === 'SAFETY') {
        notifications.push(
          createNotification(createSessionError('Content blocked by safety filters', 'SAFETY_BLOCK'))
        );
      } else if (candidate.finishReason === 'MAX_TOKENS') {
        notifications.push(createNotification(createSessionComplete('max_tokens')));
      }
    }

    return notifications;
  }

  function createNotification(update: SessionUpdate['update']): SessionUpdateNotification {
    return {
      jsonrpc: '2.0',
      method: 'sessionUpdate',
      params: { sessionId, update },
    };
  }

  function createMessageChunk(text: string): AgentMessageChunk {
    return {
      type: 'agent_message_chunk',
      kind: 'message',
      messageId: `msg_${sessionId}_${messageIndex}`,
      index: messageIndex++,
      chunk: text,
    };
  }

  function createThoughtChunk(text: string): AgentThoughtChunk {
    return {
      type: 'agent_thought_chunk',
      kind: 'thought',
      thoughtId: `thought_${sessionId}_${messageIndex}`,
      index: messageIndex++,
      chunk: text,
    };
  }

  function createToolCall(functionCall: FunctionCall): ToolCall {
    currentToolCallId = functionCall.id || `call_${sessionId}_${Date.now()}`;
    const acpTool = toolNameToAcpTool.get(functionCall.name);

    return {
      type: 'tool_call',
      kind: 'tool_call',
      callId: currentToolCallId,
      tool: acpTool || {
        name: functionCall.name,
        description: '',
        inputSchema: { type: 'object', properties: {} },
      },
      input: functionCall.args || {},
    };
  }

  function createSessionComplete(reason: SessionComplete['reason']): SessionComplete {
    return {
      type: 'session_complete',
      kind: 'finish',
      reason,
    };
  }

  function createSessionError(message: string, code: string): SessionError {
    return {
      type: 'session_error',
      kind: 'error',
      error: { code, message },
    };
  }

  function getAccumulatedText(): string {
    return accumulatedText;
  }

  function getCurrentToolCallId(): string | null {
    return currentToolCallId;
  }

  function reset(): void {
    accumulatedText = '';
    currentToolCallId = null;
    messageIndex = 0;
  }

  return {
    processEvent,
    getAccumulatedText,
    getCurrentToolCallId,
    reset,
  };
}

export type StreamAdapter = ReturnType<typeof createStreamAdapter>;
