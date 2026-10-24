# SaaS platform

One repository that runs the whole demo platform on one machine with Docker Compose: an identity provider, a document system, a guest system, four product apps and the database, cache and file storage behind them. Everything the platform needs is in this folder: settings, scripts, Docker setup, runbook. Nothing depends on any other project.

```
visitors ──► portal on Vercel (one address: /sso /dms /gms, and the four apps' own addresses)
                 │  web parts run on Vercel; API calls and sign-in go through the tunnel
                 ▼
          tunnel (Tailscale Funnel) ──► entry (nginx container, 127.0.0.1:ENTRY_PORT)
                                              │ routes by path, nothing else is exposed
          ┌───────────────┬───────────────┬──────┴───────┬───────────────────────────┐
          sso (identity)  gms (guests)    dms (documents) retail · library · martronics · jobpilot (APIs)
          │               │               │ + dms-worker  │
          └───────────────┴───────┬───────┴───────────────┘
                     postgres 18 · valkey · minio  (+ nightly database backup)
```

## Start it

```
npm install
npm run setup        # clones the three systems and the four apps, creates .env
# edit .env: PUBLIC_ORIGIN, BACKEND_ORIGIN, APP_WEB_ORIGINS, DEMO_PASSWORD
npm run up           # configures, builds, migrates, starts everything and waits until it is healthy
npm run status       # what runs and whether it answers
```

After the first `npm run up` there is nothing to start again. Every long-running service has `restart: unless-stopped`, so a crash, a Docker restart or a reboot brings it back by itself as long as Docker Desktop starts when you sign in to Windows. Point your tunnel at the entry: `tailscale funnel --bg 15080` (the value of `ENTRY_PORT`).

There are two ways to start it and they work together. By hand, `npm run up`. Or under pm2 (`npm run pm2:start`, and `npm run pm2:boot` once to do it at every sign-in): pm2 runs `up` for you, waiting for Docker Desktop if it is still starting, and keeps a watchdog running that covers what Docker's own restart does not (a container frozen and reported unhealthy several checks in a row, paused, stopped by mistake, or missing). If a service keeps failing the watchdog stops retrying after three fixes in 30 minutes and says so in `npm run pm2:status` instead of looping. pm2 is a dependency of this repository and keeps its files in `.state/pm2`; nothing is installed globally.

## Commands

| Command | What it does |
| --- | --- |
| `npm run setup` | Clones the three systems and the four apps (branches in `platform.json`) and creates `.env`. Safe to repeat. |
| `npm run configure` | Writes `.state/` from `.env`: data-plane passwords, every secret (generated once, then kept), one env file per service. `up` runs it first. |
| `npm run up` | Configure, build the images, run each system's migration, start everything, wait for health. |
| `npm run down` / `restart` / `logs` | Stop, restart or follow the logs of the whole platform. `npm run restart -- sso` restarts one service. `down` also tells the watchdog (below) that the stop is on purpose; `up` clears that. |
| `npm run pm2:start` / `pm2:stop` / `pm2:status` / `pm2:logs` | Supervision by pm2: starts the platform (waiting for Docker Desktop) and a watchdog that fixes a frozen, paused, stopped or missing container. The applications still run in Docker. `pm2:status` also shows what the watchdog last saw and did. |
| `npm run pm2:boot` / `pm2:unboot` | Windows: start all of that at every sign-in (a scheduled task of your own, no administrator rights), in addition to starting it by hand. |
| `npm run compose -- <args>` | Any `docker compose` command for this project with the settings attached (`-- ps`, `-- exec postgres psql -U postgres`). |
| `npm run status` | Containers, health, and the sign-in document's issuer. Exit code 1 if anything is wrong. |
| `npm run doctor` | Read-only check of this machine and checkout, with what to do about each problem. |
| `npm run smoke:local` | Health of every service through the entry, in seconds. |
| `npm run smoke` | A real browser signs in at the public portal as the sandbox administrator and opens every app, judging by what the page says. Needs `npx playwright install chromium` once. |
| `npm run backup` / `restore` | A full backup now (databases, object storage, the document system's local files, settings and secrets) and a restore of one database from a dump. |
| `npm run owner:enroll` / `owner:status` / `owner:recover` | The identity provider's owner verification (terminal only). |
| `npm run licences:demo` | Demo licences for the three systems, for a sandbox like this one. |
| `npm run seed:visitor` | The public sandbox login: its identity-provider account, and its role in every application. |
| `npm run roles:backfill` | One time, when an application starts being managed from the console: gives the people who already have an account in it the role they hold there, so nobody is locked out. `-- --dry-run` shows what it would write. |
| `npm run test` | Guards: self-contained, no machine paths, compose and routing agree, every app lists its roles. |

## Who may use which application

The identity provider's console decides, for every application that signs in through it (Retail OS, Library, Martronics, JobPilot, MOS), who may sign in and as what. Open a person in the console (Users), choose their role for each application under **Application roles**, and save. **No access** means the application refuses their sign-in and it does not appear on their launcher. The roles on offer for an application are edited on its page under **Applications** (Roles that can be given). Document Management and Guest Management keep their own role screens on the same page.

- The roles come from `platform.json` (`roles` of each app, `externalClients.mos` for MOS) and are seeded when the identity provider starts; roles added or renamed in the console afterwards are never overwritten.
- The application receives the person's roles in the `app_roles` claim at every sign-in. It creates the account the first time (for single sign-on only, no password) and sets the role to the console's every time; a change made in the console signs the person out of that application so it applies at once. Someone switched off inside an application stays switched off.
- MOS never takes the administrator role from the identity provider: that role is granted inside MOS, and the console's `admin` role for MOS only lets the person in.
- Adding an application, or turning this on for one that already has people: list its roles in `platform.json`, run `npm run roles:backfill` **before** `npm run up` (it writes the catalog and the grants while the old provider ignores them), then `npm run up`. Once an application has roles, only people who hold one can sign in to it.

## Where things are

| Path | What |
| --- | --- |
| `compose.yml` | Every service. Only the entry and the data-plane tool ports are published, all on `127.0.0.1`. |
| `platform.json` | Which repositories, internal ports, databases and apps. The one place for these facts. |
| `.env` (not in git) | This machine's settings: public addresses, host ports. `.env.example` explains each one. |
| `.state/` (not in git) | Generated secrets, env files, the owner key, backups. Back it up; without it the data cannot be read. |
| `docker/` | The entry's nginx template, the database init script, the operator-tools image. |
| `scripts/` | The commands above. `scripts/container/` holds scripts that run inside a service's container. |
| `sso-saas/`, `dms-saas/`, `gms-saas/`, `apps/*` (not in this repo) | Each system and app is its own repository, cloned here by `setup`. |

## Why it is built this way

- **Containers, not loose processes.** The services used to be Node processes started from a terminal. A stray Ctrl+C or a missing login ended them and nothing brought them back. Containers restart themselves and do not care about terminals.
- **One door.** Only the nginx entry is published. It looks its upstreams up again every ten seconds, so a service that is recreated is found again without touching nginx.
- **Fixed addresses for the three systems.** Their internal APIs answer only listed callers (an exact-address list; `*` is refused in production). The platform network has a fixed range (`PLATFORM_SUBNET`), so the identity provider's list is exactly the guest system, and so on.
- **The apps reach the identity provider directly.** `OIDC_INTERNAL_URL` keeps server-to-server sign-in calls on the platform network, so a wobble in the public tunnel cannot break them. The public address is still what people use and what tokens carry.
- **Honest health.** `npm run status` and `npm run smoke` read what pages and APIs say, not just status codes or addresses.

## Moving to another machine

Clone this repository, run `npm install`, `npm run setup`, fill in `.env`, then `npm run up`. On an empty machine that gives running services with migrated, empty databases: no users, no registered apps. Creating the first accounts and registering the apps with the identity provider is not automated yet (`npm run bootstrap` is not written). The supported way to move a working platform is to carry its data across: copy `.state/` (secrets, owner key) from the old machine, restore the dumps (`npm run restore`) and the `miniodata.tgz` and `dmsstorage.tgz` volumes from `npm run backup`, then `npm run up`. The databases are not portable without `.state/secrets.json`: encrypted documents cannot be read without it.

## What is not in git, on purpose

`.env`, `.state/` (secrets, env files, owner key, licence key, backups), the cloned repositories, Docker volumes (databases, object storage), the Vercel account and project settings, and the tunnel's configuration. The runbook (`docs/RUNBOOK.md`) lists each with what happens if it is lost.
