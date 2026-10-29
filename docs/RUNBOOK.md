# Runbook

Everyday operation, what to do when something breaks, and what lives only on this machine. Commands are npm scripts in this folder (see the README for the full list).

## Everyday

| I want to | Do this |
| --- | --- |
| See whether it is healthy | `npm run status` |
| See it as a visitor does | `npm run smoke` (real browser, judges by page content) |
| Read what a service says | `npm run logs -- sso` (or `gms`, `dms`, `retail`, `entry`, `postgres`, ...) |
| Restart one service | `npm run restart -- sso` |
| Update after a `git pull` in a system or app | `npm run up` (rebuilds what changed, migrates, restarts) |
| Stop everything | `npm run down` (data is kept in Docker volumes) |
| Put the public demo login back to a known state | `npm run seed:visitor` |
| Fill Retail OS with six months of connected demo trading | `npm run seed:retail` (repeatable; see "Retail OS demo data" below) |
| Take a full backup | `npm run backup`, then copy `.state/backups/<stamp>` off this machine |
| Check the machine and the checkout | `npm run doctor` |

The platform restarts by itself after a crash or a reboot (every long-running service has `restart: unless-stopped`) once Docker Desktop is running. Set Docker Desktop to start when you sign in to Windows and keep the machine awake on mains power (`powercfg /change standby-timeout-ac 0`, lid action "do nothing").

## What recovers by itself, and what does not

| Situation | What happens |
| --- | --- |
| A service crashes or exits | Docker starts it again within seconds (measured: about 8 s to healthy). |
| Docker Desktop restarts, or the machine reboots and you sign in | Everything that was running comes back (Docker Desktop starts at sign-in on this machine). |
| A service hangs without exiting | Without pm2 it is not restarted: Docker only marks it unhealthy (`npm run status` shows it; `npm run restart -- <service>` fixes it). With pm2 running (`npm run pm2:status` says "watchdog: ok"), the watchdog restarts it after three unhealthy checks in a row (about a minute). |
| You run `docker stop` or `docker kill` on a container | Without pm2 it stays down on purpose (that is what `unless-stopped` means; `npm run up` starts it again). With pm2 running the watchdog starts it again within about a minute: to keep the platform off, use `npm run down`, which tells the watchdog it is on purpose. |
| A service keeps failing | The watchdog gives up after three fixes in 30 minutes and shows an ALERT in `npm run pm2:status`; read `npm run logs`. |
| You sign in to Windows after a restart | If `npm run pm2:boot` was run once, a scheduled task (SaaS-Platform-PM2) starts the platform and the watchdog 90 seconds later. |
| The machine sleeps or loses its connection | Nothing is wrong with the platform, but visitors cannot reach it: see the next section. |

## The visitor sees "demo server is resting"

The portfolio asks a small status function on Vercel whether the platform answers. It says "offline" when the machine is off, asleep or has lost its connection, or when the tunnel is down. Check, in this order:

1. `npm run status`: are the containers healthy? If Docker is not running, start Docker Desktop; the containers return by themselves.
2. `tailscale funnel status`: does it point at `127.0.0.1:<ENTRY_PORT>`? If not: `tailscale funnel --bg 15080`.
3. Is the machine on a stable connection? A phone hotspot drops several times an hour and Tailscale then relays through Europe: expect failures. Use a cable or a router.
4. `npm run smoke:local` proves the platform itself; `npm run smoke` proves the public path.
5. Read what the status function itself says: `https://<portfolio address>/api/demo-status` carries `checks`, what each of its two checks (the identity service's health and an app's sign-in settings) saw.

| `checks` says | Meaning | Do |
| --- | --- | --- |
| `timeout` | Vercel cannot reach the machine at all. | Is it on, awake and online? Step 3. |
| `ECONNRESET` (or `unreachable`), both checks, while `npm run status` is fine | The tunnel answers and closes the connection: its link to this machine is stale. This happens after the Wi-Fi changes address (a hotspot reconnecting). | `tailscale down`, then `tailscale up`. It recovers within a minute (measured 2026-10-24: offline for 5 minutes, back at once). |
| `502` | The tunnel is up but nothing answers behind it. | `tailscale funnel status` (step 2), then `npm run status`. |
| `health` 200, `signIn` 503 | The identity service answers but an app cannot reach it. | `npm run logs -- sso`, then `npm run restart -- sso`. |
| `signIn` 200 but `online` is false | The app's sign-in settings say single sign-on is off. | Check the app's OIDC settings in `.state/env/<app>.env`. |

Note that this machine reaches its own public address over the local network, so a check run on this machine can pass while the internet cannot reach you (this is exactly what the table's second row looks like from here). The portfolio's status function and `npm run smoke` test from outside.

## Sign-in says "not licensed" (403 LICENSE_REQUIRED)

In production mode every system is unusable until it holds a valid licence. On this demo platform: `npm run licences:demo` (once), then `npm run up`. A real deployment gets its licences from the owner through the identity provider's console (with owner verification) or by signing offline; `licences:demo` is for a sandbox only and says so in every record it writes.

## Owner verification

The identity provider asks for the owner's proof before key, licence, platform-setting and identity-administrator changes. First time: `npm run owner:enroll` in a real terminal (three security questions, the mailbox, ten recovery codes shown once: write them down). Without a configured mail server the recovery codes stand in for the emailed code, one per owner-only action; `npm run owner:recover` makes a new set. `npm run owner:status` shows whether the owner is enrolled and how many codes are left. Back up `.state/owner/owner-store.key` apart from the database: without it the stored answers cannot be checked.

## What is not in git, and what happens if it is lost

| Item | Where | If it is lost |
| --- | --- | --- |
| `.env` | this folder | Re-create from `.env.example`: addresses and ports only, no secrets. |
| Generated secrets and env files | `.state/secrets.json`, `.state/infra.env`, `.state/env/` | New ones are generated, but anything encrypted with the old ones (documents, the sealed owner store) cannot be read. Back up `.state/`. |
| Owner key | `.state/owner/owner-store.key` | The owner's answers and recovery codes cannot be checked: `npm run owner:recover`. |
| The owner's recovery codes | on paper | No fallback while email is unavailable. |
| Licence key | `.state/licence/` | `npm run licences:demo` makes a new one. |
| Databases and object storage | Docker volumes | Restore from `.state/backups` (`npm run restore -- <dump>`), plus `miniodata.tgz` from `npm run backup`. |
| The cloned systems and apps | `sso-saas/`, `dms-saas/`, `gms-saas/`, `apps/*` | `npm run setup` clones them again. |
| Vercel account and projects | vercel.com | The projects can be recreated; `npm run deploy:vercel` fills them. |
| The tunnel | Tailscale (`tailscale funnel status`) | Re-run `tailscale funnel --bg <ENTRY_PORT>`; if the public address changes, update `BACKEND_ORIGIN` in `.env`, run `npm run up` and `npm run deploy:vercel -- portal`, and update `DEMO_HEALTH_URL` on the portfolio's Vercel project. |

## Safety rules this platform keeps

- Only the nginx entry and the data-plane tool ports are published, and only on `127.0.0.1` (a test enforces it).
- No service keeps a secret in a file inside a repository: secrets live in `.state/`, which is never committed.
- The three systems' internal APIs answer only their listed callers, which have fixed addresses on the platform network.
- Migrations run as a one-shot job before a service starts; a failed migration stops the service from starting.

## Retail OS demo data

`npm run seed:retail` runs the app's own `seed:demo` command in a one-off container (`--no-deps`, production guard acknowledged with `--allow-production` because this database holds demo data on purpose). It replays 180 days of trading through the same services the API uses, so stock, books and reports agree, and it checks its own result before it says it is finished. Details: `apps/retail-os/docs/demo-data.md`.

- Safe to repeat: a finished seed changes nothing; an interrupted one resumes from the database.
- It never deletes or edits existing records. It needs an owner, manager, accountant and cashier to exist in Retail OS (the sandbox people are copied there when the database is rebuilt).
- It needs a database where the history can start before any other entry. On a database that already holds an older, thinner demo (the sandbox did, from the earlier seed), seeding on top would put six months of trading before an opening balance dated later. Start such a database afresh instead, keeping the old one: back up (`npm run backup`), stop `retail`, rename `retail_os` to a dated name in `psql -U postgres` (`alter database retail_os rename to ...`), create a new `retail_os` owned by role `retail_os`, start `retail` (its migration job builds the tables), copy the people over (`pg_dump --data-only -t users` from the old database), then run `npm run seed:retail`. Going back is the rename the other way.
- After a restore of the Retail OS database, run `npm run seed:visitor` as well so the public login exists.
