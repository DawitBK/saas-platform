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
| Take a full backup | `npm run backup`, then copy `.state/backups/<stamp>` off this machine |
| Check the machine and the checkout | `npm run doctor` |

The platform restarts by itself after a crash or a reboot (every long-running service has `restart: unless-stopped`) once Docker Desktop is running. Set Docker Desktop to start when you sign in to Windows and keep the machine awake on mains power (`powercfg /change standby-timeout-ac 0`, lid action "do nothing").

## The visitor sees "demo server is resting"

The portfolio asks a small status function on Vercel whether the platform answers. It says "offline" when the machine is off, asleep or has lost its connection, or when the tunnel is down. Check, in this order:

1. `npm run status`: are the containers healthy? If Docker is not running, start Docker Desktop; the containers return by themselves.
2. `tailscale funnel status`: does it point at `127.0.0.1:<ENTRY_PORT>`? If not: `tailscale funnel --bg 15080`.
3. Is the machine on a stable connection? A phone hotspot drops several times an hour and Tailscale then relays through Europe: expect failures. Use a cable or a router.
4. `npm run smoke:local` proves the platform itself; `npm run smoke` proves the public path.

Note that this machine reaches its own public address over the local network, so a check run on this machine can pass while the internet cannot reach you. The portfolio's status function and `npm run smoke` test from outside.

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
