import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { buildBifrostModelDefinition, BIFROST_BASE_URL } from "./onboard.js";

export function buildBifrostProvider(): ModelProviderConfig {
  return {
    baseUrl: BIFROST_BASE_URL,
    api: "openai-completions",
    models: [buildBifrostModelDefinition()],
  };
}
