/**
 * OpenAI ↔ Anthropic Protocol Adapter
 *
 * Converts Anthropic /v1/messages request payloads into OpenAI /v1/chat/completions shapes
 * and adapts OpenAI JSON & SSE stream responses back to standard Anthropic messages format.
 */

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | Array<{ type: string; text?: string; [key: string]: unknown }>;
}

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
}

export interface AnthropicPayload {
  model: string;
  messages: AnthropicMessage[];
  system?: string | Array<{ type: string; text?: string }>;
  max_tokens?: number;
  temperature?: number;
  tools?: AnthropicTool[];
  stream?: boolean;
  [key: string]: unknown;
}

export interface OpenAIMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface OpenAIPayload {
  model: string;
  messages: OpenAIMessage[];
  max_tokens?: number;
  temperature?: number;
  tools?: OpenAITool[];
  stream?: boolean;
}

/** Convert Anthropic Messages request body to OpenAI Chat Completions body. */
export function anthropicToOpenAIPayload(payload: AnthropicPayload): OpenAIPayload {
  const openAiMessages: OpenAIMessage[] = [];

  // Extract system prompt
  if (payload.system) {
    let systemText = "";
    if (typeof payload.system === "string") {
      systemText = payload.system;
    } else if (Array.isArray(payload.system)) {
      systemText = payload.system
        .map((s) => (typeof s === "string" ? s : s.text || ""))
        .filter(Boolean)
        .join("\n");
    }
    if (systemText) {
      openAiMessages.push({ role: "system", content: systemText });
    }
  }

  // Convert turns
  if (Array.isArray(payload.messages)) {
    for (const msg of payload.messages) {
      let contentStr = "";
      if (typeof msg.content === "string") {
        contentStr = msg.content;
      } else if (Array.isArray(msg.content)) {
        contentStr = msg.content
          .map((c) => (typeof c === "string" ? c : c.text || ""))
          .filter(Boolean)
          .join("\n");
      }
      openAiMessages.push({
        role: msg.role === "assistant" ? "assistant" : "user",
        content: contentStr,
      });
    }
  }

  const out: OpenAIPayload = {
    model: payload.model,
    messages: openAiMessages,
    stream: payload.stream,
  };

  if (typeof payload.max_tokens === "number") out.max_tokens = payload.max_tokens;
  if (typeof payload.temperature === "number") out.temperature = payload.temperature;

  // Convert tool schemas if present
  if (Array.isArray(payload.tools) && payload.tools.length > 0) {
    out.tools = payload.tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema || { type: "object", properties: {} },
      },
    }));
  }

  return out;
}

/** Convert an OpenAI non-streaming JSON response to Anthropic Message Response JSON. */
export function openAIToAnthropicResponse(openAiResp: unknown, requestedModel: string): Record<string, unknown> {
  const resp = openAiResp as {
    id?: string;
    choices?: Array<{
      finish_reason?: string;
      message?: {
        content?: string;
        reasoning_content?: string;
        text?: string;
        tool_calls?: Array<{
          id?: string;
          function?: { name?: string; arguments?: string };
        }>;
      };
    }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };

  const choice = resp?.choices?.[0];
  const msg = choice?.message;
  let choiceContent = msg?.content || msg?.reasoning_content || msg?.text || "";
  const id = resp?.id || `msg_${Math.random().toString(36).slice(2, 12)}`;

  const contentBlocks: Array<Record<string, unknown>> = [];
  if (choiceContent) {
    contentBlocks.push({ type: "text", text: choiceContent });
  }

  let stopReason = "end_turn";
  if (Array.isArray(msg?.tool_calls) && msg.tool_calls.length > 0) {
    stopReason = "tool_use";
    for (const tc of msg.tool_calls) {
      let inputObj = {};
      try {
        if (tc.function?.arguments) inputObj = JSON.parse(tc.function.arguments);
      } catch {}
      contentBlocks.push({
        type: "tool_use",
        id: tc.id || `toolu_${Math.random().toString(36).slice(2, 12)}`,
        name: tc.function?.name || "tool",
        input: inputObj,
      });
    }
  }

  if (choice?.finish_reason === "length") stopReason = "max_tokens";

  return {
    id,
    type: "message",
    role: "assistant",
    model: requestedModel,
    content: contentBlocks,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: resp?.usage?.prompt_tokens || 0,
      output_tokens: resp?.usage?.completion_tokens || 0,
    },
  };
}

/** Transform an OpenAI SSE stream into an Anthropic SSE stream with full tool call translation. */
export function transformOpenAiSSEToAnthropic(
  openAiStream: ReadableStream<Uint8Array>,
  model: string,
): ReadableStream<Uint8Array> {
  const reader = openAiStream.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let messageStarted = false;
  let textBlockStarted = false;
  const msgId = `msg_${Math.random().toString(36).slice(2, 12)}`;

  // Track active tool call state: openAiToolIndex -> { anthropicIndex, id, name }
  const toolCallState = new Map<number, { anthropicIndex: number; id: string; name: string }>();
  let nextAnthropicBlockIndex = 0;
  let lastFinishReason: string | null = null;

  return new ReadableStream({
    async start(controller) {
      function sendAnthropicEvent(event: string, data: unknown) {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      }

      function ensureMessageStarted() {
        if (!messageStarted) {
          messageStarted = true;
          sendAnthropicEvent("message_start", {
            type: "message_start",
            message: {
              id: msgId,
              type: "message",
              role: "assistant",
              model,
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 0, output_tokens: 0 },
            },
          });
        }
      }

      function ensureTextBlockStarted() {
        ensureMessageStarted();
        if (!textBlockStarted) {
          textBlockStarted = true;
          const index = nextAnthropicBlockIndex++;
          sendAnthropicEvent("content_block_start", {
            type: "content_block_start",
            index,
            content_block: { type: "text", text: "" },
          });
        }
      }

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const dataStr = trimmed.slice(5).trim();
            if (dataStr === "[DONE]") continue;

            try {
              const parsed = JSON.parse(dataStr);
              const choice = parsed.choices?.[0];
              if (!choice) continue;

              if (choice.finish_reason) {
                lastFinishReason = choice.finish_reason;
              }

              const deltaObj = choice.delta;
              if (!deltaObj) continue;

              const deltaContent = deltaObj.content ?? deltaObj.reasoning_content ?? deltaObj.text;

              // 1. Text content delta
              if (deltaContent) {
                ensureTextBlockStarted();
                sendAnthropicEvent("content_block_delta", {
                  type: "content_block_delta",
                  index: 0,
                  delta: { type: "text_delta", text: deltaContent },
                });
              }

              // 2. Tool calls delta
              if (Array.isArray(deltaObj.tool_calls)) {
                ensureMessageStarted();

                for (const tc of deltaObj.tool_calls) {
                  const openAiIdx = tc.index ?? 0;
                  let state = toolCallState.get(openAiIdx);

                  if (!state) {
                    const anthropicIdx = nextAnthropicBlockIndex++;
                    const toolId = tc.id || `toolu_${Math.random().toString(36).slice(2, 12)}`;
                    const toolName = tc.function?.name || "tool";
                    state = { anthropicIndex: anthropicIdx, id: toolId, name: toolName };
                    toolCallState.set(openAiIdx, state);

                    sendAnthropicEvent("content_block_start", {
                      type: "content_block_start",
                      index: anthropicIdx,
                      content_block: {
                        type: "tool_use",
                        id: state.id,
                        name: state.name,
                        input: {},
                      },
                    });
                  }

                  const argsChunk = tc.function?.arguments;
                  if (argsChunk) {
                    sendAnthropicEvent("content_block_delta", {
                      type: "content_block_delta",
                      index: state.anthropicIndex,
                      delta: {
                        type: "input_json_delta",
                        partial_json: argsChunk,
                      },
                    });
                  }
                }
              }
            } catch {
              /* ignore parse errors on SSE line */
            }
          }
        }

        if (messageStarted) {
          if (textBlockStarted) {
            sendAnthropicEvent("content_block_stop", { type: "content_block_stop", index: 0 });
          }

          for (const state of toolCallState.values()) {
            sendAnthropicEvent("content_block_stop", {
              type: "content_block_stop",
              index: state.anthropicIndex,
            });
          }

          const hasTools = toolCallState.size > 0;
          let stopReason = "end_turn";
          if (hasTools || lastFinishReason === "tool_calls") {
            stopReason = "tool_use";
          } else if (lastFinishReason === "length") {
            stopReason = "max_tokens";
          }

          sendAnthropicEvent("message_delta", {
            type: "message_delta",
            delta: { stop_reason: stopReason, stop_sequence: null },
            usage: { output_tokens: 0 },
          });
          sendAnthropicEvent("message_stop", { type: "message_stop" });
        }
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });
}
