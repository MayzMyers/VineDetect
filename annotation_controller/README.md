# Annotation Controller

Reference HTTP runtime for the headless annotation pipeline. The primary LLM path consumes a stage-scoped observation and returns a bounded decision; it never owns Wizard state or database mutations. The older whole-Wizard correction-plan request remains available for the deterministic/local compatibility path.

The same image supports provider-neutral controller backends:

- `CONTROLLER_BACKEND=deterministic` uses the reference frontier planner;
- `CONTROLLER_BACKEND=openai` uses the official OpenAI SDK and Responses API with image inputs and strict Structured Outputs.
- `CONTROLLER_BACKEND=qwen` uses the same stage decision contract through Qwen Model Studio's OpenAI-compatible Chat Completions API.

```bash
npm install
npm start
```

Routes:

- `GET /health`
- `POST /annotation/plan`

Supported tasks on the POST route:

- `stage-evaluation` — primary LLM contract: `StageObservation -> StageLLMDecision`;
- `annotation-correction-plan` — legacy/reference whole-Wizard planner contract.

The implemented stage-scoped slice covers Label, Object Context, OCR, Mask, Morphology, Components, Elements, Contours, Palette and an advisory Summary pass. Recognize owns deterministic helper execution, bounded observations and visual overlays; the model may return `accept(candidateId)`, a bounded granular `review`, `rerun` with one whitelisted semantic adjustment, or `human_required`. Recognize translates semantic intent into bounded numeric config, reruns the helper at most twice and records every attempt. Granular review may correct/reject known OCR IDs, accept/reject known Components and classify/reject known Elements. Elements review may also move known component IDs into known Elements or bounded new groups whose persisted IDs and provenance are created by Recognize; the model cannot invent persisted identities. Every final accepted/reviewed decision is validated and becomes an unapplied correction plan. Package remains a human technical scope. Caching, calibrated metrics and batch execution remain planned.

Recognize, not this provider adapter, owns `LLMSession` and `LLMStageRun` persistence. Each provider call remains stateless and receives the bounded current StageObservation plus DB-reconstructed session context. Provider chat history is therefore optional transport state, never canonical workflow state.

`wizard-runtime-v1` is server-owned. It registers the algorithms and bounded decision actions available for each current stage and maps actions to `create_plan`, `rerun_helper` or `stop`. The controller does not keep an authoritative Wizard-stage or semantic-adjustment list: it builds the provider output schema from the current observation's `stage`, `policy.allowedActions` and `policy.allowedSemanticAdjustments`, then validates the response against the same runtime policy. Only the small provider-neutral decision protocol (`accept`, `review`, `rerun`, `human_required`) and payload shape remain local safety boundaries. The controller does not choose the next Wizard stage. A deterministic helper may append up to 32 validated `runtimeState.helper.intermediateStates`, including nested `parentId` links, when its own intermediate output causes another internal pass. These states are observation/evidence only and never become model-invented executable commands.

Set `CONTROLLER_TOKEN` to require `Authorization: Bearer ...`.

OpenAI backend variables:

```text
CONTROLLER_BACKEND=openai
OPENAI_API_KEY=<OpenAI Platform API key>
OPENAI_MODEL=gpt-5.6-terra
OPENAI_REASONING_EFFORT=medium
OPENAI_MAX_OUTPUT_TOKENS=12000
OPENAI_TIMEOUT_SECONDS=120
OPENAI_MAX_RETRIES=2
```

For Docker Compose, set the real key only in the ignored repository-root `.env`, then recreate `llm-controller`. `GET /health` reports `configured=true` only when the OpenAI backend received a non-empty key; Compose marks this container unhealthy otherwise. Never store a real key in `.env.example`.

The Node.js runtime reads the API key only inside the controller process. It sends a clean preview, an overlay preview and compact Wizard JSON to the selected provider, overrides model-supplied controller provenance with the actual configured model and prompt version, returns a correction plan, and never applies it.

Qwen backend variables:

```text
CONTROLLER_BACKEND=qwen
QWEN_API_KEY=<Model Studio API key>
# DASHSCOPE_API_KEY may be used instead of QWEN_API_KEY.
QWEN_BASE_URL=<OpenAI-compatible workspace/region base URL ending in /v1>
QWEN_MODEL=qwen3.7-flash
QWEN_MAX_OUTPUT_TOKENS=4000
QWEN_TIMEOUT_SECONDS=120
QWEN_MAX_RETRIES=2
QWEN_STAGE_TRANSPORT=chat
```

In Compose select it with `LLM_CONTROLLER_BACKEND=qwen`; Recognize still calls the same `LLM_WIZARD_CONTROLLER_URL`. Only the selected provider's credentials are required. `QWEN_STAGE_TRANSPORT=chat` keeps stateless compatible Chat Completions. `QWEN_STAGE_TRANSPORT=responses` eagerly creates one provider Conversation when the DB-owned card session starts and attaches every fresh stage observation through Responses. Stage evaluation retains a lazy recovery fallback if the provider binding is missing. Responses/Conversations require Alibaba's workspace-specific compatible base URL. Provider history is only a continuity carrier and never replaces the canonical DB session context, events or stage-run snapshots.

Tests and syntax checks:

```bash
npm test
npm run check
```
