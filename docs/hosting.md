# Host Crawlspace on Ubuntu

Crawlspace serves its built React interface and authenticated API from one Node process. Node 24 is recommended; the minimum version is 22.19. Run one process against each data directory: the JSON account, session, and workspace stores do not support multiple writers or replicas. An HTTPS reverse proxy is required for a public production installation.

Choose either the systemd installation below or Docker Compose. Both examples leave Node port 3001 reachable only from the server and expose HTTPS through Nginx. These files prepare a deployment; they do not create a domain, certificate, or running public service.

## Configure registration and login

Copy `.env.example` to your deployment environment file. Set `CRAWLSPACE_PUBLIC_URL` to the exact public origin, for example `https://crawl.example.com`, with no path. Production rejects non-HTTPS public origins. Use the same hostname in Nginx and in the browser.

Generate the account creation secret on your server:

```sh
openssl rand -hex 32
```

Put the output in `CRAWLSPACE_REGISTRATION_SECRET`. Anyone with this secret can create an account; each account subsequently signs in with its own username and password. Share the secret privately with the people you want to invite. To close registration, clear this setting and restart the service. Rotating it changes who can register without changing existing passwords or sessions.

Do not place this secret or provider API keys in a `VITE_` variable. Those variables are included in browser bundles. Protect the environment file from other local users and exclude it from source control. The example deliberately leaves registration closed until you choose a secret.

Important environment settings:

| Setting | Purpose |
| --- | --- |
| `NODE_ENV=production` | Enables production startup checks. |
| `CRAWLSPACE_PUBLIC_URL` | Browser origin used by Host/Origin checks and secure cookies. |
| `CRAWLSPACE_REGISTRATION_SECRET` | Shared invitation secret; empty disables account creation. Use at least 32 random characters. |
| `CRAWLSPACE_HOST` | Node bind address. Use `127.0.0.1` with host Nginx, `0.0.0.0` inside Docker. |
| `CRAWLSPACE_PORT` | Node listen port, default 3001. |
| `CRAWLSPACE_DATA_DIR` | Persistent account, session, workflow, finding, and screenshot storage. |
| `CRAWLSPACE_TRUST_PROXY` | `loopback` for the supplied host Nginx/systemd layout; `false` for the supplied Compose layout. Never blindly trust all proxy headers. |
| `CRAWLSPACE_MODEL_KEY_ALLOWLIST` | Comma-separated provider key variable names accounts may select; defaults to `ANTHROPIC_API_KEY,OPENAI_API_KEY`. Do not include server secrets. |
| `CRAWLSPACE_MODEL_ENDPOINT_ORIGINS` | Additional approved model API origins, for example `http://127.0.0.1:11434`. Production requires explicit approval for local/custom endpoints. Built-in provider origins remain available. |
| `CRAWLSPACE_PREVIEW_ORIGINS` | Exact approved screenshot preview origins, for example `http://127.0.0.1:4173`. Production permits only listed loopback origins. |

Cookies are HTTP-only and are marked Secure for a public HTTPS origin. TLS terminates at Nginx. The registration secret is checked by the server and never returned to the browser. A missing secret does not disable login for existing accounts.

## Ubuntu with systemd

The commands below assume Node 24 and npm are already installed, `/usr/bin/node` is the installed Node binary, and this repository has been copied to `/opt/crawlspace`. Adjust `ExecStart` in `deploy/crawlspace.service` if Node is installed elsewhere. Build dependencies are needed during installation, even though production starts the bundled JavaScript server.

```sh
cd /opt/crawlspace
npm ci
npm run build
npm prune --omit=dev

sudo useradd --system --home-dir /var/lib/crawlspace --shell /usr/sbin/nologin crawlspace
sudo install -d -o crawlspace -g crawlspace -m 700 /var/lib/crawlspace
sudo install -d -o root -g root -m 700 /etc/crawlspace
sudo install -o root -g root -m 600 .env.example /etc/crawlspace/crawlspace.env
sudoedit /etc/crawlspace/crawlspace.env
```

Edit the environment file to set the domain and generated secret. Leave the data directory `/var/lib/crawlspace`, host `127.0.0.1`, and trust proxy `loopback` for this layout. Keep the application code and `node_modules` readable by the service account and writable only by the deployment administrator.

For screenshot agents, install Chromium's Ubuntu libraries as an administrator and the browser files as the service account:

```sh
cd /opt/crawlspace
sudo ./node_modules/.bin/playwright install-deps chromium
sudo -u crawlspace env PLAYWRIGHT_BROWSERS_PATH=/var/lib/crawlspace/browsers ./node_modules/.bin/playwright install chromium
```

The service sets the same `PLAYWRIGHT_BROWSERS_PATH`. Reinstall browsers after changing the locked Playwright version; each version requires matching browser binaries. See the [Playwright browser installation guide](https://playwright.dev/docs/browsers).

Install and start the service:

```sh
sudo install -o root -g root -m 644 deploy/crawlspace.service /etc/systemd/system/crawlspace.service
sudo systemctl daemon-reload
sudo systemctl enable --now crawlspace
sudo systemctl status crawlspace
sudo journalctl -u crawlspace -n 100 --no-pager
```

The service runs as the dedicated `crawlspace` account, restricts writes to its data directory and private temporary directory, and restarts after a process failure. The workflow engine does not automatically resume an interrupted run.

## Docker Compose

Docker and the Compose plugin must already be installed. From the repository root:

```sh
cp .env.example .env
chmod 600 .env
# Edit .env: set the real HTTPS public URL and a generated registration secret.
docker compose -f deploy/compose.yml build
docker compose -f deploy/compose.yml up -d
docker compose -f deploy/compose.yml logs --tail=100
```

The image uses a Node 24 build stage, installs production dependencies and matching Playwright Chromium binaries, then runs as the non-root `node` user. The Compose file provides an init process, shared memory for Chromium, a health check, and a persistent `crawlspace-data` volume at `/data`. Installing the browser libraries follows [Playwright's supported Docker setup](https://playwright.dev/docs/docker). The image has no registration secret baked into it.

Compose overrides the host environment's bind address, port, data directory, and proxy trust. Its published port is `127.0.0.1:3001` on the Ubuntu host. Use the Nginx configuration below. Forwarded IP headers are deliberately ignored in this layout because the connection crosses Docker's bridge; rate limiting may group all users behind that bridge address. Cookies use the configured public HTTPS origin regardless of proxy trust.

`127.0.0.1` in a container refers to that container. Local model servers and screenshot preview apps on the Ubuntu host are therefore not reachable at that address from Docker. Screenshot previews currently require an explicit loopback URL and must run in the same network namespace; the default image does not run your target application's dev server. The native systemd layout is simpler when reviewing UIs already running on the Ubuntu host. A reachable cloud model endpoint works in either layout.

To rebuild after updating code, use `docker compose -f deploy/compose.yml up -d --build`. Never run `docker compose down -v` if you need to retain accounts, sessions, and workspaces.

## Nginx and HTTPS

Point your domain's DNS at the server and obtain a TLS certificate using your normal certificate tooling. Edit `deploy/nginx.conf` to use your domain and existing certificate/key paths. The file expects certificates under `/etc/letsencrypt/live/crawl.example.com/`; it does not obtain or renew them.

```sh
sudo install -o root -g root -m 644 deploy/nginx.conf /etc/nginx/sites-available/crawlspace
sudo ln -s /etc/nginx/sites-available/crawlspace /etc/nginx/sites-enabled/crawlspace
sudo nginx -t
sudo systemctl reload nginx
```

Remove any conflicting virtual host through your normal server configuration process. Allow inbound TCP 80 and 443 at your firewall. Keep Node port 3001 and model/preview ports private. HTTP redirects to HTTPS; the HTTPS proxy overwrites forwarded headers instead of accepting values supplied by clients.

This Nginx example uses public HTTPS port 443. Set `CRAWLSPACE_PUBLIC_URL=https://crawl.example.com` (not the internal Node port `:3001`); an explicit `:443` is normalized to the same origin. For a different public HTTPS port, adjust both the Nginx listener and its forwarded Host value to preserve that port.

Open the configured public URL, choose **Create account**, and use the registration secret. Create a second account if needed to verify each account opens its own workflow and findings. A request for `/api/state` without a login should return 401. A successful health check only proves that the server responds; it does not prove models are configured or a workflow can run.

## Account workspaces and models

Account data is separated beneath `CRAWLSPACE_DATA_DIR/users/<account-id>/`. Each account has its own `state.json`, screenshots, and temporary Pi session files. The server restricts project selection to that account's `projects/` directory. The browser's workflow settings show its allowed project root.

Provision project checkouts as the server administrator underneath that root after the account exists. Use the account ID from the authenticated interface and make the source readable by the service account. For example, with the native installation:

```sh
sudo -u crawlspace mkdir -p /var/lib/crawlspace/users/ACCOUNT_ID/projects
# Place a trusted checkout at .../projects/my-repo and choose that absolute path in workflow settings.
```

For Docker, the account's project root is `/data/users/ACCOUNT_ID/projects` inside the persistent volume. Provision code into the matching volume directory; paths entered in the UI use the container path. Outside-directory paths and symlinks escaping the provisioned root are rejected. Do not place server environment files, provider keys, or unrelated private data inside an account's project directory.

Provider credentials are configured by the server operator. Set the key in the private environment file, and allow only its variable name in `CRAWLSPACE_MODEL_KEY_ALLOWLIST`. Model definitions hold that allowed environment variable name, never the key itself. Built-in provider endpoints are accepted; list every additional model endpoint origin in `CRAWLSPACE_MODEL_ENDPOINT_ORIGINS`. List local preview origins in `CRAWLSPACE_PREVIEW_ORIGINS` before screenshot runs. An origin includes the scheme, hostname, and port but no path (the model base URL in the interface may still include `/v1`). Restart after changing these settings. Only approve model servers you trust with the selected provider credentials and reviewed source. This is a trusted team service: server-provided model credentials are shared operating resources, and members can consume their quota. Authentication and project confinement do not provide per-agent containers, per-account operating-system isolation, billing quotas, or a sandbox for executing untrusted projects. Real agents remain read-only; preview apps must be started separately by the operator.

## Backups, updates, and recovery

Back up the entire persistent data directory, not just `state.json`. It contains the account/password database, persisted sessions, account workspaces, and screenshot evidence. Treat backups as private. Stop the service while taking a consistent filesystem backup (`systemctl stop crawlspace` or `docker compose -f deploy/compose.yml stop`) and start it afterward. Keep the environment file and TLS certificate recovery procedure separately.

For native updates, stop the service, update the checkout, run `npm ci`, `npm run build`, and `npm prune --omit=dev`, reinstall matching Chromium files when Playwright changes, then start the service. Avoid running two copies against the same data directory during upgrades.

If an administrator rotates the registration secret, restart the process to load it. There is currently no email delivery, password-reset flow, MFA, account-administration interface, or distributed session/database service. Do not manually edit account/session JSON while the server is running.


