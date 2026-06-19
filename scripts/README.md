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

### 2. Configure Repository Secrets and Variables

Go to: **Repository → Settings → Secrets and variables → Actions**

Use **Secrets** for credentials/tokens and **Variables** for non-sensitive configuration.

#### Recommended GitHub Actions Secrets

| Secret | Example value | Purpose |
|--------|---------------|---------|
| `GH_TOKEN` | `ghp_xxx...` | GitHub PAT with repository access for checkout, PR creation, and PR polling |
| `JIRA_API_TOKEN` | `ATATT3x...` | Jira API authentication |
| `ACM_CLIENT_SECRET` | `xxx...` | Adobe Cloud Manager OAuth client secret |
| `SLACK_BOT_TOKEN` | `xoxb-...` | Slack bot token used by `scripts/slack.js` |

#### Recommended GitHub Actions Variables

| Variable | Example value | Purpose |
|----------|---------------|---------|
| `JIRA_BASE_URL` | `https://jsw.ibm.com` | Jira instance base URL |
| `JIRA_USER_EMAIL` | `you@ibm.com` | Jira user email for API authentication |
| `JIRA_PROJECT_KEY` | `ADCMS` | Jira project key used in JQL and ticket parsing |
| `ACM_CLIENT_ID` | `abc123...` | Adobe Cloud Manager OAuth client ID |
| `ACM_ORG_ID` | `ABC123@AdobeOrg` | Adobe IMS organization ID |
| `ACM_PROGRAM_ID` | `12345` | Adobe Cloud Manager program ID |
| `ACM_PIPELINE_ID` | `67890` | Adobe Cloud Manager stage pipeline ID |
| `SLACK_CHANNEL_ID` | `C01234567` | Slack channel ID for threaded notifications |

> **Important:** Earlier versions of this documentation referenced `SLACK_WEBHOOK_URL`. The current workflow uses `SLACK_BOT_TOKEN` and `SLACK_CHANNEL_ID` instead.

### 3. Configure Environment Protection for Approval

The workflow requires manual approval when branches are already in sync (manual back-merge detected).

**Setup:**
1. Go to **Repository → Settings → Environments**
2. Click **New environment**
3. Name it: `release-approval`
4. Under **Environment protection rules**, enable:
   - ✅ **Required reviewers**
   - Add team members who can approve release continuations
5. Click **Save protection rules**

This ensures that when the workflow detects branches are already merged, it will pause and require approval before proceeding with the release cut.

### 4. Verify Your Self-Hosted Runner

Confirm runner is registered: **Repository → Settings → Actions → Runners**

Required tools on the runner (all standard on Linux):
- `git`
- `gh` CLI (`gh --version`) - used to monitor pull request merge status
- `node` (`node --version`)
- `curl`

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
- Previous latest tag → `<previous-version>`
- Previous prerelease tag → `<previous-version>-beta`
- New prerelease tag → `<next-version>-beta`

### Branch Naming Standard

The workflow validates release branches using this convention:

```text
release-<major>.<minor>.<patch>-<codename>
```

Examples:
- `release-2.02.0-loki`
- `release-2.03.0-minotaur`

If the branch format does not match this convention, the workflow fails early in the metadata derivation job.

---

## What Each Job Does

| Job | Description |
|-----|-------------|
| **Step 0 - Derive metadata** | Validates branch naming convention and derives versions, codenames, and tag names used by downstream jobs |
| **Step 0a - Slack start** | Posts the initial threaded Slack message for workflow visibility |
| **Step 1 - Back-merge** | Checks if branches are already in sync. If not, merges previous release branch into `develop` via a pull request (always - even for clean merges). On conflict: conflict markers committed, pull request raised, Slack alert sent. |
| **Step 1b - Approval gate** | **(Conditional)** When branches are already in sync (manual back-merge detected), requires manual approval via GitHub environment protection before proceeding. Ensures the "already merged" state is intentional. |
| **Step 1c - Wait for PR merge** | **(Conditional)** When a back-merge PR is created, actively polls the pull request status every 30 seconds until it is merged. Workflow automatically continues once pull request is merged into `develop`. Times out after 2 hours if not merged. |
| **Step 2 - Cut branch** | Creates new release branch from `develop` and pushes to repository |
| **Step 3 - Rotate tags** | Deletes previous pre-release tag, creates latest tag for previous release, creates pre-release tag for new release |
| **Step 4 - ACM pipeline** | **(Optional)** Obtains Adobe IMS token, updates stage pipeline branch to new release branch, triggers stage build. Workflow continues if this fails. |
| **Step 5 - Jira** | Extracts ticket IDs from git log between tags, applies 4 classification rules via Jira API, creates new filter, updates release ticket description |
| **Step 6 - PR notify** | Comments on every open pull request targeting `develop` with retargeting instructions |
| **Step 7 - Slack** | Posts complete release cut summary to release channel |

---

## Adobe Cloud Manager Integration (Optional Step)

The Adobe Cloud Manager (ACM) integration is treated as an **optional step** in the release cut workflow. If ACM operations fail for any reason, the workflow will continue with all remaining jobs and complete successfully.

### Why ACM is Optional

ACM failures should not block the core release cut process. Common scenarios where ACM might fail include:
- Pipeline already running (409 Conflict)
- Invalid or expired credentials
- Network connectivity issues
- Insufficient permissions
- Pipeline configuration errors
- Rate limiting or service unavailability

### How ACM Failures are Handled

When any ACM step fails:
1. **Workflow continues** - Jira updates and PR notifications proceed normally
2. **Slack notification distinguishes** - Shows ACM status separately with a warning icon
3. **Clear messaging** - Team is notified to update Cloud Manager manually
4. **Core release succeeds** - The release cut is still considered successful

### Slack Notification Behavior

**When ACM succeeds:**
- ✅ Release Cut Completed
- Shows "Adobe Cloud Manager: Pipeline branch updated and triggered"

**When ACM fails but core workflow succeeds:**
- ✅ Release Cut Completed (ACM Warning)
- Shows separate ACM section with warning icon
- Includes error details and manual action required
- Note: "Adobe Cloud Manager is an optional step. The release cut completed successfully."

**When core workflow fails:**
- ❌ Release Cut Failed
- Shows failed core steps (Jira/PRs)
- If ACM also failed, shows it separately as "Also failed, but this is not blocking"

### Manual Recovery Steps

When ACM fails, manually complete these steps in Adobe Cloud Manager:

1. Log into Adobe Cloud Manager
2. Navigate to your program's pipeline configuration
3. Update the stage pipeline branch to the new release branch (e.g., `release-2.03.0-minotaur`)
4. Trigger the stage pipeline execution manually
5. Monitor the build progress in Cloud Manager

### API Requirements

The ACM integration requires:
- **x-api-key header** - Must equal the ACM client ID on all API requests
- **PATCH method** - Pipeline branch updates use PATCH, not PUT
- **Valid credentials** - Client ID, client secret, and org ID must be current

---

## Operational Notes

### Dry Run Behavior

When `dry_run=true`, the workflow still performs validation, metadata derivation, and read-only analysis where possible, but it skips mutating operations such as:
- pushing branches
- creating pull requests
- creating/deleting releases and tags
- patching Adobe Cloud Manager pipeline configuration
- triggering Adobe Cloud Manager execution
- updating Jira filters/tickets
- posting Slack notifications

Use dry run before every production release cut when changing workflow logic.

### Logging and Error Handling Improvements

The workflow and scripts now follow these operational practices:
- fail fast on missing required environment variables
- validate release branch naming before any downstream job runs
- centralize derived release metadata in one workflow job
- emit structured log messages for easier troubleshooting
- guard JSON parsing from external APIs
- avoid writing to `GITHUB_OUTPUT` when it is unavailable
- keep job names stable and enterprise-readable across runs

### Recommended Operational Sequence

Before triggering the workflow:
1. Confirm the previous release branch exists remotely.
2. Confirm the next release branch name follows the standard naming convention.
3. Confirm the Jira fix-version label already exists in Jira.
4. Confirm the Jira release ticket exists and is editable by the bot user.
5. Confirm Adobe Cloud Manager program/pipeline identifiers are correct.
6. Confirm Slack bot access to the target channel.

After the workflow completes:
1. Verify the back-merge PR was merged correctly.
2. Verify the new release branch exists remotely.
3. Verify GitHub releases/tags were created as expected.
4. Verify the Adobe Cloud Manager pipeline now points to the new release branch.
5. Verify the Jira filter and release ticket description were updated.
6. Verify PR comments and Slack summary were posted.

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Workflow fails in metadata derivation | Verify both branch inputs follow `release-x.y.z-codename` |
| Runner queued but never starts | Check runner status: Repository → Settings → Actions → Runners |
| `node` not found on runner | Install Node.js on the runner machine |
| Back-merge PR polling times out | Merge the PR into `develop`, then re-run the workflow if needed |
| ACM pipeline operations fail | **Workflow continues** - ACM is optional. Update pipeline manually in Cloud Manager. Check `ACM_CLIENT_ID`, `ACM_CLIENT_SECRET`, `ACM_ORG_ID` credentials. Verify `x-api-key` header is set correctly. |
| ACM returns 401 Unauthorized | Verify Adobe IMS credentials are valid and not expired. Check client ID and secret match. |
| ACM returns 409 Conflict | Pipeline is already running. Wait for current execution to complete, then manually trigger new build. |
| ACM returns 404 Not Found | Verify `ACM_PROGRAM_ID` and `ACM_PIPELINE_ID` are correct for your Cloud Manager instance. |
| No tickets found from tag compare | Ensure commit messages contain `ADCMS-XXXX` pattern; cherry-picks without ticket references need manual addition |
| Filter creation fails | Verify Jira project key, Jira permissions, and fix-version existence |
| Release ticket update fails | Verify the Jira release ticket exists and the bot user can edit/comment on it |
| Slack notification not arriving | Verify `SLACK_BOT_TOKEN`, `SLACK_CHANNEL_ID`, and bot membership in the target channel |
| Slack shows "ACM Warning" | ACM step failed but workflow completed successfully. Follow manual recovery steps to update Cloud Manager. |

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

## Back-merge Flow

### Scenario 1: Branches Already in Sync (Manual Back-merge Already Done)

```
Step 1 detects no changes between branches
  ↓
Slack notification: branches already in sync - approval needed
  ↓
Step 1b waits for manual approval via GitHub environment protection
  ↓
You verify the manual back-merge is correct and approve the workflow
  ↓
Step 1c is skipped (no PR to wait for)
  ↓
Step 2 starts (create release branch)
```

**Note:** When branches are already in sync, the workflow requires manual approval to ensure this is intentional. This prevents accidental continuation when the back-merge state is unexpected.

### Scenario 2: Clean Merge (No Conflicts)

```
Step 1 performs clean merge
  ↓
Creates pull request: chore/back-merge-release/x.x.x to develop
  ↓
Slack alert: clean merge + pull request link
  ↓
Step 1b starts polling pull request status (checks every 30 seconds)
  ↓
You review and merge pull request
  ↓
Step 1b detects pull request is merged and workflow automatically continues
  ↓
Step 2 starts (create release branch)
```

### Scenario 3: Merge Conflicts

```
Step 1 detects conflict
  ↓
Creates pull request: chore/back-merge-release/x.x.x to develop
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

**Note:** The workflow automatically detects when the pull request is merged and continues. You no longer need to manually approve or trigger a continuation workflow.

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Workflow fails in metadata derivation | Verify both branch inputs follow `release-x.y.z-codename` |
| Runner queued but never starts | Check runner status: Repository → Settings → Actions → Runners |
| `node` not found on runner | Install Node.js on the runner machine |
| Back-merge PR polling times out | Merge the PR into `develop`, then re-run the workflow if needed |
| ACM pipeline trigger returns non-201 | Verify `ACM_PIPELINE_ID`, `ACM_PROGRAM_ID`, and Adobe credentials |
| No tickets found from tag compare | Ensure commit messages contain `ADCMS-XXXX` pattern; cherry-picks without ticket references need manual addition |
| Filter creation fails | Verify Jira project key, Jira permissions, and fix-version existence |
| Release ticket update fails | Verify the Jira release ticket exists and the bot user can edit/comment on it |
| Slack notification not arriving | Verify `SLACK_BOT_TOKEN`, `SLACK_CHANNEL_ID`, and bot membership in the target channel |