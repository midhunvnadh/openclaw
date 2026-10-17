# Bifrost

Connect OpenClaw to an existing Bifrost gateway for model routing through a shared
endpoint. Bifrost unifies 20+ LLM providers behind one OpenAI-compatible API with
automatic failover, load balancing, and virtual-key governance.

## Get started

Start or obtain access to a Bifrost gateway, then run:

```bash
openclaw onboard --auth-choice bifrost-api-key
```

Configure `models.providers.bifrost.baseUrl` for your gateway and supply its virtual key
through onboarding or `BIFROST_VIRTUAL_KEY`. Interactive setup asks whether the gateway
requires a virtual key, then offers the models served by the gateway's `/openai/v1/models`
endpoint and defaults to the first. Refresh the gateway's catalog with
`openclaw models list --provider bifrost --refresh`.

A gateway started with no authentication configured needs no credential, so setup records
the provider as `auth: "none"` instead of storing a key that resolves to nothing.

The gateway owns upstream credentials and model availability. Installing this
plugin does not start a gateway.

See the [Bifrost guide](https://docs.openclaw.ai/providers/bifrost) for endpoint
and routing setup.
