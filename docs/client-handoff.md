# Client Handoff: Renting Freedom Dashboard

Transferring the `rf-dashboard` project to the client and deploying to `dashboard.rentingfreedom.com`.

---

## Prerequisites

Client needs to create two accounts before anything else:

- [ ] **GitHub account** — github.com/signup
- [ ] **Vercel account** — vercel.com/signup (sign up with GitHub for easiest integration)

---

## Step 1: Transfer GitHub Repo

1. Go to the repo: `github.com/CompoundConsultingAI/rf-dashboard`
2. **Settings** → scroll to **Danger Zone** → **Transfer ownership**
3. Enter the client's GitHub username and confirm
4. The repo moves to his account with all history intact
5. GitHub sets up an automatic redirect from the old URL

> The repo can stay **Private** — no need to make it public. Do not fork; transfer is the right move.

---

## Step 2: Set Up Vercel

**Option A — Fresh project (recommended, cleaner):**
1. Client logs into Vercel
2. **Add New Project** → Import from GitHub → select `rf-dashboard`
3. Framework preset: Next.js (auto-detected)
4. Add all environment variables (see below before doing this)

**Option B — Transfer existing Vercel project:**
1. In your Vercel account, go to the project → **Settings** → **Transfer Project**
2. Enter the client's Vercel account email

---

## Step 3: Environment Variables

Before transferring, export all current env vars from your Vercel project so nothing is lost.

1. Go to your Vercel project → **Settings** → **Environment Variables**
2. Copy every key/value
3. Re-enter them all in the client's new Vercel project

> This step is easy to forget and will cause the deployed app to break silently.

---

## Step 4: Add the Custom Domain

Do this **after** the Vercel project is set up under the client's account.

1. In the client's Vercel project → **Settings** → **Domains**
2. Add `dashboard.rentingfreedom.com`
3. Vercel will display the required DNS record — typically:
   - **Type:** CNAME
   - **Name:** `dashboard`
   - **Value:** `cname.vercel-dns.com`

---

## Step 5: Add DNS Record

Go to wherever `rentingfreedom.com` DNS is managed (GoDaddy, Cloudflare, Namecheap, etc.) and add the record from Step 4.

> Not sure who manages the DNS? Run `nslookup -type=SOA rentingfreedom.com` to find the authoritative nameserver.

DNS propagation usually takes a few minutes to an hour. Vercel auto-provisions an SSL certificate once it resolves.

---

## Checklist Summary

- [ ] Client creates GitHub account
- [ ] Client creates Vercel account (via GitHub)
- [ ] Export env vars from current Vercel project
- [ ] Transfer GitHub repo to client's account
- [ ] Client creates new Vercel project connected to his repo
- [ ] Re-enter all environment variables in new Vercel project
- [ ] Add `dashboard.rentingfreedom.com` in Vercel domains
- [ ] Add CNAME record in DNS registrar
- [ ] Verify site loads at `dashboard.rentingfreedom.com`
