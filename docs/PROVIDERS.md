# LLM Providers

AgentKernel uses the Model Abstraction Layer (MAL) to route requests across providers.
Providers are enabled by setting the right environment variables.

---

## Built-in providers

### Anthropic (Claude)
- Env: `ANTHROPIC_API_KEY`
- Models: see `providers/anthropic/src/index.ts`

### OpenAI
- Env: `OPENAI_API_KEY`
- Models: see `providers/openai/src/index.ts`

### Google (Gemini)
- Env: `GOOGLE_AI_API_KEY`
- Models: see `providers/google/src/index.ts`

### Ollama (local)
- Env: `OLLAMA_URL` (default: `http://localhost:11434`)
- No API key required

To use Ollama:
```bash
ollama serve
ollama pull llama3.2
```

---

## Adding a new provider

1) Create a provider package in `providers/<your-provider>/src/index.ts`
   and implement the MAL `ProviderAdapter` interface.

2) Register it in the gateway:
   - Add dependency to `apps/gateway/package.json`
   - Import and register in `apps/gateway/src/main.ts`

3) Add the provider env variable to:
   - `.env.example`
   - `docker-compose.yml`

4) Rebuild the gateway and test:
```bash
pnpm build
pnpm -C apps/gateway dev
```

The MAL will automatically route to any available provider based on models.

