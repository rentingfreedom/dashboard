@AGENTS.md
@docs/n8n-workflows.md

## Account identity
- GitHub owner: rentingfreedom (repo transferred; push access via CompoundConsultingAI collaborator account)
- Git user.email: 284657484+CompoundConsultingAI@users.noreply.github.com
- Vercel scope: renting-freedom (client-owned team — production target for dashboard.rentingfreedom.com)
- Vercel project: dashboard
- Category: consulting

NOTE: `.vercel/project.json` in this repo is STALE — it still links to
`compound-consulting-s-projects/rf-dashboard` (a leftover pre-handoff
project), not the client's `renting-freedom/dashboard`. The CLI on this
machine (logged in as compoundconsultingai) has no access to the
`renting-freedom` team, so it cannot deploy or relink here. Production
deploys must be triggered manually from vercel.com/renting-freedom/dashboard
(client's own login) until this is resolved. Do not run `vercel --prod` /
`vercel link` from this machine against this repo without re-confirming
which team it targets first.

## n8n VPS access
- Host: Hostinger VPS `srv1743791`, IP `2.25.189.184` (automation.rentingfreedom.com).
  This project's own server, NOT the Hermes or Stonk VPS — never use those keys here.
- SSH: `ssh rf-vps` (alias in `~/.ssh/config` → `root@2.25.189.184`, key
  `~/.ssh/rentingfreedom_vps`). Key installed via the Hostinger panel 2026-10-22;
  revoke it there. Root password login also exists but isn't usable from Claude.
- Stack: Docker containers `n8n` (n8nio/n8n:stable), `n8n-postgres` (postgres:16),
  `n8n-caddy` (caddy:2). Host DNS is systemd-resolved (upstreams 153.92.2.6,
  1.1.1.1, 8.8.4.4); the n8n container resolves via Docker's 127.0.0.11.
- Read-only diagnostics are fine without asking: `uptime`, `docker ps`,
  `docker logs n8n --since …`, `journalctl` (dockerd `[resolver]` errors = DNS
  trouble; `systemd-resolved` "degraded feature set" = upstream unreachable),
  `sar -n EDEV` (sysstat is collecting). **Ask before** restarting containers,
  editing config, or running updates — this box runs every production workflow.
- Outage history: 2026-10-20 21:10–21:26 UTC (outbound network loss, all three
  DNS upstreams unreachable) and 2026-10-22 10:45–10:54 UTC (TCP timeouts to
  Google). Host itself was healthy both times — provider network.
