# Jev and self-hosted decision routing

Crawlspace can use a cloud or self-hosted decision model to choose who reviews each local assignment. The first supported decision is deliberately small: use the assigned worker, request the configured supervisor, or flag the assignment for review. Graph dependencies, tool permissions, cancellation and usage limits stay in controller code. No Kimi-specific service is required; your existing OpenAI subscription model can be the supervisor.

## Choose a decision endpoint

| Option | Decision API | Endpoint example | Requirements |
| --- | --- | --- | --- |
| Hosted TypeSafe Jev | Native System One | `https://api.typesafe.ai/v1` | Your own TypeSafe API key in `TYPESAFE_API_KEY`. This is separate from an OpenAI plan. Start with pinned model `jev-1.13.0`. |
| Self-hosted decision model | Native System One | `http://decision-machine:8080/v1` | A runner that serves the selected decision model through `/v1/systemone`, returning typed choices and probabilities. Set its exact model ID and an optional key environment variable. |
| Local chat model as a classifier | llama.cpp token probabilities | `http://decision-machine:8080` | A compatible llama.cpp server with `/tokenize`, `/apply-template` and `/completion`, including next-token probabilities. Server-root and `/v1` base URLs are accepted. |

An ordinary OpenAI-compatible chat endpoint does not automatically support either decision API. Strata can remain your code worker; give the decision role its own compatible endpoint. A chat model's token probabilities are not evidence of Jev-style calibration. Its temperature setting softens or sharpens the distribution; tune it using labeled examples.

TypeSafe documents the native protocol and current model version. Its aliases can move, so pin a version when comparing thresholds. [API reference](https://docs.typesafe.ai/api), [model versions](https://docs.typesafe.ai/models). Pi's installed classifier adapters are used for both API types; these are native classification calls, not generated JSON confidence claims.

## Connect and start in shadow mode

1. Add your local review models in **Models**, and assign each review agent to a local model. Set the stronger model under **Supervisor model** in **Workflow settings**. Existing cloud assignments and agents already assigned the supervisor bypass decision routing.
2. Open **Decision routing** in workflow settings. Choose **Shadow**, the decision API, endpoint URL and model ID. Enter the API key's environment variable name rather than the secret. Set that variable on the controller before starting Crawlspace. A keyless private endpoint can leave the name blank.
3. Use **Test decision connection**. It sends one synthetic assignment, without your project's prompts or findings. A successful result validates the typed protocol; it does not establish task accuracy.
4. Save settings and run a representative Pi workflow. Demo mode makes no classifier calls. Keep three global parallel slots and one slot per inference endpoint initially; classifier visits share those limits with workers.
5. Open a run's **Routing decisions** and download its JSON records. Review decisions against the actual task and worker results before enabling **Active** mode.

Routing is off for existing workflows until configured. Shadow mode never chooses a different worker, even when classification fails or reaches its allowance. Normal worker-requested escalation remains available.

## Active policy

The versioned `worker-route-v1` question has three fixed choices and an explicit uncertainty exit. A valid answer must contain only the known choices, a normalized probability distribution, a winning choice and finite confidence. The controller applies this policy:

| Answer | Action |
| --- | --- |
| Assigned worker, confidence at or above the threshold | Run the agent's assigned model. |
| Stronger reviewer, or any answer below the threshold | Use the configured distinct enabled supervisor. |
| Needs review, malformed answer, unavailable endpoint or decision timeout | Use that supervisor if configured; otherwise stop for human review. |
| Decision allowance exhausted | Make no additional classifier request. Shadow continues with assignments; active routing stops for review. |

Routing a supervisor consumes the same per-cycle and per-run supervisor allowance as ordinary escalation, exactly once. It runs the same assignment with the same confined tools. Further escalation is blocked. Classification releases its endpoint slot before the selected model starts, so sharing a server cannot deadlock the two visits.

Defaults are a 0.95 confidence threshold, ten seconds per decision, 100 decisions per cycle, 1,000 per run and one decision endpoint slot. Each decision is one bounded classifier evaluation without hidden retries. Failed attempts consume the allowance. A local classifier evaluation can make multiple tokenization/template/readout requests; the allowance counts evaluations, not HTTP requests or tokens. Waiting for an endpoint remains cancellable and is outside the decision deadline.

## What is sent and retained

The classifier receives bounded assignment metadata, model capabilities, relevant retained messages and findings. It does not read project files or receive screenshots. A cloud endpoint therefore receives selected review text; choose a self-hosted endpoint when that text must remain on your own machines. Metadata truncation is marked. Source evidence and screenshots remain available to the selected worker through its ordinary review tools.

Before inference, Crawlspace durably reserves a decision and records it as pending. Before starting a worker it saves the result, model version, question version, full distribution, threshold, recommendation, selected model and timing/usage. A routed supervisor is recorded as selected only after its allowance is reserved. Cancelled decisions cannot start workers. Interrupted pending decisions become cancelled on restart.

Each run retains its latest 500 structured records; its total evaluation count remains separate. Export records regularly during evaluation, before run-history retention replaces them. These records contain task decisions, not a complete labeled accuracy dataset or a complete monetary bill.

## Tune with evidence

Confidence describes the shape of a distribution; 0.95 is not a guarantee of 95% accuracy. Compare labeled examples by confidence band, task type, decision-model version and rubric version. Include ambiguous assignments, image requirements, hard cross-file work, misleading retained messages, unavailable endpoints and exhausted supervisor allowance. Measure worker quality and total model requests as well as routing agreement. [TypeSafe confidence semantics](https://docs.typesafe.ai/confidence)

Keep active routing disabled until those results justify the threshold. Change one question, model version or temperature at a time, and repeat evaluation. The supplied article's cost reductions are not measurements of this deployment. Real endpoint compatibility, model quality and savings remain commissioning work.
