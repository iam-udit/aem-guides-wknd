# ADCMS Release Cut — GitHub Actions Workflow (v2)

Automates all 10 release cut steps for the ADCMS team.
All scripts are Node.js — no Python, no new dependencies beyond what your AEM project already uses.

---

## File structure

```
.github/
  workflows/
    release-cut.yml                ← Run this every release
    release-cut-continue.yml       ← Run only after resolving merge conflicts
scripts/
  classify_tickets.js              ← Applies your 4 ticket classification rules via Jira API
  update_jira_filter.js            ← Updates existing filter JQL with new fix version
  update_release_ticket.js         ← Writes Release Filter + Release Tickets to release ticket description
  notify_prs.js                    ← Comments on all open PRs targeting develop
```

> These scripts run on the GitHub Actions **runner machine** — not inside your AEM project.
> Your Java/Node AEM source is completely untouched by this workflow.

---

## One-time setup

### 1. Copy files into your repo root

```bash
cp -r .github/ scripts/ /path/to/your/repo/
cd /path/to/your/repo
git add .github/ scripts/
git commit -m "chore: add release cut automation workflow"
git push origin develop
```

### 2. Add secrets in GitHub Enterprise

Go to: **Repo → Settings → Secrets and variables → Actions → New repository secret**

| Secret | Example value | Where to get it |
|--------|---------------|-----------------|
| `GH_TOKEN` | `ghp_xxx...` | GitHub → Settings → Developer settings → Personal access tokens → `repo` + `workflow` scopes |
| `JIRA_BASE_URL` | `https://jsw.ibm.com` | Your Jira instance URL |
| `JIRA_USER_EMAIL` | `you@ibm.com` | Your IBM Jira login |
| `JIRA_API_TOKEN` | `ATATT3x...` | Jira → Account Settings → Security → API tokens |
| `JIRA_PROJECT_KEY` | `ADCMS` | Your Jira project key |
| `ACM_CLIENT_ID` | `abc123...` | Adobe Developer Console → your Cloud Manager project |
| `ACM_CLIENT_SECRET` | `xxx...` | Adobe Developer Console → your Cloud Manager project |
| `ACM_ORG_ID` | `ABC123@AdobeOrg` | Adobe Developer Console → Org overview |
| `ACM_PROGRAM_ID` | `12345` | Cloud Manager URL: `.../program/12345/...` |
| `ACM_PIPELINE_ID` | `67890` | Cloud Manager → Pipelines → stage pipeline → URL |
| `SLACK_WEBHOOK_URL` | `https://hooks.slack.com/...` | Slack → App Directory → Incoming Webhooks |

### 3. Verify your self-hosted runner

Confirm runner is registered: **Repo → Settings → Actions → Runners**

Required tools on the runner (all standard on Linux):
- `git`
- `gh` CLI  (`gh --version`) — used to monitor PR merge status
- `node`    (`node --version`)
- `curl`

**Note:** The workflow no longer requires a protected environment (`release-gate`). If you previously configured one, you can safely delete it from **Repo → Settings → Environments**.

---

## How to trigger a release cut

1. Go to your repo on GitHub Enterprise → **Actions** tab
2. Click **"Release Cut"** in the left sidebar
3. Click **"Run workflow"**
4. Fill in the form:

| Field | Example |
|-------|---------|
| Previous release branch | `release/2.01.0` |
| New release version | `2.02.0` |
| New Jira fix-version label | `AEM 2.02.0 - Phoenix` |
| Previous Jira fix-version label | `AEM 2.01.0 - Kraken` |
| Jira release ticket key | `ADCMS-9999` |
| Dry run | `false` |

5. Click the green **Run workflow** button
6. Watch progress in the Actions tab — each job shows ✅ or ❌ live

---

## What each job does

| Job | What it does |
|-----|--------------|
| **1 · Back-merge** | Merges `release/prev` into `develop` via a PR (always — even for clean merges). On conflict: conflict markers committed, PR raised, Slack alert sent. |
| **1b · Wait for PR merge** | Actively polls the back-merge PR status every 30 seconds until it's merged. Workflow automatically continues once PR is merged into `develop`. Times out after 2 hours if not merged. |
| **2 · Cut branch** | Creates `release/x.x.x` from `develop` and pushes |
| **3 · Rotate tags** | Deletes `pre-release/prev` → creates `latest/prev` → creates `pre-release/new` |
| **4 · ACM pipeline** | Gets IMS token, patches stage pipeline branch to new release branch, triggers stage build |
| **5 · Jira** | Extracts `ADCMS-XXXX` IDs from git log between tags, applies 4 classification rules via Jira API, updates existing filter JQL, updates release ticket description |
| **6 · PR notify** | Comments on every open PR targeting `develop` with retargeting instructions |
| **7 · Slack** | Posts full release cut summary to release channel |

---

## Ticket classification rules (Job 5)

Mirrors exactly what your team does manually after running the browser console script:

| Rule | Condition | Action |
|------|-----------|--------|
| **Rule 1** | Ticket has ANY previous `AEM x.x.x - *` fix version | **Ignore** — already shipped |
| **Rule 2** | Ticket has NO fix version AND is Closed/Cancelled | **Ignore** — not relevant |
| **Rule 3** | Ticket has fix version = current `AEM x.x.x - Codename` | **Include** — listed on release ticket |
| **Rule 4** | Ticket has NO fix version AND is still Open | **Flag** — listed separately in Slack and release ticket as "code merged, fix version missing" |

---

## Jira filter

A **new filter is created from scratch** on every release cut using your exact JQL — no existing filter ID needed, no patching. The new filter URL is passed automatically to the release ticket description and the Slack summary.

JQL format used:
```
project = ADCMS AND (issuetype = Story OR issuetype = Bug OR issuetype = Spike
OR issuetype = Improvement OR issuetype = Task)
AND fixVersion = "AEM 2.02.0 - Phoenix" ORDER BY key ASC
```

---

## Release ticket description format

Matches your screenshot format exactly:

```
Release Filter: https://jsw.ibm.com/issues/?filter=459143

Release Tickets:
https://jsw.ibm.com/browse/ADCMS-10949
https://jsw.ibm.com/browse/ADCMS-11244
...

⚠️ Tickets found in release branch but NOT tagged to fix version — code merged, fix version missing:
https://jsw.ibm.com/browse/ADCMS-XXXXX   ← (only shown if Rule 4 tickets exist)
```

---

## Merge conflict flow

```
Job 1 detects conflict
  ↓
Creates PR: chore/back-merge-release/x.x.x-conflicts → develop
  ↓
Slack alert: conflicting files + PR link + instructions
  ↓
Job 1b starts polling PR status (checks every 30 seconds)
  ↓
You resolve conflicts → commit → push → merge PR
  ↓
Job 1b detects PR is merged → workflow automatically continues
  ↓
Job 2 starts (cut release branch)
```

**Note:** The workflow now automatically detects when the PR is merged and continues. You no longer need to manually approve or trigger a continuation workflow.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Runner queued but never starts | Check runner status: Repo → Settings → Actions → Runners |
| `node` not found on runner | Install Node.js on the runner machine |
| ACM pipeline trigger returns non-201 | Verify `ACM_PIPELINE_ID` and `ACM_PROGRAM_ID` in Cloud Manager URL |
| No tickets found from tag compare | Ensure commit messages contain `ADCMS-XXXX` pattern; cherry-picks without ticket refs need manual addition |
| Filter update fails | Verify `JIRA_FILTER_ID` matches the numeric ID in your filter URL |
| Slack notification not arriving | Test webhook: `curl -X POST $SLACK_WEBHOOK_URL -d '{"text":"test"}'` |