import { describe, expect, test } from "bun:test";
import { loadProviders, saveProviders, DEFAULT_PROVIDERS } from "../src/providers";
import { anthropicToOpenAIPayload, openAIToAnthropicResponse } from "../src/openai_translator";

describe("Multi-Provider Registry", () => {
  test("loadProviders returns built-in provider defaults", () => {
    const providers = loadProviders();
    expect(providers.length).toBeGreaterThanOrEqual(3);
    const zcode = providers.find((p) => p.id === "zcode");
    expect(zcode).toBeDefined();
    expect(zcode?.baseUrl).toBe("https://zcode.z.ai/api/v1/zcode-plan/anthropic");
    expect(zcode?.type).toBe("anthropic");

    const opencode = providers.find((p) => p.id === "opencode");
    expect(opencode).toBeDefined();
    expect(opencode?.baseUrl).toBe("https://opencode.ai/zen/v1");
    expect(opencode?.type).toBe("openai");
  });
});

describe("OpenAI ↔ Anthropic Protocol Translator", () => {
  test("translates Anthropic request payload to OpenAI Chat Completions payload", () => {
    const anthropicInput = {
      model: "opencode-zen",
      system: "You are a helpful coding assistant.",
      messages: [{ role: "user" as const, content: "Hello world" }],
      max_tokens: 500,
      tools: [
        {
          name: "get_weather",
          description: "Get location weather",
          input_schema: { type: "object", properties: { location: { type: "string" } } },
        },
      ],
    };

    const openAiOutput = anthropicToOpenAIPayload(anthropicInput);
    expect(openAiOutput.model).toBe("opencode-zen");
    expect(openAiOutput.max_tokens).toBe(500);
    expect(openAiOutput.messages.length).toBe(2);
    expect(openAiOutput.messages[0]).toEqual({ role: "system", content: "You are a helpful coding assistant." });
    expect(openAiOutput.messages[1]).toEqual({ role: "user", content: "Hello world" });
    expect(openAiOutput.tools?.[0]?.function.name).toBe("get_weather");
  });

  test("translates OpenAI JSON response back to Anthropic Message response", () => {
    const openAiResponse = {
      id: "chatcmpl-12345",
      choices: [{ message: { content: "Hello from OpenAI compatible model!" } }],
      usage: { prompt_tokens: 10, completion_tokens: 20 },
    };

    const anthropicResponse = openAIToAnthropicResponse(openAiResponse, "opencode-zen");
    expect(anthropicResponse.id).toBe("chatcmpl-12345");
    expect(anthropicResponse.role).toBe("assistant");
    expect(anthropicResponse.model).toBe("opencode-zen");
    expect(anthropicResponse.content).toEqual([{ type: "text", text: "Hello from OpenAI compatible model!" }]);
  });
});
