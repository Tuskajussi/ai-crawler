# Crawlspace

A private, hostable workspace for a small team of coding and review agents. Build a workflow with React Flow, give each agent a persona and responsibilities (*vastuualueet*), choose its model, and let the team work on a codebase in repeated passes.

## Run locally

Requires Node.js **22.19 or later** (Node 24 works).

```powershell
npm install
npm run setup
npm run dev
```

Open the Vite URL printed in the terminal (normally `http://127.0.0.1:5173`). The API listens on `127.0.0.1:3001`. Vite selects another frontend port when needed. `npm run setup` creates a private `.env` with a random `CRAWLSPACE_REGISTRATION_SECRET` and preserves any existing file. Open that file locally and use its value in **Create account**. Choose a username and a password of at least 12 characters. Subsequent logins use only your username and password. The secret is never returned by the API or placed in the frontend bundle.

For one built server on your local machine:

```powershell
npm run build
npm start
```

Then open `http://127.0.0.1:3001`. Set `CRAWLSPACE_PORT` to change the API port; update the development proxy in `vite.config.ts` if changing it during development. The build includes `dist-server/index.js`, so production does not require TypeScript or Vite. For an internet-facing **Node/Ubuntu** installation, use the [hosting guide](docs/hosting.md), with systemd/Nginx or Docker Compose examples and HTTPS setup. `NODE_ENV=production` requires an HTTPS `CRAWLSPACE_PUBLIC_URL`.

## What works

- Add, move, connect, duplicate, and remove agents on a React Flow canvas.
- Browse a searchable library of premade agents with ready-to-use personas, instructions, and responsibilities.
- Configure a persona, instructions, model, responsibilities, and screenshot capability for each node.
- Select an existing local folder in project-wide settings, enable focused source edits, and run named test commands with actual execution records.
- Create/edit models for Anthropic, OpenAI, Ollama, and other OpenAI-compatible endpoints. Declare whether each model accepts images.
- Execute a single pass, a bounded loop, or a loop that continues until stopped.
- Run independent workflow branches together with global and per-endpoint limits.
- Check reports without a model, correct failed units within a budget, and approve the final reports at an acceptance gate.
- Keep scoped, manually curated lessons in future agent briefs and inspect acceptance outcomes separately from tool reliability.
- Share messages, directed assignments, findings, and a staff directory between agents.
- Track finding severity and resolution, inspect screenshot evidence, and review run history.
- Compare observed tool-call outcomes, retries and report repairs for each model configuration in Tool reliability.
- Save workflows, models, conversations, findings, and runs on the local machine.
- Prepare searchable chunks from text, PDFs, images, audio and video, with saved embeddings and source locations.
- Create accounts using a shared registration secret; sign in with persistent sessions and change passwords or sign out from the account menu.
- Keep workflows, models, conversations, findings, screenshots, and run history separate for each account.

The default **demo** executes the graph without a model connection. All demo activity and findings are labeled; the demo does not inspect files or take screenshots.

## Project settings, editing and tests

Open **Project settings** under Workspace and enter the full path to an existing folder, such as `C:\git\your-app`. **Validate folder** checks it without changing access; **Save project** makes it the shared folder for all agents. Local copies can use existing folders directly. Hosted accounts continue to use their private provisioned projects folder and support read-only review.

For implementation work, enable **Allow agents to edit project files** and **Allow agents to run configured tests**. Add named commands, for example **Unit tests** / `npm test`, with a timeout of 1–600 seconds. Prepare dependencies yourself before running. These commands execute trusted project code on the controller with its operating-system permissions; this is not an OS sandbox. The command environment omits provider/server secrets and injection variables, but scripts can still access files or network services available to your OS user. Do not use untrusted projects or background-service commands here.

Add the **Implementation worker** preset or enable **Edit project files** and **Run configured tests** on an existing agent. Give it a specific assignment in its instructions. Project permissions and agent capabilities must both permit the action. Edits happen directly in the selected folder; gates control workflow continuation and do not undo or apply edits later. Existing files require a successful source read and a unique exact-text replacement. New files cannot overwrite existing files and require an existing parent directory. Links, stale reads, binary/invalid UTF-8 files, credentials, generated files and sources over 512 KiB are rejected. File changes remain in place after Stop or a failed gate; review them with your version-control tools.

To require verification, add a report check with **Require passing tests** after a test-enabled agent, then connect it to an acceptance gate. Every configured command must have an actual passing receipt after the last agent edit, including edits by another worker. A later edit invalidates older receipts and requires retesting. Failed tests can return that unit for bounded correction. Provider-supplied claims never populate execution evidence. Run history and approval panels show actual file changes, exit status and bounded output; completed activities are also recorded in Team messages if a visit later fails or is stopped.

Workflows containing editing or test agents run visits sequentially to keep the shared folder consistent. Read-only workflows retain parallel workers. Within one controller, a mutating run holds an exclusive canonical-folder lease across accounts until its work drains; readers can share a folder only while no writer is active. Separate controller processes are not coordinated. Each visit allows up to 20 configured test invocations within the existing 40-tool-call and model-visit time limits. Timeout and Stop terminate the test process tree and wait for cleanup. Tests themselves can change the project; their scripts remain responsible for their own intended side effects.

## Premade node library

Choose **Add agent** in the builder to open the **Node library**. Search or filter by discovery, review, visual work, or coordination, then preview an agent's instructions and choose its model before adding it. The library covers tasks such as codebase exploration, bug hunting, test review, security review, UI inspection, triage, and stronger-model review. Every added node is fully editable in the inspector.

Presets favor enabled local models. The **Senior reviewer** prefers the configured supervisor when available, and screenshot presets only offer enabled models declared to support images. Model suggestions use your saved configuration; they do not test a connection or call a provider. Add or enable a suitable model in **Models** if a preset has no available model.

Connect the new agent to the entry agent's graph, then save. Review presets remain read-only, including test reviewers; the **Implementation worker** uses explicitly enabled editing and configured test tools. Decision routing and parallel execution remain configurable in **Workflow settings**. A stronger-model review node runs on every visit; optional supervisor escalation still uses the workflow's separate limits.

## Checks, acceptance gates and lessons

Select an agent at the end of a branch and choose **Add acceptance gate**. This adds a report check and a gate, or connects the new check to an existing human approval gate. You can also add either node from **Checks & gates** in the node library. Checks and gates use ordinary code and make no model requests.

The path is **agent reports -> report checks -> acceptance gate -> downstream work**. Configure checks to require text output, source locations or screenshots for findings, or a complete comparison judgment. Optional severity blocks stop acceptance when the report contains a selected severity. These checks establish the selected report requirements; they do not prove every claim is correct. Demo findings cannot satisfy real evidence checks.

A gate returns only reports with missing requirements to their own workers, with the reason, prior output and original assignment. Accepted siblings keep their results and independent contexts. Configure **0 to 3 corrections**; the initial attempt is separate. A severity block stops the path without asking the reviewer to rewrite away a legitimate issue. Provider retries, report-format repairs and supervisor visits retain their existing separate budgets; each correction is another bounded worker visit.

Choose automatic acceptance for contained work, or **Ask me after checks pass**. High-impact gates require human approval. The builder and **Runs** show the final reports and check evidence with **Approve work** / **Reject work** actions. Approval releases only the configured downstream graph; it does not deploy, edit files, run tests or override failed checks. One human approval gate is supported per workflow; combine final branches there. Automatic gates can be used at earlier stages. Approval repeats each cycle. Stop and restart close pending approvals; a stopped run needs a new traversal.

To prevent stale downstream results, a checked agent must send its normal outputs only to checks belonging to the same gate. Checks each connect to one gate. Put dependent work after that gate. Workflows containing checks or gates must have no same-cycle cycles; use explicit **Next cycle** connections for feedback. Existing workflows containing only agents keep their previous behavior.

**Runs** records each checked unit's model, attempt, pass/fail reasons and the gate's final verdict. The latest 500 unit outcomes and 200 node outputs are retained per run; pending approval keeps a separate snapshot of the final reports and check evidence. Tool reliability continues to track actual tool execution separately. Neither dashboard is a controlled quality benchmark, and corrections do not automatically change JEV routing.

Screenshot evidence is protected while checked reports wait for sibling branches and while approval is pending, even if current findings or ordinary history change. After the gate resolves, screenshots follow the existing finding and storage retention policy. Full retained storage blocks another capture rather than deleting evidence awaiting a decision.

In **Workflow settings -> Curated lessons**, add a proven constraint, scope it to selected agents or all agents, and disable or delete it when it no longer applies. Enabled lessons enter matching Pi assignment briefs, including corrections and supervisor review. Failures never become permanent instructions automatically. Up to 100 lessons of 2,000 characters are supported; their text consumes the selected model's context allowance.

## Searchable knowledge

Open **Knowledge** to configure an embedding model, preview chunks, create embeddings and search them. Gemini/Vertex support text, PDFs, images, audio and video; compatible local or cloud embedding servers support text. Preview preparation runs locally, and cloud creation/search each require explicit upload approval. Results keep line, page or timestamp references and offer chunk downloads. The library is stored separately from workflow state and does not yet add retrieval tools to review agents. See [Knowledge setup and limits](KNOWLEDGE-SETUP.md).

## Tool reliability

Open **Tool reliability** to compare real Pi workflow observations by model, endpoint, execution settings and Code Mode setting. Direct and nested tool calls share the tool totals; Code Mode wrapper calls have separate totals. Invalid arguments, unknown tools, tool execution errors, script errors, output limits, blocked calls and stopped calls remain distinct. The view also shows provider failures, bounded retries, rejected reports and repair attempts, including visits handled by the supervisor.

History stays in `.crawlspace/reliability.json` with a last-good backup and retains the latest 1,000 completed or drained visits. It stores outcome metadata, counts and timing; it excludes tool arguments, code, results, source contents and raw error messages. Demo runs, connection probes and decision-model requests are excluded. Records appear after a visit drains; an abrupt process termination can lose its in-flight observations. Storage failures are shown in the dashboard without turning a successful agent visit into a failure.

These are observations from your assignments, rather than a controlled model benchmark. Successful-call percentages include tool execution failures in their denominator, while blocked, cancelled and interrupted calls are excluded. Inspect the failure categories and sample counts before comparing models. When changing quantization or the actual model behind an unchanged endpoint, use a distinct model entry or exact model ID so the histories remain distinguishable. Existing JEV choices and supervisor limits continue to control execution; the tracker does not automatically reroute work.

## Connect Pi and real models

The current upstream Pi project is [earendil-works/pi](https://github.com/earendil-works/pi), formerly `badlogic/pi-mono`. Its SDK (`@earendil-works/pi-coding-agent`) is included as a dependency. Crawlspace owns workflow scheduling and shared state; Pi executes each agent visit. See the [official SDK docs](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md).

Pi's **Code Mode** is enabled by default for real Pi runs, including saved workflows that predate the setting. It lets an agent batch or repeat its allowed review-tool calls in a sandbox, using the same model selected for that agent. Direct review tools remain available for model compatibility. Turn off **Code Mode** in **Workflow settings** to use direct tools alone; demo runs do not use Code Mode.

Every person running their own local copy can add their own models; each local operator controls their endpoint and credential-name allowlists. Each copy keeps its model library and credentials on that person's machine. Shared hosted installations use operator-provided keys and per-account workspaces. Supported connections are Anthropic Messages, OpenAI Responses, and OpenAI-compatible Chat Completions endpoints, including Ollama and Strata. OpenAI models can use an API key or an eligible ChatGPT subscription. Models must support tool calls and return the requested JSON report.

1. Open **Models**, select your provider and its exact model ID, and set the endpoint when using Ollama or a compatible server. Endpoints usually include `/v1`.
2. If your provider requires a key, enter an operator-approved **environment variable name**, and set its value in the shell before starting the server. Restart the server after changing its environment. Credentials are not entered in the browser or saved in workflow JSON. Compatible endpoints can run without authentication whether hosted locally or in the cloud.
3. Open **Project settings**, select and save an existing local codebase folder. Hosted accounts require a checkout inside their private projects folder. Then choose **Pi harness — real agents** in **Workflow settings**.
4. Select the model in each agent's configuration. For UI agents, start the target app, set its local preview URL, and select an image-capable model.
5. Check the Pi and model setup status in **Models**, then save and choose **Test connection** on the saved model. This explicitly sends a small streaming request and verifies a native tool/result round-trip plus JSON. Configuration readiness alone does not contact the provider. Image input and Code Mode still need checking in a real workflow.

Example PowerShell setup:

```powershell
$env:ANTHROPIC_API_KEY = "your-key"
npm run dev
```

For Ollama, start Ollama separately, pull the model you selected (for example `qwen3:8b`), and use `http://127.0.0.1:11434/v1`. Text-only models can review code; screenshot agents require an image-capable model.

### Several local machines

Run one Crawlspace controller and register each inference server as a separate model. Add each server origin (scheme, hostname, port, without `/v1`) to `CRAWLSPACE_MODEL_ENDPOINT_ORIGINS` and restart the controller. For example, `http://192.168.1.10:8080,http://192.168.1.11:8080` enables two private inference servers; their model definitions can include `/v1`. Files, screenshots, workflow state and the Code Mode sandbox stay on the controller. Remote endpoints use the other machine's private address or a tunnel; `127.0.0.1` always refers to the controller itself. Keep the Crawlspace API on loopback and protect inference endpoints with authentication and private/encrypted networking as appropriate.

For Strata, choose **OpenAI-compatible** and its `/v1` base URL. Configure the same context the server actually uses; the model's advertised maximum is not a memory allocation.

For the proposed three-machine setup, set **Maximum parallel agents** to **3** in **Workflow settings** and leave **Endpoint request slots** at **1** for each model. Give independent reviewers separate branches after the entry agent and connect their results to a coordinator. A straight chain still runs in sequence; branching is what lets the three inference servers work together. This distributes review work across models; each model still uses its own machine's RAM and GPU.

Parallel execution is opt-in: `maxParallelAgents` accepts 1–8 and defaults to 1. Saved `maxParallel` settings are migrated; the comparison template explicitly selects at least 3 workers. Each model's `maxConcurrentRequests` also accepts 1–8 and defaults to 1. Models pointing at the same normalized endpoint origin share the lowest configured limit among its enabled aliases, including different paths and `localhost` / `127.0.0.1` / `[::1]` aliases. Default provider URLs participate in the same pools. A queued visit for a busy server does not occupy a global slot or block another available server. Primary and supervisor visits share both limits; the primary releases its slot before requesting the supervisor.

Each model can set its output cap, full-visit timeout and, for compatible servers, reasoning effort. Defaults retain a 32,768-token context, an output cap of at most 8,192 tokens, and a 180-second deadline. Reasoning settings are forwarded to the selected runner; support and meaning vary by model. Shared history and tool outputs are budgeted conservatively before requests. An assignment or required tool schema that cannot fit fails clearly instead of silently dropping instructions.

### ChatGPT subscription reviewer

In **Models**, use **Continue with ChatGPT** to connect your own account. Add an OpenAI model, choose **ChatGPT plan**, select the saved profile, and load the models available to that connection. Save and test the model before assigning it. Sign-in and permission to use the plan are separate; model discovery is not proof a particular inference request is entitled. Eligible accounts use the supported public Responses route. [Official local-app integration](https://developers.openai.com/siwc/token-sharing-open-source)

Connections use a stable installation registration, verified ID tokens, serialized rotating-token refresh, and sign-out/revocation. Credentials live in the OS user's configuration directory outside the project, keyed to the account's workspace directory. Browser sign-in connects the controller's own local account; hosted deployments do not expose the loopback ChatGPT sign-in flow. Windows uses current-user DPAPI; Unix files use owner-only permissions. No existing Codex credentials or client IDs are reused. API-key requests remain a separate billing path.

Subscription Responses currently do not accept an output-token cap. The configured cap reserves context space locally; timeout, tool and supervisor-visit limits still apply. Check the selected account's allowance in ChatGPT. [Subscription request limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)

### Bounded stronger-model escalation

In **Workflow settings**, optionally select a **Supervisor model**. An agent can return a typed `escalation` reason for a difficult or uncertain case. After local transient retries or report repair are exhausted, eligible model failures can also request the supervisor. The supervisor uses the same confined review tools and verifies the evidence independently. Configuration/authentication errors and cancellation do not trigger fallback.

Without a supervisor selected, no extra model is called. Limits default to one supervisor visit per cycle and ten per run; reaching either allowance stops for review. A visit can contain multiple model requests, tools and retries, so these are not exact token or monetary caps. Further escalation from the supervisor is blocked. Routing reasons, attempts, request counts, duration and reported token usage appear in the team inbox.

Optional native decision routing is available in **Workflow settings**. Use a cloud or self-hosted System One decision endpoint, or llama.cpp's token-probability classifier. Start in **Shadow** mode: it records decisions while assigned workers and existing escalation stay in control. **Active** mode can route a local assignment to its assigned model or the configured supervisor; uncertainty goes to the supervisor under the same limits, or stops for human review. See [Jev setup and evaluation](JEV-SETUP.md). Code Mode cannot make arbitrary extra model calls.

Screenshots use Playwright Chromium, with installed Microsoft Edge as a fallback on Windows. If neither is available, install the screenshot browser once:

```powershell
npx playwright install chromium
```

## Compare three models on the same problem

Choose **Compare models** in the builder. Write the shared problem, select three candidate models and a judge model, then choose **Use comparison template**. The template creates:

```
                 ┌─ Candidate A ─┐
Shared problem ──┼─ Candidate B ─┼── Judge
                 └─ Candidate C ─┘
```

All three candidates receive the same brief and identical instructions. They run independently and concurrently (model endpoint and hardware capacity permitting). The judge starts only after every candidate completes and receives each answer separately with its agent/model identity. Select the judge and open **Instructions** to edit its scoring rubric. Add a third model in **Models** if needed; repeated models are also allowed for agent/prompt experiments.

Open **Run history** and expand the cycle and judge result to see the full answers, scores out of 100, reasons, and selected winner. Ties can produce no winner. The demo produces explicitly simulated answers and rankings; real judgments are model evaluations, not objective test results. Each cycle uses fresh predecessor outputs. The latest 200 node outputs per run are retained locally; stopping or a branch failure cancels other active branches and prevents the judge from running on partial inputs.

## Execution semantics

All agents must be connected to the entry agent before saving. Each reachable agent starts once per cycle; gates can request bounded corrections. **Maximum parallel agents** defaults to 1; higher limits schedule independent read-only branches together. Workflows using editing or tests serialize their visits. A join waits until every incoming branch has durably saved its report, even with a single worker. A straight chain remains sequential. The builder marks connections back to ancestors as next-cycle feedback.

Connections marked as loops (`data.loop: true`) and connections returning to the entry agent are treated as feedback for the next cycle and do not add dependencies within the current cycle. Any remaining directed cycle is grouped into a component whose agents run sequentially in traversal order; its outgoing branches wait for that entire component. The next workflow cycle waits for all branches, then starts after the configured pause. Single-pass mode finishes after one visit to each agent.

Each ready group receives snapshots of committed messages, findings, and current-cycle direct predecessor outputs before any sibling starts or waits for endpoint capacity. This keeps comparison candidates independent, including when they share one endpoint. Descendants and judges receive their completed prerequisites' outputs. Legacy cycle components snapshot each sequential member after the previous member commits. Each Pi attempt has an isolated session, runtime configuration, authentication store and catalog directory, so concurrent visits do not rewrite shared SDK files. The session receives its persona, prompt, responsibilities and staff directory. It can consult `list_staff`, inspect files, and capture a local UI when enabled. A validated JSON report adds findings and assignments to shared state. Assignments supply context; they do not change execution order or bypass graph connections.

Read and edit tools are confined to the selected project. Canonical paths reject traversal and outside-project symlinks; credential files, generated directories, large files, and binary files are excluded. Code findings must cite inspected files. Editing and configured test execution require explicit project and agent permissions. Built-in Pi shell/edit tools, repository instructions, other extensions, and skills remain disabled; custom project tools implement the enabled capabilities. Configured tests run trusted code with normal OS permissions, as described above.

Code Mode receives only the tools allowed for the current agent visit, including custom editing and configured-test tools when enabled. It does not add arbitrary shell commands or access beyond those tools. Its temporary store belongs to one agent visit and is discarded when that visit ends. A workflow cycle creates new visits and fresh stores; findings, messages, and assignments continue to pass between agents through the workspace's shared state.

Each agent visit has a configurable deadline and a 40-tool-call limit shared across Code Mode, nested calls and retries. The deadline starts when the executor begins, including startup and retries; waiting for workflow or endpoint capacity is outside that timer and remains cancellable. Endpoint slots bound whole visits through their cleanup, rather than individual HTTP requests. Temporary provider/network failures have at most three attempts with cancellation-aware backoff; long server-requested waits fail clearly. Edit/test receipts stay shared within the visit, and retries do not revert changes. An invalid report gets at most one repair across the visit. Remaining failures use the explicitly configured supervisor when eligible, or fail visibly in history. A terminal branch failure cancels queued work and drains running siblings before ending the run. Stop also drains every active visit before another run or model edit can begin. A server restart marks interrupted runs stopped; automatic restart/resume is not implemented.

Screenshots use Playwright at a 1440×1000 viewport. Preview URLs must use an explicit loopback host (`localhost`, `127.0.0.1`, or `[::1]`); requests to other origins, service workers, and WebSockets are blocked. This can leave externally hosted assets or live data absent from a screenshot. The target application must already be running.

Accounts and hashed sessions live in `.crawlspace/auth.json`. Each account has `.crawlspace/users/<user-id>/state.json`, `projects/`, `screenshots/`, and temporary `pi/` session files (cleaned after each visit). `CRAWLSPACE_DATA_DIR` changes this root. The first registered account receives a copy of legacy workflow state, screenshots, knowledge and reliability data, with existing ChatGPT connections associated with that account; later accounts start fresh. Legacy data is preserved. Save **Project settings** to select an existing local folder; without shared project settings, the legacy workflow path stays confined to the private projects folder.

Registration is closed if `CRAWLSPACE_REGISTRATION_SECRET` is empty. Rotate or clear it and restart to change future invitations; existing logins continue. Accounts use salted scrypt passwords, opaque HttpOnly/SameSite cookies, CSRF checks, authentication rate limits, and exact public Host/Origin checks. HTTPS public deployments set Secure cookies. Password changes invalidate every session for that account; there is no email recovery or administrator password-reset UI yet. Back up the data directory and protect the server environment file.

The operator controls allowed model credential names, custom endpoint origins, and screenshot preview origins. The defaults permit only the standard Anthropic/OpenAI credential variables; local development additionally permits loopback Ollama on port 11434. Production must explicitly enable local/custom endpoints and preview origins. Approved provider keys are shared server credentials, so invite only people allowed to consume their quotas. Projects are provisioned by the operator; account separation is application-level, not a separate OS sandbox. Run **one Node process per data directory**; the JSON stores do not support clustered/multiple writers. See [hosting and account provisioning](docs/hosting.md) for configuration and backup instructions.

State changes are published after a synced atomic save; a validated `.bak` snapshot supports recovery from a damaged primary file. Repeated findings update evidence and reopen resolved issues when observed again. Screenshot retention removes unreferenced old images and enforces a storage allowance. Pending screenshot leases preserve concurrent evidence until reports commit or are discarded. A full allowance blocks additional captures. Temporary Pi attempt directories are removed after cleanup. Knowledge indexes, source media and tool reliability records are also private to each account.

## Checks

```powershell
npm run build
npm test
npm run test:ui
npm run test:auth
npm run test:ux
npm run test:gates
npm run test:project-ui
npm run test:pi
npm run test:subscription
npm run test:parallel
npm run test:knowledge
npm run test:reliability
npm run test:production
```

Backend tests cover dependency planning, endpoint/global caps, loop bounds, cancellation/draining, save failures and recovery, decision routing and supervisor allowances, API/model validation, context budgets, screenshot retention, path confinement, report evidence, and mocked subscription authentication. The UI smoke tests model limits, routing setup/traces/exports, parallel and supervisor controls, mocked profile/catalog flows and connection probes alongside the workflow and messaging features. The UX check covers all eight screens at 320, 390, 768, 1280 and 1512 pixels, plus drawer/dialog keyboard access, focus restoration, shelf filters and editing locks during a run; screenshots go to `.crawlspace/previews/ux-*.png`. Browser checks use installed Microsoft Edge or Playwright Chromium. Pi checks exercise the actual SDK and Code Mode against localhost or in-memory mock transports, including temporary failures, report repair, limits and cancellation. The parallel integration check exercises a native decision endpoint, concurrent SDK sessions and dependency handoffs. These checks do not spend subscription/API allowance or establish real-model quality.

The production smoke test starts the compiled server, checks account registration/login, cookies, CSRF and static assets, then restarts to verify persistent sessions and workspace data.

This version supports one saved workflow per account, bounded parallel review workers, model-comparison judging, optional decision routing, local screenshots and bounded supervisor escalation. Scheduled startup, patch-writing agents, and container-isolated test execution remain future extensions. Real endpoint/hardware checks, classifier evaluation and a representative sustained run are required before treating a deployment as production ready.
