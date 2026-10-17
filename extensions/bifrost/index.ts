import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  definePluginEntry,
  type OpenClawPluginApi,
  type ProviderAuthContext,
  type ProviderAuthMethodNonInteractiveContext,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  findNormalizedProviderValue,
  normalizeOptionalSecretInput,
} from "openclaw/plugin-sdk/provider-auth";
import {
  buildApiKeyCredential,
  captureProviderApiKey,
} from "openclaw/plugin-sdk/provider-auth-api-key";
import { buildOpenAICompatibleProviderCatalog } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { resolveMergedModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-shared";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-entry";
import {
  applyBifrostConfig,
  applyBifrostModelConfig,
  BIFROST_BASE_URL,
  BIFROST_DEFAULT_MODEL_REF,
} from "./onboard.js";
import { buildBifrostProvider } from "./provider-catalog.js";

const PROVIDER_ID = "bifrost";

/**
 * Records the gateway URL plus how it authenticates. A gateway reached without a
 * virtual key is marked `auth: "none"` so the resolver stops hunting for a
 * credential that this deployment never had.
 */
function applyBifrostConnection(
  cfg: OpenClawConfig,
  baseUrl: string,
  opts: { anonymous: boolean },
): OpenClawConfig {
  const existing = resolveMergedModelProviderConfig(cfg, PROVIDER_ID);
  return {
    ...cfg,
    models: {
      ...cfg.models,
      providers: {
        ...cfg.models?.providers,
        [PROVIDER_ID]: {
          ...existing,
          baseUrl,
          // Auth intent is written in both directions. resolveExplicitProviderNoAuth
          // treats auth:"none" as terminal and strips Authorization, so re-running setup
          // against a gateway that now has a key must clear the marker rather than
          // inherit it through the merge above.
          ...(opts.anonymous ? { auth: "none" as const, apiKey: undefined } : { auth: undefined }),
          models: existing?.models ?? [],
        },
      },
    },
  };
}

function validateProxyBaseUrl(value: string): string | undefined {
  const candidate = value.trim();
  if (!candidate) {
    return undefined;
  }
  if (!URL.canParse(candidate)) {
    return `Enter a full URL, such as ${BIFROST_BASE_URL}`;
  }
  const { protocol } = new URL(candidate);
  return protocol === "http:" || protocol === "https:"
    ? undefined
    : "The Bifrost gateway URL must start with http:// or https://";
}

async function promptBifrostBaseUrl(ctx: ProviderAuthContext): Promise<string> {
  const configured =
    resolveMergedModelProviderConfig(ctx.config, PROVIDER_ID)?.baseUrl?.trim() ?? "";
  const answer = await ctx.prompter.text({
    message: "Bifrost gateway base URL",
    // Prefilling the default would make typed input append to it; hint it instead and
    // only prefill when there is a real value the operator may want to edit.
    initialValue: configured || undefined,
    placeholder: BIFROST_BASE_URL,
    validate: validateProxyBaseUrl,
  });
  return (answer.trim() || configured || BIFROST_BASE_URL).replace(/\/+$/, "");
}

/** Bifrost only needs a credential when the operator enabled auth or virtual-key governance. */
async function promptBifrostVirtualKey(ctx: ProviderAuthContext) {
  const configured = Boolean(
    normalizeOptionalSecretInput(ctx.opts?.bifrostApiKey ?? ctx.opts?.token),
  );
  const wantsVirtualKey = configured
    ? true
    : await ctx.prompter.confirm({
        message: "Does this Bifrost gateway require a virtual key?",
        initialValue: false,
      });
  if (!wantsVirtualKey) {
    return null;
  }
  return await captureProviderApiKey(ctx, {
    provider: PROVIDER_ID,
    expectedProviders: [PROVIDER_ID],
    envLabel: "BIFROST_VIRTUAL_KEY",
    promptMessage: "Enter Bifrost virtual key",
    noteTitle: "Bifrost",
    noteMessage: [
      "Bifrost routes 20+ LLM providers through one OpenAI-compatible gateway.",
      "A virtual key is only needed when the gateway enforces auth or governance.",
      "The default gateway runs on http://localhost:8080",
    ].join("\n"),
    token: normalizeOptionalSecretInput(ctx.opts?.bifrostApiKey ?? ctx.opts?.token),
    tokenProvider: normalizeOptionalSecretInput(ctx.opts?.tokenProvider),
    env: ctx.env,
  });
}

async function promptBifrostModel(
  ctx: ProviderAuthContext,
  apiKey: string | undefined,
): Promise<string> {
  const baseUrl =
    resolveMergedModelProviderConfig(ctx.config, PROVIDER_ID)?.baseUrl ?? BIFROST_BASE_URL;
  let modelIds: string[] = [];
  let reason = "the gateway could not be reached or its request settings could not be resolved";
  try {
    const { discoverOpenAICompatibleLocalModels } =
      await import("openclaw/plugin-sdk/provider-setup");
    const result = await discoverOpenAICompatibleLocalModels({
      baseUrl: baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`,
      apiKey,
      configuredProvider: { config: ctx.config, id: PROVIDER_ID },
      beforeRequest: ctx.assertCurrent,
      env: ctx.env,
      signal: ctx.signal,
      label: "Bifrost",
      rawResult: true,
      discoverRuntimeContext: false,
    });
    if (result.kind === "success") {
      modelIds = [
        ...new Set(
          result.rows.flatMap(({ model }) =>
            typeof model.id === "string" && model.id.trim() ? [model.id.trim()] : [],
          ),
        ),
      ];
      reason = "the gateway returned an empty model list";
    } else if (result.kind === "http-error") {
      reason = `the gateway returned HTTP ${result.status}`;
    } else if (result.kind === "invalid-response") {
      reason = "the gateway returned an invalid model list";
    }
  } catch {
    // Discovery is advisory; keep request errors and credentials out of the prompt.
  }
  ctx.signal?.throwIfAborted();
  ctx.assertCurrent?.();
  if (modelIds.length > 0) {
    const selected = await ctx.prompter.select({
      message: "Bifrost model",
      initialValue: modelIds[0],
      options: [
        ...modelIds.map((id) => ({ value: id, label: id })),
        { value: "", label: "Enter model ID manually" },
      ],
    });
    if (selected) {
      return selected;
    }
  } else {
    await ctx.prompter.note(
      `Model discovery unavailable: ${reason}. Enter a model ID manually.`,
      "Bifrost models",
    );
  }
  return (
    await ctx.prompter.text({
      message: "Bifrost model ID",
      placeholder: "Model ID served by your gateway, such as openai/gpt-4o-mini",
      validate: (value) => (value.trim() ? undefined : "Model ID is required"),
    })
  ).trim();
}

export default definePluginEntry({
  id: PROVIDER_ID,
  name: "Bifrost Provider",
  description: "Bundled Bifrost provider plugin",
  register(api: OpenClawPluginApi) {
    const apiKeyAuth = createProviderApiKeyAuthMethod({
      providerId: PROVIDER_ID,
      methodId: "api-key",
      label: "Bifrost virtual key",
      hint: "Unified gateway for 20+ LLM providers",
      optionKey: "bifrostApiKey",
      flagName: "--bifrost-api-key",
      envVar: "BIFROST_VIRTUAL_KEY",
      promptMessage: "Enter Bifrost virtual key",
      defaultModel: BIFROST_DEFAULT_MODEL_REF,
      applyConfig: applyBifrostConfig,
      wizard: {
        choiceId: `${PROVIDER_ID}-api-key`,
        choiceLabel: "Bifrost virtual key",
        groupId: PROVIDER_ID,
        groupLabel: "Bifrost",
        groupHint: "Unified LLM gateway (20+ providers)",
        methodId: "api-key",
      },
    });

    api.registerProvider({
      id: PROVIDER_ID,
      label: "Bifrost",
      docsPath: "/providers/bifrost",
      envVars: ["BIFROST_VIRTUAL_KEY"],
      auth: [
        {
          ...apiKeyAuth,
          run: async (ctx: ProviderAuthContext) => {
            const baseUrl = await promptBifrostBaseUrl(ctx);
            const virtualKey = await promptBifrostVirtualKey(ctx);
            const config = applyBifrostConnection(ctx.config, baseUrl, {
              anonymous: !virtualKey,
            });
            const modelId = ctx.credentialOnly
              ? undefined
              : await promptBifrostModel({ ...ctx, config }, virtualKey?.apiKey);
            return {
              profiles: virtualKey
                ? [
                    {
                      profileId: `${PROVIDER_ID}:default`,
                      credential: buildApiKeyCredential(
                        PROVIDER_ID,
                        virtualKey.input,
                        undefined,
                        virtualKey.mode ? { secretInputMode: virtualKey.mode, config } : undefined,
                      ),
                    },
                  ]
                : [],
              configPatch: modelId ? await applyBifrostModelConfig(config, modelId) : config,
              ...(modelId ? { defaultModel: `${PROVIDER_ID}/${modelId}` } : {}),
            };
          },
          runNonInteractive: async (ctx: ProviderAuthMethodNonInteractiveContext) => {
            const runNonInteractive = apiKeyAuth.runNonInteractive;
            if (!runNonInteractive) {
              return null;
            }
            const configuredBaseUrl = normalizeOptionalSecretInput(ctx.opts.customBaseUrl);
            if (!configuredBaseUrl) {
              return await runNonInteractive(ctx);
            }
            // The delegated method is the sole authority on whether a credential exists:
            // it reads the flag, BIFROST_VIRTUAL_KEY, and existing profiles, and returns
            // null when none resolve. Re-deriving that from flag and inline presence here
            // would mark a gateway anonymous while a usable key was in scope, and the key
            // that path then saves would be stripped again at inference.
            const config = applyBifrostConnection(
              ctx.config,
              configuredBaseUrl.replace(/\/+$/, ""),
              { anonymous: false },
            );
            return await runNonInteractive({ ...ctx, config });
          },
        },
      ],
      catalog: {
        order: "simple",
        run: (ctx) => {
          // Bifrost exposes both /v1/models and /v1 prefixed bases; the shared join
          // does not dedupe the version segment.
          const explicitBaseUrl =
            findNormalizedProviderValue(ctx.config.models?.providers, PROVIDER_ID)?.baseUrl ?? "";
          const versionedBaseUrl = /\/v1\/*$/.test(explicitBaseUrl.trim());
          return buildOpenAICompatibleProviderCatalog({
            discoveryMode: "strict",
            ctx,
            providerId: PROVIDER_ID,
            buildProvider: buildBifrostProvider,
            allowExplicitBaseUrl: true,
            modelDiscovery: { endpointPath: versionedBaseUrl ? "models" : "v1/models" },
          });
        },
      },
      staticCatalog: {
        order: "simple",
        run: async () => ({ provider: buildBifrostProvider() }),
      },
    });
  },
});
