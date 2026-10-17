import { resolveMergedModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-shared";
import {
  applyProviderConfigWithDefaultModelsPreset,
  createDefaultModelsPresetAppliers,
  type ModelDefinitionConfig,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";

/** Bifrost's OpenAI-compatible surface; the gateway serves chat completions under `/v1` beneath it. */
export const BIFROST_BASE_URL = "http://localhost:8080/openai";
/** Bifrost advertises provider-qualified IDs such as `openai/gpt-4o-mini`. */
export const BIFROST_DEFAULT_MODEL_ID = "openai/gpt-4o-mini";
export const BIFROST_DEFAULT_MODEL_REF = `bifrost/${BIFROST_DEFAULT_MODEL_ID}`;
const BIFROST_DEFAULT_CONTEXT_WINDOW = 128_000;
const BIFROST_DEFAULT_MAX_TOKENS = 16_384;
const BIFROST_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

export function buildBifrostModelDefinition(): ModelDefinitionConfig {
  return {
    id: BIFROST_DEFAULT_MODEL_ID,
    name: "GPT-4o mini",
    reasoning: false,
    input: ["text", "image"],
    cost: BIFROST_DEFAULT_COST,
    contextWindow: BIFROST_DEFAULT_CONTEXT_WINDOW,
    maxTokens: BIFROST_DEFAULT_MAX_TOKENS,
  };
}

export async function applyBifrostModelConfig(
  cfg: OpenClawConfig,
  modelId: string,
): Promise<OpenClawConfig> {
  const {
    SELF_HOSTED_DEFAULT_CONTEXT_WINDOW,
    SELF_HOSTED_DEFAULT_COST,
    SELF_HOSTED_DEFAULT_MAX_TOKENS,
  } = await import("openclaw/plugin-sdk/provider-setup");
  const modelRef = `bifrost/${modelId}`;
  return applyProviderConfigWithDefaultModelsPreset(cfg, {
    providerId: "bifrost",
    api: "openai-completions",
    baseUrl: resolveMergedModelProviderConfig(cfg, "bifrost")?.baseUrl?.trim() || BIFROST_BASE_URL,
    defaultModels: [
      modelId === BIFROST_DEFAULT_MODEL_ID
        ? buildBifrostModelDefinition()
        : {
            id: modelId,
            name: modelId,
            reasoning: false,
            input: ["text"],
            cost: SELF_HOSTED_DEFAULT_COST,
            contextWindow: SELF_HOSTED_DEFAULT_CONTEXT_WINDOW,
            maxTokens: SELF_HOSTED_DEFAULT_MAX_TOKENS,
          },
    ],
    aliases: [{ modelRef, alias: "Bifrost" }],
    primaryModelRef: modelRef,
  });
}

export const { applyConfig: applyBifrostConfig, applyProviderConfig: applyBifrostProviderConfig } =
  createDefaultModelsPresetAppliers<[]>({
    primaryModelRef: BIFROST_DEFAULT_MODEL_REF,
    resolveParams: (cfg: OpenClawConfig) => {
      const resolvedBaseUrl =
        resolveMergedModelProviderConfig(cfg, "bifrost")?.baseUrl?.trim() ?? "";

      return {
        providerId: "bifrost",
        api: "openai-completions" as const,
        baseUrl: resolvedBaseUrl || BIFROST_BASE_URL,
        // Replace mode disables discovery, so it still needs the configured default.
        defaultModels:
          resolvedBaseUrl && cfg.models?.mode !== "replace" ? [] : [buildBifrostModelDefinition()],
        defaultModelId: BIFROST_DEFAULT_MODEL_ID,
        aliases: [{ modelRef: BIFROST_DEFAULT_MODEL_REF, alias: "Bifrost" }],
      };
    },
  });
