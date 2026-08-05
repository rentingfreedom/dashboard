# Creating a Google Cloud service account JSON key when Organization Policy blocks it

Needed when adding a new Google Sheets service account credential — e.g. splitting Sheets API quota across
multiple GCP projects (see `docs/n8n-workflows.md` → "Backing Google Sheet" / the Sheets quota gotcha).
Each project has its own service account tied to the same spreadsheet, sharing it as Editor.

## The error

Google Cloud Console shows:

> Service account key creation is disabled

and identifies the enforced policy:

```
iam.disableServiceAccountKeyCreation
```

This is the **legacy** organization-policy constraint. It is separate from the newer managed constraint
`iam.managed.disableServiceAccountKeyCreation` — changing the managed one does not remove the legacy one
that is actually blocking the key.

## Prerequisites

- `roles/orgpolicy.policyAdmin` — to modify organization policy for the project.
- `roles/iam.serviceAccountKeyAdmin` — to create the key itself.

Only create a JSON key when the application can't use a more secure method (service-account impersonation,
Workload Identity Federation). Scope the policy exception to the specific project that needs it, not the
whole org.

## Steps

1. **Select the correct project** in Cloud Console. Note the **Project ID** (e.g.
   `rentingfreedom-n8n-504012`), not just the display name.

2. **Activate Cloud Shell** (`>_` icon, top-right). It's pre-authenticated with the signed-in Google account
   — no local `gcloud` install needed.

3. **Confirm/set the active project**:
   ```bash
   gcloud config get-value project
   gcloud config set project YOUR_PROJECT_ID
   ```

4. **Disable the legacy key-creation policy for this project only**:
   ```bash
   gcloud resource-manager org-policies disable-enforce \
     iam.disableServiceAccountKeyCreation \
     --project=YOUR_PROJECT_ID
   ```
   Success looks like `booleanPolicy: {}` — an empty policy means enforcement is off at the project level.
   This creates a project-specific exception, not an org-wide change.

5. **Verify**:
   ```bash
   gcloud resource-manager org-policies describe \
     iam.disableServiceAccountKeyCreation \
     --project=YOUR_PROJECT_ID
   ```

6. **Wait ~5–15 minutes for propagation**, then refresh the browser before retrying.

7. **Create the JSON key in the console**: IAM & Admin → Service Accounts → select account → Keys tab →
   Add key → Create new key → JSON → Create. The file downloads once — Google does not let you download the
   private key again later.

8. **Store the key securely**: treat it like a password. Never commit it to Git, place it in a public
   folder, email it unsecured, or include it in screenshots/support messages. Delete unused or exposed keys
   promptly.

### Optional: create the key via Cloud Shell instead of the console

If the console still fails, Cloud Shell usually surfaces a more specific error:

```bash
gcloud iam service-accounts list --project=YOUR_PROJECT_ID

gcloud iam service-accounts keys create service-account-key.json \
  --iam-account=SERVICE_ACCOUNT_EMAIL \
  --project=YOUR_PROJECT_ID
```

The file lands in the Cloud Shell home directory — download it via the Cloud Shell menu.

## Common errors

**Permission denied while changing the policy** (`orgpolicy.policy.set` / `orgpolicy.policies.create` denied)
— your account needs `roles/orgpolicy.policyAdmin`, granted at a level that applies to the project.

**Policy shows disabled but key creation is still blocked** — double check the error dialog names
`iam.disableServiceAccountKeyCreation`, not `iam.managed.disableServiceAccountKeyCreation` (they're separate
constraints). Also confirm: the command targeted the right project, propagation time has passed, the page
was refreshed, and no separate custom org policy is also blocking it.

**Key creation permission denied** (`iam.serviceAccountKeys.create` denied) — your account needs
`roles/iam.serviceAccountKeyAdmin`.

**Wrong project** — `gcloud config get-value project`, and pass `--project=YOUR_PROJECT_ID` explicitly on
every command rather than relying on the active config.

## Condensed command sequence

```bash
PROJECT_ID="YOUR_PROJECT_ID"

gcloud config set project "$PROJECT_ID"

gcloud resource-manager org-policies disable-enforce \
  iam.disableServiceAccountKeyCreation \
  --project="$PROJECT_ID"

gcloud resource-manager org-policies describe \
  iam.disableServiceAccountKeyCreation \
  --project="$PROJECT_ID"

# after propagation:
# IAM & Admin → Service Accounts → select account → Keys → Add key → Create new key → JSON
```
