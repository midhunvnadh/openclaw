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

## Discovering models

```bash
openclaw models list --provider bifrost --refresh --json
openclaw models set bifrost/openai/gpt-4o-mini
```

In merge mode, onboarding leaves the provider model list empty for discovery. With
`models.mode: "replace"`, discovery is disabled and onboarding keeps the documented default model
in the list.
