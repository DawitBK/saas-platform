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

## The sign-in portal works on one network and not on another

Nothing is wrong with the platform when this happens: it answers in milliseconds on this machine. What changes is the road from the internet to the laptop. The public address is a Tailscale Funnel; on a pocket 4G router (no IPv6, a strict NAT) Tailscale cannot make a direct path and relays through Europe (about 140 ms away, with stalls of 10 to 20 seconds). A phone hotspot is less strict, so it works there.

**Network watch** (runs with `npm run pm2:start`, or alone with `npm run pm2:watch`) asks every 10 seconds: the platform here, the public tunnel (through Tailscale's real addresses), the Vercel portal, and the sign-in discovery document. It also records the Wi-Fi name, signal, address and Tailscale's own health once a minute.

| What | Command or place |
| --- | --- |
| Outages and availability, per Wi-Fi network | `npm run netwatch:report` (last 24 h) or `npm run netwatch:report -- 3` (last 3 h) |
| Right now | `.state/netwatch.json` (and `npm run pm2:logs`) |
| Every round, kept 14 days | `.state/logs/netwatch-YYYY-MM-DD.jsonl` (`kind: probe`, `net`, `heal`) |

**What heals by itself.** When the platform answers here but the tunnel does not for three rounds (30 seconds), the watch nudges Tailscale: first new sockets and a fresh look at the network (`tailscale debug rebind`, `restun`), and only if that did not help, a full `tailscale down` and `up`. Never more than once in 3 minutes, and not when the cause is public DNS. Turn it off with `NETWATCH_HEAL=off` in `.env`. Each nudge is a `heal` line in the log, so the report can be compared with what was done.

**What the edge keeps.** Vercel keeps a copy of the sign-in discovery document and the signing keys (`/sso/.well-known/*`, `/sso/jwks`): fresh 5 minutes, then served stale for a day while it re-checks, and stale if the tunnel is down. MOS, DMS, GMS and the apps read those two documents; a stall no longer stops them. Logging in itself (the password step) still needs the tunnel.

**What only a different road fixes.** A stable public address needs a path that does not depend on this laptop's NAT: a Cloudflare Tunnel (needs a Cloudflare account and a domain), or hosting the platform on a server. Until then, use the phone hotspot (or USB tethering) as the laptop's uplink when it matters, or turn IPv6 on in the router if it has the setting.

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
- Done on 2026-10-31 for the sandbox: dump at `.state/backups/retail-before-demo-20261031/retail_os.dump`, old database kept as `retail_os_before_demo_20261031` (drop it once nobody wants it), new `retail_os` seeded (1,890 sales over 180 days, all five self-checks passed, a second run changed nothing), Retail OS web part redeployed to Vercel, `npm run smoke` and a page-by-page check of the new screens passed.

## Live updates in DMS and GMS (socket.io) on Vercel

Vercel can forward ordinary requests to this machine but cannot pass a WebSocket upgrade. The document and guest front ends are therefore built with `NEXT_PUBLIC_SOCKET_TRANSPORTS=polling` (set by `npm run configure`, written to `.state/env/frontends/`), so the browser uses long polling straight away instead of trying a WebSocket that is certain to fail and logging an error on every page. Without that setting (any other host) the front ends keep their default, WebSocket first with polling as the fallback.

The portal forwards `/socket.io/` and `/dms/socket.io/` to the entry. Both spellings are listed on purpose: the socket.io browser client always asks for the path with a trailing slash, and until 2026-10-31 that form was not forwarded, so live updates never connected on the hosted sandbox (the old WebSocket error hid it). Check after any portal change: `curl "https://<portal>/dms/socket.io/?EIO=4&transport=polling"` must answer 200 with a `sid`, and a signed-in browser should show a `40{"sid":...}` answer on the same path.
