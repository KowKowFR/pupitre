# AI AppSpec generation

The LLM produces **JSON validated by Zod**. Never shell, never a command, never a
file path. It is our code that executes — and it only executes what passed
`appSpecSchema`.

It is an **optional** feature. Without a key, the route answers `501` with an
explicit message, the "From a description" tab is disabled and says so, and the
rest of the panel works exactly the same.

## The flow

```
POST /api/applications/generate     application:create
  { prompt, hints? }
      ↓  generateObject()  — Vercel AI SDK
      ↓  safeParseAppSpec() — refinements included
  { appSpec, model, usage, attempts }        ← NOTHING is persisted
      ↓  the user reads it again, corrects it in the JSON editor
POST /api/applications              application:create
  { appSpec, generation: { prompt, model, appSpec } }
```

Generation does not write to the database and does not deploy. **An AI that
created the application itself would take away from the operator the only moment
they can say no.** The **Save** button is the same in both tabs of
`/applications/new`, and it takes the same route as the manual import.

## Three providers

The catalog is pure data, without dependencies:
`packages/core/src/ai/catalog.ts`. `@pupitre/db` and the worker can therefore
know the list of providers without pulling the AI SDK into their graph.

| Key | Default model | Env variables | `baseUrl` |
|---|---|---|---|
| `openrouter` | `anthropic/claude-sonnet-4.5` | `OPENROUTER_API_KEY` / `OPENROUTER_MODEL` | no |
| `openai` | `gpt-4.1-mini` | `OPENAI_API_KEY` / `OPENAI_MODEL` | **yes** |
| `anthropic` | `claude-sonnet-4-5` | `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` | no |

**The model list is static.** Nothing queries the provider to find out what it
offers: the catalog carries three to five models per provider, with a tier
(budget / balanced / capable) and an indicative price in $/M tokens, **noted on
2026-09-11**. The list is a suggestion, backed by an "Other — enter an
identifier" option with a free field.

Reasoning models (`gpt-5`, `o*`) are deliberately excluded: they exceed the
route's time limit.

`aiModelMismatch()` **warns without forbidding**: entering `claude-…` while the
provider is OpenAI shows a warning ("looks like an Anthropic identifier, not an
OpenAI one"). It is neutralized if a `baseUrl` is set — a self-hosted
OpenAI-compatible API serves what it wants.

The `baseUrl` field is only shown **and sent** if the provider declares it: an
explicit refusal to leave a setting without effect in the database.

### Where the key comes from

```
apiKey = key from the instance settings ?? env[provider variable]
model  = model from the settings ?? env[provider variable] ?? catalog default
enabled = ai.enabled AND a key exists
```

**The instance setting wins.** The environment variable is the safety net: a
panel provisioned by `docker compose` generates without anybody having opened the
settings screen.

The variable read **depends on the provider chosen**: `OPENROUTER_API_KEY` will
never be used to reach Anthropic.

`ai.enabled` is a **switch, not a consequence**: unticked, generation is off even
with a valid key, and the `501` then carries a reason distinct from "no key".

Architecture detail: `@pupitre/core` imports neither `@pupitre/db` nor
`apps/web`, so both sources are **passed to it as arguments**. Callers pass the
raw `process.env`, and not the panel's validated environment — deliberately, so
that adding a fourth provider does not force touching `env.ts`.

> There is **no connection test button** for AI. The test happens de facto by
> attempting a generation. And `GET /api/health` publishes an `ai` state that
> only reads `OPENROUTER_API_KEY` as an environment variable: it ignores the
> instance settings and the other two providers. An instance perfectly
> configured in the database shows up there as `ai.enabled: false`.

## `generateObject()`, not `generateText()` + `JSON.parse`

The schema passed to the SDK is `appSpecShapeSchema` — the *shape* of the
AppSpec, without the cross-field constraints. A JSON Schema cannot express
"exactly one exposed service" or "no cycle in `dependsOn`" anyway: those rules
disappear in translation, whatever schema you give.

By keeping full validation on our side, it is **our** code that holds the verdict
and can feed Zod's complaints back into a retry, instead of delegating it to the
SDK and fishing a `ZodError` out of the bottom of a `cause` chain.

Strict structured output mode is disabled for OpenRouter and OpenAI: the AppSpec
uses a `discriminatedUnion`, hence a `oneOf`, which OpenAI's strict mode refuses.
Zod validation on the panel side remains the real guarantee.

## One retry, not two

If the spec does not pass validation, we retry **only once**, feeding back Zod's
errors, path by path, word for word. If the second attempt fails too, we give
control back with the list of complaints. **We do not "repair" the JSON by
hand**: repairing means writing half the spec yourself without anybody having
asked for it.

The complaints fed back to the model are Zod's original sentences; the ones shown
to the user are said again in the instance's language
(`packages/core/src/validation.ts`).

Three failure reasons, three HTTP codes, because they are three different
failures and they do not call for the same reaction:

| Reason | HTTP | What happened |
|---|---|---|
| `invalid_spec` | 422 | the model answered, its spec does not pass validation — even after a retry |
| `no_object` | 422 | the model did not produce a usable JSON object |
| `provider` | 502 | network, quota, key refused, timeout — the model said nothing |

## The system prompt is a file

`packages/core/src/ai/prompts/generate-appspec.md`, versioned like code. It
describes the schema and its constraints, requires official images with a
precise tag (**never `latest`**), a healthcheck per service, realistic
`resources`, `runAsNonRoot` compatibility, the use of secret aliases, and forbids
clear-text secrets in `env`. It is written in English; the description a
user types can be in any language the model understands.

It carries `{{FIXTURE:name.json}}` markers replaced at load time by the **real**
content of the three fixtures. Copying the fixtures into the markdown would have
been simpler, and wrong: the few-shot examples would have drifted at the first
fixture change, with nothing to report it.

**Loading this file was the real trap.** `tsc` does not copy `.md` files to
`dist/`: the `build` script of `packages/core` copies them. But above all, Next
**inlines** `@pupitre/core` into its server chunks — `import.meta.url` no longer
designates the package there, and the tracer sees no `import` of a `.md`. Three
measures, none superfluous:

1. `outputFileTracingIncludes` in `next.config.ts` embeds the prompt and the
   fixtures in the `standalone` tree, at their path from the monorepo root;
2. `readCoreAsset()` tries several candidates — next to the module, then relative
   to the current directory, where the `standalone` server places itself in
   `apps/web`;
3. **each candidate is validated by its content.** Turbopack rewrites
   `new URL(…, import.meta.url)`: the `readFileSync` succeeded perfectly and
   returned a JavaScript module's source code instead of the prompt. Observed, not
   assumed — the probe announced 1,701 bytes where the prompt had 9,966. Without
   content validation, the error is silent and the model answers anything without
   anything having failed.

That is also why `/api/health` loads the prompt and publishes its size: a file
missing from an image must show in the probe, not in front of the first user.

## Safeguards

| Safeguard | Value | Where |
|---|---|---|
| Prompt size | 8 to 4,000 characters | Zod, before any call |
| Timeout | 60 s | `AbortSignal.timeout` |
| Rate | 10 generations / 10 min / **user** | Redis, `INCR` + `EXPIRE` |
| Attempts | 2 at most | `generateAppSpec()` loop |

The rate counter is per user and not per IP: behind a corporate NAT everyone
shares an address, and the session is mandatory anyway. Redis unavailable **lets
through** — a broken counter must not cut a feature — but the incident is
logged.

The body is validated **before** looking at the configuration: a malformed
request is malformed on every panel, with or without a key. The reverse would make
the response depend on the deployment, and a client could no longer tell "my
request is wrong" from "this panel has no AI".

Each generation goes through `logAudit()` — prompt, model, tokens, duration,
attempts, success or failure reason. The key appears nowhere: neither in a log,
nor in an audit entry, nor in the response. See
[`security.md`](security.md#encryption) for what is redacted, and why it goes
beyond the exact value.

## Without a key

The full chain — prompt, validation, single retry, clean rejection, provider
failure — is covered by `packages/core/test/ai.test.ts` with a **mock model**
(`MockLanguageModelV3`).

No key is configured in this repository. `verify-ai.sh` says so at the top of the
file and does not make it up: what depends on a provider is played either
offline, or on its clean refusal. **Nobody has seen a real model answer on this
instance.**
