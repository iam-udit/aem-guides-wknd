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
| **Step 4 - ACM pipeline** | **(Optional)** Obtains Adobe IMS token, updates stage pipeline branch to new release branch, triggers stage build. Failures are logged as warnings and never block downstream jobs. |
| **Step 5 - Jira** | Extracts ticket IDs from git log between tags, applies 4 classification rules via Jira API, creates new filter, updates release ticket description |
| **Step 6 - PR notify** | Comments on every open pull request targeting `develop` with retargeting instructions |
| **Step 7 - Slack** | Posts complete release cut summary to release channel |

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

## Adobe Cloud Manager Integration (Step 4)

### Overview

The Adobe Cloud Manager (ACM) integration is an **optional step** that updates your Cloud Manager pipeline configuration and triggers a stage build. If ACM operations fail, the workflow continues with remaining steps (Jira updates, PR notifications, Slack summary).

### Key Implementation Details

**Authentication:**
- Uses Adobe IMS OAuth 2.0 with client credentials flow
- Requires `ACM_CLIENT_ID` and `ACM_CLIENT_SECRET`
- Token endpoint: `https://ims-na1.adobelogin.com/ims/token/v3`

**API Requirements:**
- All Cloud Manager API calls require three headers:
  - `Authorization: Bearer <token>` - IMS access token
  - `x-gw-ims-org-id: <org_id>` - Adobe IMS organization ID
  - `x-api-key: <client_id>` - Same value as `ACM_CLIENT_ID`

**Pipeline Operations:**
1. **Fetch current pipeline config** - GET request to retrieve existing configuration
2. **Update pipeline branch** - PATCH request (not PUT) to update BUILD phase branch to new release branch
3. **Trigger pipeline execution** - PUT request to start stage build

### Error Handling

The workflow handles common ACM scenarios gracefully:

| HTTP Status | Scenario | Workflow Behavior |
|-------------|----------|-------------------|
| **200** | Pipeline updated successfully | ✅ Continues to trigger execution |
| **201** | Pipeline triggered successfully | ✅ Logs success and continues |
| **403** | Permission denied | ⚠️ Logs warning, suggests checking Deployment Manager role, continues workflow |
| **409** | Pipeline already running | ⚠️ Logs warning, suggests manual update after current run completes, continues workflow |
| **Other** | Unexpected error | ⚠️ Logs warning with HTTP code, suggests manual verification, continues workflow |

### Troubleshooting ACM Issues

**Authentication failures:**
- Verify `ACM_CLIENT_ID` and `ACM_CLIENT_SECRET` are correct
- Ensure the service account has not been revoked in Adobe Admin Console
- Check that the OAuth integration includes required scopes

**Pipeline update failures (HTTP 409):**
- Pipeline is currently executing - wait for completion
- Update the pipeline branch manually in Cloud Manager UI
- Re-run the workflow if needed

**Permission errors (HTTP 403):**
- Service account needs **Deployment Manager** role in Cloud Manager
- Verify the service account is added to the correct program
- Check that API access is enabled for the integration

**Pipeline not found errors:**
- Verify `ACM_PROGRAM_ID` matches your Cloud Manager program
- Verify `ACM_PIPELINE_ID` matches your stage pipeline
- Confirm the pipeline exists and is not deleted

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Workflow fails in metadata derivation | Verify both branch inputs follow `release-x.y.z-codename` |
| Runner queued but never starts | Check runner status: Repository → Settings → Actions → Runners |
| `node` not found on runner | Install Node.js on the runner machine |
| Back-merge PR polling times out | Merge the PR into `develop`, then re-run the workflow if needed |
| ACM authentication fails | Verify `ACM_CLIENT_ID` and `ACM_CLIENT_SECRET` are correct and the service account is active |
| ACM pipeline returns HTTP 409 | Pipeline is already running - wait for completion or update manually in Cloud Manager |
| ACM pipeline returns HTTP 403 | Service account needs Deployment Manager role in Cloud Manager |
| ACM pipeline not found | Verify `ACM_PIPELINE_ID` and `ACM_PROGRAM_ID` match your Cloud Manager configuration |
| No tickets found from tag compare | Ensure commit messages contain `ADCMS-XXXX` pattern; cherry-picks without ticket references need manual addition |
| Filter creation fails | Verify Jira project key, Jira permissions, and fix-version existence |
| Release ticket update fails | Verify the Jira release ticket exists and the bot user can edit/comment on it |
| Slack notification not arriving | Verify `SLACK_BOT_TOKEN`, `SLACK_CHANNEL_ID`, and bot membership in the target channel |

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

## Slack Notifications

The workflow uses threaded Slack messages to provide real-time updates throughout the release cut process.

### Message Structure

1. **Start Message (Step 0a)** - Posted when workflow begins
   - Creates the main thread
   - Shows release version and planned stages
   - Provides link to workflow run

2. **Back-merge Status (Step 1)** - Posted as thread reply
   - Reports clean merge, conflicts, or already-in-sync status
   - Includes PR link when applicable
   - Provides action items for conflict resolution

3. **Final Summary (Step 7)** - Posted as thread reply
   - Comprehensive release cut summary
   - Shows all completed steps and their results
   - Includes ticket counts, filter URL, and release artifacts

### ACM Result Handling in Slack Summary

The final Slack summary includes the Adobe Cloud Manager step result with clear status indicators:

| ACM_RESULT | Slack Display | Meaning |
|------------|---------------|---------|
| `success` | ✅ Adobe Cloud Manager pipeline updated and triggered | Pipeline branch updated and stage build started successfully |
| `failure` | ⚠️ Adobe Cloud Manager: failure | ACM step encountered errors (see workflow logs for details) |
| `cancelled` or `skipped` | ℹ️ Adobe Cloud Manager: skipped | ACM step was not executed (dry run or conditional skip) |

**Important:** ACM failures are treated as warnings only. The workflow continues with Jira updates, PR notifications, and Slack summary even if ACM operations fail. This ensures the release cut process completes and provides visibility into what succeeded and what requires manual follow-up.

### Troubleshooting Slack Notifications

- **No messages appearing:** Verify `SLACK_BOT_TOKEN` and `SLACK_CHANNEL_ID` are correct
- **Bot not in channel:** Add the Slack bot to the target channel
- **Thread replies not working:** Ensure the start message completed successfully and `THREAD_TS` is being passed to subsequent steps
- **Incomplete summaries:** Check workflow logs for script errors in `scripts/slack.js`

---