---
summary: "Run OpenClaw through a Bifrost gateway for unified model access, failover, and virtual-key governance"
title: "Bifrost"
read_when:
  - You want to route OpenClaw through a Bifrost gateway
  - You need failover, load balancing, or virtual-key budgets across providers
---

[Bifrost](https://getbifrost.ai) is a high-performance LLM gateway that unifies 20+ model
providers behind a single OpenAI-compatible API. Route OpenClaw through Bifrost for automatic
failover, weighted key balancing, semantic caching, and virtual keys with budgets and rate limits.

## Quick start

<Tabs>
  <Tab title="Onboarding (recommended)">
    ```bash
    openclaw onboard --auth-choice bifrost-api-key
    ```

    Onboarding prompts for the gateway base URL. Press Enter to keep the
    `http://localhost:8080/openai` default, or enter your gateway's URL. Setup then asks whether
    the gateway requires a virtual key; a gateway without authentication configured needs none.
    After that, choose a model returned by the gateway's `/openai/v1/models` endpoint. The first
    advertised model is selected by default; you can also enter a model ID manually. If discovery
    fails, onboarding shows the reason and asks for a manual ID. If the configuration changes
    while credentials are being prepared, setup stops before sending the discovery request.

    For non-interactive setup against a remote gateway, pass the gateway URL explicitly:

    ```bash
    openclaw onboard --non-interactive --accept-risk --skip-health --auth-choice bifrost-api-key \
      --bifrost-api-key "$BIFROST_VIRTUAL_KEY" --custom-base-url "https://bifrost.example/openai"
    ```

  </Tab>

  <Tab title="Manual setup">
    <Steps>
      <Step title="Run a Bifrost gateway">
        Bifrost calls upstream providers on your behalf, so it needs their keys:

        ```bash
        docker run -p 8080:8080 maximhq/bifrost
        ```

        A fresh gateway has no authentication. Protect it before exposing it beyond your machine,
        and see the [Bifrost setup guide](https://docs.getbifrost.ai/quickstart/gateway/setting-up)
        for provider keys and deployment options.
      </Step>
      <Step title="Verify the gateway answers">
        ```bash
        curl http://localhost:8080/openai/v1/models
        ```
      </Step>
      <Step title="Configure the provider">
        ```json
        {
          "models": {
            "providers": {
              "bifrost": {
                "baseUrl": "http://localhost:8080/openai",
                "api": "openai-completions",
                "auth": "none",
                "models": [
                  {
                    "id": "openai/gpt-4o-mini",
                    "name": "GPT-4o mini",
                    "reasoning": false,
                    "input": ["text"],
                    "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
                    "contextWindow": 128000,
                    "maxTokens": 16384
                  }
                ]
              }
            }
          }
        }
        ```
      </Step>
    </Steps>

  </Tab>
</Tabs>

## Base URL

Point OpenClaw at Bifrost's OpenAI-compatible surface, `http://localhost:8080/openai`. Bifrost
also serves a core API at the gateway root (`/v1/chat/completions`) and SDK-specific surfaces for
Anthropic, Bedrock, and Google GenAI. Use the `/openai` surface for OpenClaw so model discovery
and chat completions share one base URL.

Bifrost advertises provider-qualified model IDs such as `openai/gpt-4o-mini`,
`anthropic/claude-sonnet-4-6`, and `ollama/llama3.1:8b`. Reference them as
`bifrost/openai/gpt-4o-mini` and friends.

## Authentication

A gateway started without authentication accepts anonymous requests. Setup records that as
`auth: "none"` on the provider row instead of storing a key that resolves to nothing.

When Bifrost enforces authentication or you use [virtual keys](https://docs.getbifrost.ai/features/governance/virtual-keys)
for budgets and rate limits, supply the key during onboarding or set `BIFROST_VIRTUAL_KEY`. Use
one virtual key per governance boundary so spend and limits stay attributable.

### Which keys this provider supports

This provider sends the virtual key as `Authorization: Bearer <key>`. Bifrost accepts a virtual
key on that header **only** in one of two configurations, so check yours before you rely on it:

| Your setup                                                           | Works                            |
| -------------------------------------------------------------------- | -------------------------------- |
| Keyless gateway                                                      | Yes — recorded as `auth: "none"` |
| Key starts with `sk-bf-`, and Bifrost HTTP authentication is **off** | Yes                              |
| Key does **not** start with `sk-bf-` (a legacy key)                  | **No**                           |
| Bifrost HTTP authentication is **on** (`auth_config.is_enabled`)     | **No**                           |

The two failing rows both come from the same upstream rule: Bifrost honors legacy keys _only_
through its own `x-bf-vk` header, and when HTTP authentication is enabled it consumes
`Authorization` for that purpose instead. Setup succeeds in both cases and the failure surfaces
later as a `401` from the gateway, which is why it is worth checking now rather than debugging
it during a session.

### Sending the key through `x-bf-vk` instead

If your gateway is in one of the two unsupported rows, declare the header Bifrost wants on the
provider row:

```json
{
  "models": {
    "providers": {
      "bifrost": {
        "request": {
          "auth": {
            "mode": "header",
            "headerName": "x-bf-vk",
            "value": "${BIFROST_VIRTUAL_KEY}"
          }
        }
      }
    }
  }
}
```

This sends the key in **both** `x-bf-vk` and `Authorization`, so the gateway can accept either.
Verified against a local listener: both headers arrive when the variable is set.

:::warning
`BIFROST_VIRTUAL_KEY` must be **set in the Gateway's environment**. The reference is not
optional — if it is unset, OpenClaw sends the literal text `${BIFROST_VIRTUAL_KEY}` as the
header value, and Bifrost rejects that with `401 access not found` while ignoring the valid
`Authorization` header on the same request. Confirm the variable is exported before you turn the
header on.
:::

If you cannot export the variable — for example the Gateway runs under a service manager with a
fixed environment — configure the same field with a [secret placeholder](/reference/secret-placeholder-conventions)
that resolves in that context instead.

## Discovering models

```bash
openclaw models list --provider bifrost --refresh --json
openclaw models set bifrost/openai/gpt-4o-mini
```

Interactive onboarding always writes the model you select into the provider's list, whether
you picked one from the advertised models or typed an ID by hand. Any models already on the
provider row are kept, and the selected model is added when it is not already present.

Non-interactive onboarding leaves the list empty when a gateway URL is configured, so the
gateway's own discovery supplies the catalog. With no URL configured, or with
`models.mode: "replace"` — which disables discovery — it writes the documented default model
instead.

`openclaw models list --refresh` does not import the gateway's remaining advertised models
into the list; see [#121584](https://github.com/openclaw/openclaw/issues/121584).
