import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { applyProviderAuthConfigPatch } from "openclaw/plugin-sdk/provider-auth";
import {
  buildOpenAICompatibleLiveModels,
  LiveModelCatalogHttpError,
} from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { resolveMergedModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-shared";
import { discoverOpenAICompatibleLocalModels } from "openclaw/plugin-sdk/provider-setup";
import { BIFROST_BASE_URL, normalizeBifrostBaseUrl } from "./defaults.js";
import { buildBifrostConnectionConfig } from "./onboard.js";

export async function listBifrostModels(params: {
  config: OpenClawConfig;
  apiKey?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  beforeRequest?: () => void;
}) {
  const source = resolveMergedModelProviderConfig(params.config, "bifrost");
  const baseUrl = normalizeBifrostBaseUrl(source?.baseUrl ?? BIFROST_BASE_URL);
  const config =
    source?.auth === "none"
      ? applyProviderAuthConfigPatch(
          params.config,
          buildBifrostConnectionConfig(params.config, baseUrl, true),
        )
      : params.config;
  const configured = resolveMergedModelProviderConfig(config, "bifrost");
  const provider = {
    ...configured,
    baseUrl,
    api: "openai-completions" as const,
    models: configured?.models ?? [],
  };
  const result = await discoverOpenAICompatibleLocalModels({
    baseUrl: provider.baseUrl,
    apiKey: configured?.auth === "none" ? undefined : params.apiKey,
    configuredProvider: { config, id: "bifrost" },
    env: params.env,
    signal: params.signal,
    beforeRequest: params.beforeRequest,
    label: "Bifrost",
    rawResult: true,
    discoverRuntimeContext: false,
  });
  params.signal?.throwIfAborted();
  params.beforeRequest?.();
  if (result.kind !== "success") {
    throw result.kind === "http-error"
      ? new LiveModelCatalogHttpError("bifrost", result.status)
      : new Error("Bifrost model discovery unavailable. Check the gateway URL and authentication.");
  }
  return {
    ...provider,
    models: buildOpenAICompatibleLiveModels(
      result.rows.map(({ model }) => model),
      provider,
    ),
  };
}
