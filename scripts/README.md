# ADCMS Release Cut - GitHub Actions Workflow (v2)

Automates all release cut steps for the ADCMS team.
All scripts are Node.js - no Python, no new dependencies beyond what your AEM project already uses.

---

## File Structure

```
.github/
  workflows/
    release-cut.yml                Run this every release
scripts/
  classify_tickets.js              Applies your 4 ticket classification rules via Jira API
  update_jira_filter.js            Creates new Jira filter with updated JQL for new fix version
  update_release_ticket.js         Updates release ticket description with filter and ticket list
  notify_prs.js                    Comments on all open pull requests targeting develop
  slack.js                         Sends Slack notifications for workflow events
```

> These scripts run on the GitHub Actions **runner machine** - not inside your AEM project.
> Your Java/Node AEM source is completely untouched by this workflow.

---

## One-Time Setup

### 1. Copy Files Into Your Repository Root

```bash
cp -r .github/ scripts/ /path/to/your/repo/
cd /path/to/your/repo
git add .github/ scripts/
git commit -m "chore: add release cut automation workflow"
git push origin develop
```

### 2. Add Secrets in GitHub Enterprise

Go to: **Repository → Settings → Secrets and variables → Actions → New repository secret**

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

### 3. Verify Your Self-Hosted Runner

Confirm runner is registered: **Repository → Settings → Actions → Runners**

Required tools on the runner (all standard on Linux):
- `git`
- `gh` CLI (`gh --version`) - used to monitor pull request merge status
- `node` (`node --version`)
- `curl`

**Note:** The workflow no longer requires a protected environment (`release-gate`). If you previously configured one, you can safely delete it from **Repository → Settings → Environments**.

---

## How to Trigger a Release Cut

1. Go to your repository on GitHub Enterprise → **Actions** tab
2. Click **"Release Cut"** in the left sidebar
3. Click **"Run workflow"**
4. Fill in the form:

| Field | Example |
|-------|---------|
| Previous release branch | `release-2.02.0-loki` |
| Next release branch | `release-2.03.0-minotaur` |
| New Jira fix-version label | `AEM 2.03.0 - Minotaur` |
| Jira release ticket key | `ADCMS-9999` |
| Dry run | `false` |

5. Click the green **Run workflow** button
6. Watch progress in the Actions tab - each job shows status in real-time

The workflow derives these values automatically from the branch names:
- Previous release version → from `Previous release branch`
- Next release version → from `Next release branch`
- Next release codename → from `Next release branch`
- Previous release codename → from `Previous release branch`

---

## What Each Job Does

| Job | Description |
|-----|-------------|
| **Step 1 - Back-merge** | Merges previous release branch into `develop` via a pull request (always - even for clean merges). On conflict: conflict markers committed, pull request raised, Slack alert sent. |
| **Step 1b - Wait for PR merge** | Actively polls the back-merge pull request status every 30 seconds until it is merged. Workflow automatically continues once pull request is merged into `develop`. Times out after 2 hours if not merged. |
| **Step 2 - Cut branch** | Creates new release branch from `develop` and pushes to repository |
| **Step 3 - Rotate tags** | Deletes previous pre-release tag, creates latest tag for previous release, creates pre-release tag for new release |
| **Step 4 - ACM pipeline** | Obtains Adobe IMS token, updates stage pipeline branch to new release branch, triggers stage build |
| **Step 5 - Jira** | Extracts ticket IDs from git log between tags, applies 4 classification rules via Jira API, creates new filter, updates release ticket description |
| **Step 6 - PR notify** | Comments on every open pull request targeting `develop` with retargeting instructions |
| **Step 7 - Slack** | Posts complete release cut summary to release channel |

---

## Ticket Classification Rules (Step 5)

Mirrors exactly what your team does manually after running the browser console script:

| Rule | Condition | Action |
|------|-----------|--------|
| **Rule 1** | Ticket has ANY previous `AEM x.x.x - *` fix version | **Ignore** - already shipped |
| **Rule 2** | Ticket has NO fix version AND is Closed/Cancelled | **Ignore** - not relevant |
| **Rule 3** | Ticket has fix version = current `AEM x.x.x - Codename` | **Include** - listed on release ticket |
| **Rule 4** | Ticket has NO fix version AND is still Open | **Flag** - listed separately in Slack and release ticket as "code merged, fix version missing" |

---

## Jira Filter

A **new filter is created from scratch** on every release cut using your exact JQL - no existing filter ID needed, no patching. The new filter URL is passed automatically to the release ticket description and the Slack summary.

JQL format used:
```
project = ADCMS AND (issuetype = Story OR issuetype = Bug OR issuetype = Spike
OR issuetype = Improvement OR issuetype = Task)
AND fixVersion = "AEM 2.02.0 - Phoenix" ORDER BY key ASC
```

---

## Release Ticket Description Format

Matches your screenshot format exactly:

```
Release Filter: https://jsw.ibm.com/issues/?filter=459143

Release Tickets:
https://jsw.ibm.com/browse/ADCMS-10949
https://jsw.ibm.com/browse/ADCMS-11244
...

Tickets found in release branch but NOT tagged to fix version - code merged, fix version missing:
https://jsw.ibm.com/browse/ADCMS-XXXXX (only shown if Rule 4 tickets exist)
```

---

## Merge Conflict Flow

```
Step 1 detects conflict
  ↓
Creates pull request: chore/back-merge-release/x.x.x-conflicts to develop
  ↓
Slack alert: conflicting files + pull request link + instructions
  ↓
Step 1b starts polling pull request status (checks every 30 seconds)
  ↓
You resolve conflicts, commit, push, and merge pull request
  ↓
Step 1b detects pull request is merged and workflow automatically continues
  ↓
Step 2 starts (create release branch)
```

**Note:** The workflow now automatically detects when the pull request is merged and continues. You no longer need to manually approve or trigger a continuation workflow.

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Runner queued but never starts | Check runner status: Repository → Settings → Actions → Runners |
| `node` not found on runner | Install Node.js on the runner machine |
| ACM pipeline trigger returns non-201 | Verify `ACM_PIPELINE_ID` and `ACM_PROGRAM_ID` in Cloud Manager URL |
| No tickets found from tag compare | Ensure commit messages contain `ADCMS-XXXX` pattern; cherry-picks without ticket references need manual addition |
| Filter creation fails | Verify Jira project key and permissions |
| Slack notification not arriving | Test webhook: `curl -X POST $SLACK_WEBHOOK_URL -d '{"text":"test"}'` |