# Crawlspace

A local workspace for a small team of code-review agents. Build a workflow with React Flow, give each agent a persona and responsibilities (*vastuualueet*), choose its model, and let the team review a codebase in repeated passes.

## Run locally

Requires Node.js **22.19 or later** (Node 24 works).

```powershell
npm install
npm run dev
```

Open the Vite URL printed in the terminal (normally `http://127.0.0.1:5173`). The API listens on `127.0.0.1:3001`. Vite selects another frontend port when needed.

For a single production server:

```powershell
npm run build
npm start
```

Then open `http://127.0.0.1:3001`. Set `CRAWLSPACE_PORT` to change the production/API port; update the development proxy in `vite.config.ts` if changing it during development.

## What works

- Add, move, connect, duplicate, and remove agents on a React Flow canvas.
- Configure a persona, instructions, model, responsibilities, and screenshot capability for each node.
- Create/edit models for Anthropic, OpenAI, Ollama, and other OpenAI-compatible endpoints. Declare whether each model accepts images.
- Execute a single pass, a bounded loop, or a loop that continues until stopped.
- Share messages, directed assignments, findings, and a staff directory between agents.
- Track finding severity and resolution, inspect screenshot evidence, and review run history.
- Save workflows, models, conversations, findings, and runs on the local machine.

The default **demo** executes the graph without a model connection. All demo activity and findings are labeled; the demo does not inspect files or take screenshots.

## Connect Pi and real models

The current upstream Pi project is [earendil-works/pi](https://github.com/earendil-works/pi), formerly `badlogic/pi-mono`. Its SDK (`@earendil-works/pi-coding-agent`) is included as a dependency. Crawlspace owns workflow scheduling and shared state; Pi executes each agent visit. See the [official SDK docs](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md).

1. Open **Models**, select your provider and its exact model ID, and set the endpoint when using Ollama or a compatible server. Endpoints usually include `/v1`.
2. For cloud models, enter an **environment variable name**, and set its value in the shell before starting the server. Credentials are not entered in the browser or saved in workflow JSON.
3. Open **Workflow settings**, enter an absolute project path, and choose **Pi harness — real agents**.
4. For UI agents, start the target app, set its local preview URL, and select an image-capable model.
5. Save and run the workflow.

Example PowerShell setup:

```powershell
$env:ANTHROPIC_API_KEY = "your-key"
npm run dev
```

For Ollama, start Ollama separately, pull the model you selected (for example `qwen3:8b`), and use `http://127.0.0.1:11434/v1`. Text-only models can review code; screenshot agents require an image-capable model.

Install the screenshot browser once:

```powershell
npx playwright install chromium
```

## Execution semantics

Graph edges determine a deterministic breadth-first traversal from the entry agent. Each reachable node executes once per cycle; a return edge is permitted and does not recurse within the same cycle. All agents must be connected to the entry agent before saving. Branches and joins are sequential in this first version. The next cycle starts after the configured pause. Single-pass mode ignores return edges after each node has been visited.

Each visit starts a fresh Pi session with its persona, prompt, responsibilities, staff directory, relevant recent messages/assignments, and existing findings. The agent can consult `list_staff`, inspect files, and capture a local UI when enabled. It returns a validated JSON report; findings and assignments are added to shared state for subsequent agents. Assignments supply context; they do not change the execution order or bypass graph connections. This is asynchronous collaboration between visits, rather than simultaneous chat between independent processes.

Real agents have read-only tools confined to the selected project. Canonical paths reject traversal and outside-project symlinks; credential files, generated directories, large files, and binary files are excluded. Code findings must cite inspected files. Agents inspect tests but do not execute test commands or edit code. Built-in Pi shell/edit tools, repository instructions, extensions, and skills are disabled for these sessions.

Each agent visit has a three-minute and 40-tool-call limit. A provider error or invalid report fails the run and is visible in history. Stop cancels active model work and pending cycle timers. A server restart marks interrupted runs stopped; automatic restart/resume is not implemented.

Screenshots use Playwright at a 1440×1000 viewport. Preview URLs must use an explicit loopback host (`localhost`, `127.0.0.1`, or `[::1]`); requests to other origins, service workers, and WebSockets are blocked. This can leave externally hosted assets or live data absent from a screenshot. The target application must already be running.

Data lives in `.crawlspace/state.json`, Pi configuration in `.crawlspace/pi/`, and screenshot evidence in `.crawlspace/screenshots/`. The backend binds to loopback and checks local Host/Origin headers. This version is intended for one local user, not a remotely exposed multi-user service.

## Checks

```powershell
npm run build
npm test
npm run test:ui
npx tsx scripts/pi-smoke.ts
```

Backend tests cover traversal, loop bounds, cancellation, persistence, API validation, path confinement, and report evidence. The UI smoke test runs isolated local servers and tests workflow edits, model CRUD, messaging, findings, demo execution, stopping, and responsive layout. It uses installed Microsoft Edge or Playwright Chromium. The Pi smoke test exercises the actual SDK against a local mock OpenAI-compatible endpoint, including real tool calls; it does not call a cloud provider.

This first version supports one saved workflow, sequential agents, read-only review, and local screenshots. Conditional routing, parallel workers, scheduled startup, patch-writing agents, and container-isolated test execution are future extensions.
