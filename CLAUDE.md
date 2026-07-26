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
