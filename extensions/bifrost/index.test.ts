import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  capturePluginRegistration,
  createTestWizardPrompter,
  type WizardPrompter,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRuntimeSpies } from "../test-support/runtime-spies.js";
import plugin from "./index.js";
import { BIFROST_BASE_URL, BIFROST_DEFAULT_MODEL_ID } from "./onboard.js";

const discoveryMock = vi.hoisted(() => vi.fn());
const catalogMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/provider-setup", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/provider-setup")>();
  return { ...actual, discoverOpenAICompatibleLocalModels: discoveryMock };
});

vi.mock("openclaw/plugin-sdk/provider-catalog-live-runtime", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/provider-catalog-live-runtime")>();
  return { ...actual, buildOpenAICompatibleProviderCatalog: catalogMock };
});

const DISCOVERED_ROWS = [
  { model: { id: "openai/gpt-4o-mini" } },
  { model: { id: "anthropic/claude-sonnet-4-6" } },
];

function resetDiscovery() {
  discoveryMock.mockReset();
  discoveryMock.mockResolvedValue({
    kind: "success",
    health: "unknown",
    rows: DISCOVERED_ROWS,
    fetchedAt: Date.now(),
  });
}

function registerProvider() {
  const captured = capturePluginRegistration(plugin);
  const provider = captured.providers[0];
  expect(provider?.id).toBe("bifrost");
  return provider;
}

type PrompterAnswers = {
  baseUrl?: string;
  needsVirtualKey?: boolean;
  virtualKey?: string;
  selectedModel?: string;
  manualModelId?: string;
};

function createPrompter(answers: PrompterAnswers = {}): WizardPrompter {
  return createTestWizardPrompter({
    text: vi.fn(async (params: { message: string }) => {
      if (params.message.includes("base URL")) {
        return answers.baseUrl ?? "";
      }
      if (params.message.includes("virtual key")) {
        return answers.virtualKey ?? "";
      }
      return answers.manualModelId ?? "";
    }) as WizardPrompter["text"],
    confirm: vi.fn(async () => answers.needsVirtualKey ?? false) as WizardPrompter["confirm"],
    select: vi.fn(
      async () => answers.selectedModel ?? "openai/gpt-4o-mini",
    ) as WizardPrompter["select"],
  });
}

async function runInteractiveAuth(
  params: { config?: OpenClawConfig; prompter?: WizardPrompter } = {},
) {
  const auth = registerProvider()?.auth?.[0];
  return await auth?.run({
    config: params.config ?? {},
    opts: {},
    env: {},
    runtime: createRuntimeSpies(),
    prompter: params.prompter ?? createPrompter(),
    secretInputMode: "plaintext",
    isRemote: false,
    openUrl: async () => {
      throw new Error("Unexpected browser auth");
    },
    oauth: {
      createVpsAwareHandlers: () => {
        throw new Error("Unexpected OAuth");
      },
    },
  });
}

describe("bifrost plugin", () => {
  beforeEach(() => {
    resetDiscovery();
    catalogMock.mockReset();
  });

  it("records the gateway URL the operator enters", async () => {
    const result = await runInteractiveAuth({
      prompter: createPrompter({ baseUrl: "https://bifrost.example/openai//" }),
    });

    expect(result?.configPatch?.models?.providers?.bifrost?.baseUrl).toBe(
      "https://bifrost.example/openai",
    );
  });

  it("defaults to the documented gateway URL when the prompt is skipped", async () => {
    const result = await runInteractiveAuth();

    expect(result?.configPatch?.models?.providers?.bifrost?.baseUrl).toBe(BIFROST_BASE_URL);
  });

  it("seeds the gateway prompt with an already-configured URL", async () => {
    const prompter = createPrompter({ baseUrl: "https://bifrost.example/openai" });
    await runInteractiveAuth({
      config: {
        models: { providers: { bifrost: { baseUrl: "https://old.example/openai", models: [] } } },
      },
      prompter,
    });

    expect(prompter.text).toHaveBeenCalledWith(
      expect.objectContaining({ initialValue: "https://old.example/openai" }),
    );
  });

  it("hints the default URL instead of prefilling it so typed input does not append", async () => {
    const prompter = createPrompter({ baseUrl: "https://bifrost.example/openai" });
    await runInteractiveAuth({ prompter });

    expect(prompter.text).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Bifrost gateway base URL",
        placeholder: BIFROST_BASE_URL,
        initialValue: undefined,
      }),
    );
  });

  it.each([
    { answer: "not-a-url", expected: "Enter a full URL" },
    { answer: "ftp://bifrost.example", expected: "must start with http:// or https://" },
  ])("rejects $answer at the gateway prompt", async ({ answer, expected }) => {
    let validation: ((value: string) => string | undefined) | undefined;
    const prompter = createTestWizardPrompter({
      text: vi.fn(async (params: { validate?: (value: string) => string | undefined }) => {
        validation = params.validate;
        return "";
      }) as WizardPrompter["text"],
    });

    await runInteractiveAuth({ prompter });

    expect(validation?.(answer)).toContain(expected);
    expect(validation?.("")).toBeUndefined();
    expect(validation?.(BIFROST_BASE_URL)).toBeUndefined();
  });

  it("marks a gateway that needs no virtual key as anonymous instead of credentialed", async () => {
    const result = await runInteractiveAuth({
      prompter: createPrompter({ needsVirtualKey: false }),
    });
    const provider = result?.configPatch?.models?.providers?.bifrost;

    expect(provider?.auth).toBe("none");
    expect(provider).not.toHaveProperty("apiKey");
    expect(result?.profiles).toEqual([]);
  });

  it("stores a virtual key when the operator supplies one", async () => {
    const result = await runInteractiveAuth({
      prompter: createPrompter({ needsVirtualKey: true, virtualKey: "bf-vk-test" }),
    });
    const provider = result?.configPatch?.models?.providers?.bifrost;

    expect(provider?.auth).toBeUndefined();
    expect(result?.profiles).toHaveLength(1);
    expect(result?.profiles?.[0]?.profileId).toBe("bifrost:default");
  });

  it("clears a previous anonymous marker once the operator supplies a virtual key", async () => {
    const result = await runInteractiveAuth({
      config: {
        models: {
          providers: {
            bifrost: { baseUrl: "https://old.example/openai", auth: "none", models: [] },
          },
        },
      },
      prompter: createPrompter({ needsVirtualKey: true, virtualKey: "bf-vk-test" }),
    });
    const provider = result?.configPatch?.models?.providers?.bifrost;

    // resolveExplicitProviderNoAuth is terminal on auth:"none" and strips the
    // Authorization header, so an inherited marker would discard the saved key.
    expect(provider?.auth).not.toBe("none");
    expect(result?.profiles?.[0]?.profileId).toBe("bifrost:default");
  });

  it("discovers models from the configured gateway and selects the first", async () => {
    const result = await runInteractiveAuth({
      prompter: createPrompter({
        baseUrl: "http://127.0.0.1:8080/openai",
        selectedModel: "anthropic/claude-sonnet-4-6",
      }),
    });

    expect(discoveryMock).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ baseUrl: "http://127.0.0.1:8080/openai/v1", apiKey: undefined }),
    );
    expect(result?.defaultModel).toBe("bifrost/anthropic/claude-sonnet-4-6");
    expect(result?.configPatch?.models?.providers?.bifrost?.models).toEqual([
      expect.objectContaining({ id: "anthropic/claude-sonnet-4-6" }),
    ]);
  });

  it("offers a manual model ID when discovery reports an HTTP error", async () => {
    discoveryMock.mockResolvedValueOnce({ kind: "http-error", path: "/v1/models", status: 404 });

    const result = await runInteractiveAuth({
      prompter: createPrompter({ manualModelId: "ollama/llama3.1:8b" }),
    });

    expect(result?.defaultModel).toBe("bifrost/ollama/llama3.1:8b");
  });

  it("keeps a configured key when non-interactive setup only changes the URL", async () => {
    const config = {
      models: {
        providers: {
          bifrost: { baseUrl: "https://old.example/openai", apiKey: "existing-vk", models: [] },
        },
      },
    } satisfies OpenClawConfig;
    const result = await registerProvider()?.auth?.[0]?.runNonInteractive?.({
      authChoice: "bifrost-api-key",
      config,
      baseConfig: config,
      opts: { customBaseUrl: "https://new.example/openai" },
      runtime: createRuntimeSpies(),
      resolveApiKey: async () => ({ key: "existing-vk", source: "profile" as const }),
      toApiKeyCredential: () => null,
    });

    expect(result?.models?.providers?.bifrost).toMatchObject({
      baseUrl: "https://new.example/openai",
      apiKey: "existing-vk",
    });
    expect(result?.models?.providers?.bifrost?.auth).toBeUndefined();
  });

  it("stays credentialed when the key resolves from a profile rather than a flag", async () => {
    const config = {
      models: { providers: { bifrost: { baseUrl: "https://old.example/openai", models: [] } } },
    } satisfies OpenClawConfig;
    const result = await registerProvider()?.auth?.[0]?.runNonInteractive?.({
      authChoice: "bifrost-api-key",
      config,
      baseConfig: config,
      opts: { customBaseUrl: "https://new.example/openai" },
      runtime: createRuntimeSpies(),
      // No --bifrost-api-key and no inline apiKey, so inferring anonymity from those two
      // alone would mark this gateway auth:"none" and discard the resolved key.
      resolveApiKey: async () => ({ key: "profile-vk", source: "profile" as const }),
      toApiKeyCredential: () => null,
    });

    expect(result?.models?.providers?.bifrost?.auth).not.toBe("none");
    expect(result?.models?.providers?.bifrost?.baseUrl).toBe("https://new.example/openai");
  });

  it("clears a stale anonymous marker when the URL flag is omitted", async () => {
    const config = {
      models: {
        providers: {
          bifrost: { baseUrl: "https://old.example/openai", auth: "none", models: [] },
        },
      },
    } satisfies OpenClawConfig;
    const result = await registerProvider()?.auth?.[0]?.runNonInteractive?.({
      authChoice: "bifrost-api-key",
      config,
      baseConfig: config,
      // No --custom-base-url: the gateway is already on file, and this path still has to
      // clear the anonymous marker or the delegate's preset preserves it.
      opts: {},
      runtime: createRuntimeSpies(),
      resolveApiKey: async () => ({ key: "flag-vk", source: "profile" as const }),
      toApiKeyCredential: () => null,
    });

    expect(result?.models?.providers?.bifrost?.auth).not.toBe("none");
    expect(result?.models?.providers?.bifrost?.baseUrl).toBe("https://old.example/openai");
  });

  it("keeps the provider row canonical when the config used different casing", async () => {
    const result = await runInteractiveAuth({
      config: {
        models: {
          providers: {
            Bifrost: {
              baseUrl: "https://old.example/openai",
              api: "openai-completions",
              request: { allowPrivateNetwork: true },
              models: [
                {
                  id: "custom-model",
                  name: "Custom",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 1000,
                  maxTokens: 100,
                },
              ],
            },
          },
        },
      },
      prompter: createPrompter({
        baseUrl: "https://old.example/openai",
        selectedModel: "custom-model",
      }),
    });
    const provider = result?.configPatch?.models?.providers?.bifrost;

    expect(provider?.baseUrl).toBe("https://old.example/openai");
    expect(provider?.request).toEqual({ allowPrivateNetwork: true });
  });

  it("keeps the documented default model available for replace mode", async () => {
    const result = await runInteractiveAuth({
      config: { models: { mode: "replace" } },
      prompter: createPrompter({ selectedModel: BIFROST_DEFAULT_MODEL_ID }),
    });

    expect(result?.defaultModel).toBe(`bifrost/${BIFROST_DEFAULT_MODEL_ID}`);
    expect(result?.configPatch?.models?.providers?.bifrost?.models).toEqual([
      expect.objectContaining({ id: BIFROST_DEFAULT_MODEL_ID }),
    ]);
  });
});

describe("bifrost provider registration", () => {
  beforeEach(() => {
    resetDiscovery();
    catalogMock.mockReset();
  });

  it("registers the plugin as a bundled models provider", () => {
    const provider = registerProvider();

    expect(provider?.docsPath).toBe("/providers/bifrost");
    expect(provider?.envVars).toEqual(["BIFROST_VIRTUAL_KEY"]);
    expect(provider?.staticCatalog?.order).toBe("simple");
  });

  it.each([
    { baseUrl: "http://127.0.0.1:8080/openai", endpointPath: "v1/models" },
    { baseUrl: "http://127.0.0.1:8080/openai/v1", endpointPath: "models" },
  ])("joins the version segment once for $baseUrl", async ({ baseUrl, endpointPath }) => {
    const catalog = { provider: { id: "bifrost" } };
    catalogMock.mockReturnValue(catalog);
    const provider = registerProvider();

    const result = await provider?.catalog?.run?.({
      config: { models: { providers: { bifrost: { baseUrl, models: [] } } } },
      env: {},
      resolveProviderApiKey: () => ({ apiKey: undefined }),
      resolveProviderAuth: () => ({ apiKey: undefined, mode: "none", source: "none" }),
    });

    expect(catalogMock).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        providerId: "bifrost",
        allowExplicitBaseUrl: true,
        modelDiscovery: { endpointPath },
      }),
    );
    expect(result).toBe(catalog);
  });
});
