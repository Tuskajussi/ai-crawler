# Crawlspace

A private, hostable workspace for a small team of code-review agents. Build a workflow with React Flow, give each agent a persona and responsibilities (*vastuualueet*), choose its model, and let the team review a codebase in repeated passes.

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
- Configure a persona, instructions, model, responsibilities, and screenshot capability for each node.
- Create/edit models for Anthropic, OpenAI, Ollama, and other OpenAI-compatible endpoints. Declare whether each model accepts images.
- Execute a single pass, a bounded loop, or a loop that continues until stopped.
- Share messages, directed assignments, findings, and a staff directory between agents.
- Track finding severity and resolution, inspect screenshot evidence, and review run history.
- Create accounts using a shared registration secret; sign in with persistent sessions and change passwords or sign out from the account menu.
- Keep workflows, models, conversations, findings, screenshots, and run history separate for each account.

The default **demo** executes the graph without a model connection. All demo activity and findings are labeled; the demo does not inspect files or take screenshots.

## Connect Pi and real models

The current upstream Pi project is [earendil-works/pi](https://github.com/earendil-works/pi), formerly `badlogic/pi-mono`. Its SDK (`@earendil-works/pi-coding-agent`) is included as a dependency. Crawlspace owns workflow scheduling and shared state; Pi executes each agent visit. See the [official SDK docs](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md).

1. Open **Models**, select your provider and its exact model ID, and set the endpoint when using Ollama or a compatible server. Endpoints usually include `/v1`.
2. For cloud models, enter an **environment variable name** approved by the host operator, and set its value in the server environment before starting the server. Credentials are not entered in the browser or saved in workflow JSON.
3. Open **Workflow settings** and copy the displayed private projects folder. Provision a checkout inside it on the server, enter that checkout's absolute path, and choose **Pi harness — real agents**. Accounts cannot inspect arbitrary server directories.
4. For UI agents, start the target app, set its local preview URL, and select an image-capable model.
5. Save and run the workflow.

Example PowerShell setup:

```powershell
$env:ANTHROPIC_API_KEY = "your-key"
npm run dev
```

For Ollama, start Ollama separately, pull the model you selected (for example `qwen3:8b`), and use `http://127.0.0.1:11434/v1`. Text-only models can review code; screenshot agents require an image-capable model.

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

Graph edges define dependencies from the entry agent. Ready agents start in graph order with actual concurrent model sessions. Each reachable node executes once per cycle; a return edge is permitted and does not recurse within the same cycle. All agents must be connected to the entry agent before saving. Independent branches run concurrently, up to Maximum parallel agents (default 3, configurable 1–8). Each node waits for ALL non-loop predecessors before starting; joins therefore wait for every branch. The non-loop graph must be acyclic. Connections back to an ancestor are marked as next-cycle edges by the builder and are excluded from same-cycle dependencies. The next cycle starts after the configured pause. Single-pass mode ignores return edges after each node has been visited.

Each visit starts a fresh Pi session with its persona, prompt, responsibilities, staff directory, relevant recent messages/assignments, and existing findings. The agent can consult `list_staff`, inspect files, and capture a local UI when enabled. It returns a validated JSON report; findings and assignments are added to shared state for subsequent agents. Assignments supply context; they do not change the execution order or bypass graph connections. This is asynchronous collaboration between visits, rather than simultaneous chat between independent processes.

Real agents have read-only tools confined to the selected project. Canonical paths reject traversal and outside-project symlinks; credential files, generated directories, large files, and binary files are excluded. Code findings must cite inspected files. Agents inspect tests but do not execute test commands or edit code. Built-in Pi shell/edit tools, repository instructions, extensions, and skills are disabled for these sessions.

Each agent visit has a three-minute and 40-tool-call limit. A provider error or invalid report fails the run and is visible in history. Stop cancels active model work and pending cycle timers. A server restart marks interrupted runs stopped; automatic restart/resume is not implemented.

Screenshots use Playwright at a 1440×1000 viewport. Preview URLs must use an explicit loopback host (`localhost`, `127.0.0.1`, or `[::1]`); requests to other origins, service workers, and WebSockets are blocked. This can leave externally hosted assets or live data absent from a screenshot. The target application must already be running.

Accounts and hashed sessions live in `.crawlspace/auth.json`. Each account has `.crawlspace/users/<user-id>/state.json`, `projects/`, `screenshots/`, and temporary `pi/` session files (cleaned after each visit). `CRAWLSPACE_DATA_DIR` changes this root. The first registered account receives a copy of an existing legacy `.crawlspace/state.json` and screenshots; later accounts start with a fresh workflow. Legacy data is preserved. An old absolute project path must be updated to a checkout inside that account's projects folder.

Registration is closed if `CRAWLSPACE_REGISTRATION_SECRET` is empty. Rotate or clear it and restart to change future invitations; existing logins continue. Accounts use salted scrypt passwords, opaque HttpOnly/SameSite cookies, CSRF checks, authentication rate limits, and exact public Host/Origin checks. HTTPS public deployments set Secure cookies. Password changes invalidate every session for that account; there is no email recovery or administrator password-reset UI yet. Back up the data directory and protect the server environment file.

The operator controls allowed model credential names, custom endpoint origins, and screenshot preview origins. The defaults permit only the standard Anthropic/OpenAI credential variables; local development additionally permits loopback Ollama on port 11434. Production must explicitly enable local/custom endpoints and preview origins. Approved provider keys are shared server credentials, so invite only people allowed to consume their quotas. Projects are provisioned by the operator; account separation is application-level, not a separate OS sandbox. Run **one Node process per data directory**; the JSON stores do not support clustered/multiple writers. See [hosting and account provisioning](docs/hosting.md) for configuration and backup instructions.

## Checks

```powershell
npm run build
npm test
npm run test:ui
npm run test:pi
npm run test:production
```

Backend tests cover secret-gated registration, password/session persistence and revocation, CSRF, hosted origins, account and screenshot separation, project/model access limits, traversal, loop bounds, cancellation, API validation, and report evidence. The UI smoke test runs isolated local servers and tests workflow edits, model CRUD, messaging, findings, demo execution, stopping, and responsive layout. It uses installed Microsoft Edge or Playwright Chromium. The Pi smoke test exercises the actual SDK against a local mock OpenAI-compatible endpoint, including real tool calls; it does not call a cloud provider. The production smoke test starts the compiled JavaScript server, verifies hosted login/HTTPS-cookie rules, and restarts it to verify persistent sessions and workspace data.

This version supports one saved workflow per account, parallel agents with joins, model-comparison judging, read-only review, and local screenshots. Conditional routing, scheduled startup, patch-writing agents, and container-isolated test execution are future extensions.
