/**
 * Unit tests for the free-model logic in src/models.ts.
 *
 *   bun test
 */
import { describe, expect, test } from "bun:test";
import {
  fallbackModelCandidates,
  gatewayIdFor,
  isFreeModel,
  needsGatewayId,
  pickerOrder,
  realIdForGateway,
  resolveFreeModel,
  type OpenRouterModel,
} from "../src/models";

const FREE = [
  "anthropic/claude-3.5-haiku:free",
  "anthropic/claude-3.5-sonnet:free",
  "google/gemini-2.0-flash-exp:free",
  "meta-llama/llama-3.3-70b-instruct:free",
];

describe("isFreeModel", () => {
  test("recognizes :free suffix", () => {
    expect(isFreeModel({ id: "anthropic/claude-3.5-haiku:free" })).toBe(true);
    expect(isFreeModel({ id: "anthropic/claude-sonnet-4.5" })).toBe(false);
  });

  test("recognizes zero pricing", () => {
    expect(isFreeModel({ id: "x/y", pricing: { prompt: "0", completion: "0" } })).toBe(true);
    expect(isFreeModel({ id: "x/y", pricing: { prompt: "0.1", completion: "0" } })).toBe(false);
    expect(isFreeModel({ id: "x/y", pricing: { prompt: "0", completion: "1" } })).toBe(false);
    expect(isFreeModel({ id: "x/y", pricing: { prompt: "0.000001", completion: "0" } })).toBe(false);
  });
});

describe("pickerOrder", () => {
  test("puts anthropic free models first, then alphabetical", () => {
    const ordered = pickerOrder([
      { id: "meta-llama/llama-3.3-70b-instruct:free" },
      { id: "anthropic/claude-3.5-sonnet:free" },
      { id: "anthropic/claude-3.5-haiku:free" },
    ]).map((m) => m.id);
    expect(ordered[0]).toBe("anthropic/claude-3.5-haiku:free");
    expect(ordered[1]).toBe("anthropic/claude-3.5-sonnet:free");
    expect(ordered[2]).toBe("meta-llama/llama-3.3-70b-instruct:free");
  });
});

describe("gateway aliases (Claude Code's /model picker filter)", () => {
  test("claude/anthropic ids pass through unchanged", () => {
    expect(needsGatewayId("anthropic/claude-3.5-sonnet:free")).toBe(false);
    expect(gatewayIdFor("anthropic/claude-3.5-sonnet:free")).toBe("anthropic/claude-3.5-sonnet:free");
    expect(needsGatewayId("some-vendor/anthropic-2")).toBe(false);
  });

  test("non-claude ids get a reversible gateway alias that passes the picker filter", () => {
    const real = "cohere/north-mini-code:free";
    const alias = gatewayIdFor(real);
    expect(alias).not.toBe(real);
    expect(alias.startsWith("anthropic/claude-route-")).toBe(true);
    expect(/(claude|anthropic)/i.test(alias)).toBe(true);
    expect(realIdForGateway(alias)).toBe(real);
  });

  test("aliases round-trip for ids with slashes, dots and colons", () => {
    for (const id of ["deepseek/deepseek-chat-v3:free", "nvidia/nemotron-3.5-lightning:free", "liquid/lfm-2.5-2.6b:free"]) {
      expect(realIdForGateway(gatewayIdFor(id))).toBe(id);
    }
  });

  test("realIdForGateway is identity for non-alias ids and malformed aliases", () => {
    expect(realIdForGateway("cohere/north-mini-code:free")).toBe("cohere/north-mini-code:free");
    expect(realIdForGateway("anthropic/claude-route-")).toBe("anthropic/claude-route-");
  });
});

describe("fallbackModelCandidates", () => {
  const FREE = ["test/model-one:free", "test/model-two:free", "cohere/north-mini-code:free"];

  test("resolved model first, then default, then the rest of the free list, deduped", () => {
    expect(fallbackModelCandidates("test/model-two:free", FREE, "test/model-one:free")).toEqual([
      "test/model-two:free",
      "test/model-one:free",
      "cohere/north-mini-code:free",
    ]);
  });

  test("does not duplicate the resolved model when it equals the default or first free", () => {
    expect(fallbackModelCandidates("test/model-one:free", FREE, "test/model-one:free")).toEqual([
      "test/model-one:free",
      "test/model-two:free",
      "cohere/north-mini-code:free",
    ]);
  });

  test("respects the limit", () => {
    expect(fallbackModelCandidates("test/model-two:free", FREE, null, 1)).toEqual(["test/model-two:free"]);
  });

  test("no default means just the free list after the resolved model", () => {
    expect(fallbackModelCandidates("test/model-two:free", FREE, null)).toEqual([
      "test/model-two:free",
      "test/model-one:free",
      "cohere/north-mini-code:free",
    ]);
  });
});

describe("resolveFreeModel", () => {
  test("returns null when there are no free models", () => {
    expect(resolveFreeModel("anything", [], null)).toBeNull();
  });

  test("passes through a requested free model unchanged", () => {
    expect(resolveFreeModel("anthropic/claude-3.5-haiku:free", FREE, null)).toBe("anthropic/claude-3.5-haiku:free");
  });

  test("uses the default override when the request is not free", () => {
    expect(resolveFreeModel("claude-sonnet-4-5", FREE, "google/gemini-2.0-flash-exp:free")).toBe(
      "google/gemini-2.0-flash-exp:free",
    );
  });

  test("maps claude-sonnet-* to a free sonnet model", () => {
    expect(resolveFreeModel("claude-sonnet-4-5", FREE, null)).toBe("anthropic/claude-3.5-sonnet:free");
  });

  test("maps claude-haiku-* to a free haiku model", () => {
    expect(resolveFreeModel("claude-haiku-4-5", FREE, null)).toBe("anthropic/claude-3.5-haiku:free");
  });

  test("falls back to the first free model for unknown requests", () => {
    expect(resolveFreeModel("gpt-5", FREE, null)).toBe(FREE[0]);
  });

  test("uses the first free model when no model is requested", () => {
    expect(resolveFreeModel(null, FREE, null)).toBe(FREE[0]);
    expect(resolveFreeModel(null, FREE, "anthropic/claude-3.5-sonnet:free")).toBe(
      "anthropic/claude-3.5-sonnet:free",
    );
  });
});
