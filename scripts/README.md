# ADCMS Release Cut - GitHub Actions Workflow (v2.1)

Automates all release cut steps for the ADCMS team.
All scripts are Node.js - no Python, no new dependencies beyond what your AEM project already uses.

## 🆕 What's New in v2.1

- **🎨 Workflow Visualization** - ASCII and Mermaid diagrams showing real-time progress
- **📊 Progress Indicators** - Visual progress bars in Slack notifications
- **⚡ Parallel Execution** - 40-50% faster with 3-way parallel job execution

---

## File Structure

```
.github/
  workflows/
    release-cut.yml                Run this every release
    release-rollback.yml           Rollback a release cut (NEW)
scripts/
  classify_tickets.js              Applies your 4 ticket classification rules via Jira API
  update_jira_filter.js            Creates new Jira filter with updated JQL for new fix version
  update_release_ticket.js         Updates release ticket description with filter and ticket list
  notify_prs.js                    Comments on all open pull requests targeting develop
  resolve_conflict_owners.js       Identifies file owners for merge conflicts
  rollback_jira.js                 Cleans up Jira artifacts during rollback (NEW)
  rollback_prs.js                  Cleans up PR artifacts during rollback (NEW)
  slack.js                         Sends Slack notifications for all workflow events
  workflow_visualizer.js           Generates workflow progress visualizations
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

---

## 🎨 New Features (v2.1)

### 1. Workflow Visualization

**Script:** `scripts/workflow_visualizer.js`

Generates visual representations of workflow progress in both ASCII and Mermaid diagram formats.

#### Features:
- **ASCII Progress Bar**: Text-based progress indicator showing completion percentage
- **Stage-by-Stage Status**: Visual representation of each workflow stage with status icons
- **Mermaid Diagrams**: GitHub-compatible diagrams for documentation and Slack
- **Real-time Progress**: Updates throughout workflow execution

#### Status Icons:
- ✅ Success (completed successfully)
- ❌ Failure (step failed)
- 🚫 Cancelled (manually cancelled)
- ⏭️ Skipped (skipped due to conditions)
- ⏳ In Progress (currently running)
- ⚪ Pending (not yet started)

#### Example Output:

**ASCII Format:**
```
═══════════════════════════════════════════════════════════════
                    RELEASE CUT WORKFLOW                       
═══════════════════════════════════════════════════════════════

  ✅ 🚀  Start
    │
  ✅ 🔀  Back-merge
    │
  ✅ ✂️  Cut Branch
    │
  ✅ 🏷️  Rotate Tags
    │
  ✅ ☁️  Adobe CM
    │
  ✅ 📋  Jira Updates ◀ CURRENT
    │
  ⚪ 📢  Notify PRs
    │
  ⚪ ✅  Complete

═══════════════════════════════════════════════════════════════
Legend: ✅ Done  ❌ Failed  🚫 Cancelled  ⏭️ Skipped  ⚪ Pending
═══════════════════════════════════════════════════════════════
```

---

### 2. Simplified Slack Notifications

**Enhanced Script:** `scripts/slack.js`

Slack notifications have been streamlined to focus on critical information without clutter.

#### Three-Message Structure:

1. **Start Message** - Posted when workflow begins
   - Release version and workflow run number
   - Triggered by user
   - List of planned stages
   - Link to view workflow in GitHub Actions

2. **Back-merge Notification** - Posted after back-merge completes (threaded reply)
   - Critical because it requires user action
   - Shows conflict status and file owners if conflicts exist
   - Provides PR link and resolution instructions
   - Workflow automatically continues after PR is merged

3. **Final Summary** - Posted when workflow completes (threaded reply)
   - Success/failure status with duration
   - Release artifacts (branch, tags)
   - Jira outcome (ticket count, filter link)
   - Adobe Cloud Manager status (with warning if failed)
   - Detailed breakdown of any failures

#### Design Philosophy:

The workflow completes in 8-12 minutes with most steps finishing in seconds. Rather than cluttering the channel with progress updates, we focus on:
- **Start**: Notify team that release cut has begun
- **Back-merge**: Alert when manual action is required
- **Summary**: Provide complete results when finished

This keeps Slack clean while ensuring critical information is communicated at the right time.

---

### 3. Parallel Job Execution

**Enhanced Workflow:** `.github/workflows/release-cut.yml`

The workflow has been optimized to run independent jobs in parallel, reducing total execution time by 40-50%.

#### Parallel Execution Strategy:

```
┌─────────────────────────────────────────────────────────┐
│  Job 0: Derive Metadata                                 │
└────────────────┬────────────────────────────────────────┘
                 │
┌────────────────▼────────────────────────────────────────┐
│  Job 0a: Slack Start                                    │
└────────────────┬────────────────────────────────────────┘
                 │
┌────────────────▼────────────────────────────────────────┐
│  Job 1: Back-merge                                      │
└────────────────┬────────────────────────────────────────┘
                 │
        ┌────────┴────────┐
        │                 │
┌───────▼──────┐  ┌──────▼────────┐
│ Job 1b:      │  │ Job 1c:       │
│ Approval     │  │ Await PR      │
│ (conditional)│  │ (conditional) │
└───────┬──────┘  └──────┬────────┘
        └────────┬────────┘
                 │
┌────────────────▼────────────────────────────────────────┐
│  Job 2: Cut Release Branch                              │
└────────────────┬────────────────────────────────────────┘
                 │
┌────────────────▼────────────────────────────────────────┐
│  Job 3: Rotate Tags                                     │
└────────────────┬────────────────────────────────────────┘
                 │
        ┌────────┼────────┐
        │        │        │
┌───────▼──────┐ │ ┌─────▼────────┐
│ Job 4:       │ │ │ Job 6:       │
│ Adobe CM     │ │ │ Notify PRs   │
│ (parallel)   │ │ │ (parallel)   │
└───────┬──────┘ │ └─────┬────────┘
        │  ┌─────▼─────┐ │
        │  │ Job 5:    │ │
        │  │ Jira      │ │
        │  │ Updates   │ │
        │  │ (parallel)│ │
        │  └─────┬─────┘ │
        └────────┼────────┘
                 │
┌────────────────▼────────────────────────────────────────┐
│  Job 7: Slack Summary (waits for all 3 parallel jobs)  │
└─────────────────────────────────────────────────────────┘
```

#### Performance Improvements:

**Before Optimization:**
- Jobs ran sequentially: Job 4 → Job 5 → Job 6
- Total time: ~15-20 minutes

**After Optimization:**
- Jobs 4, 5, and 6 ALL run in parallel
- Job 7 waits for all three to complete
- Total time: ~8-12 minutes (40-50% faster)

#### Independent Jobs (Run in Parallel):

1. **Job 4: Adobe Cloud Manager** (2-3 min)
   - Updates ACM pipeline configuration
   - Triggers stage build
   - Marked as `continue-on-error: true` (optional)

2. **Job 5: Jira Release Updates** (3-4 min)
   - Classifies tickets
   - Creates Jira filter
   - Updates release ticket

3. **Job 6: Notify Open PRs** (1-2 min)
   - Comments on open pull requests
   - Provides retargeting instructions
   - Uses only release metadata (no dependency on Jobs 4 or 5)

All three jobs depend only on Job 3 (Rotate Tags) and can run simultaneously since they don't interact with each other.

#### Execution Time Comparison

| Stage | Before | After | Improvement |
|-------|--------|-------|-------------|
| Jobs 0-3 | 5-7 min | 5-7 min | No change |
| Job 4 (ACM) | 2-3 min | 2-3 min | - |
| Job 5 (Jira) | 3-4 min | 3-4 min | - |
| Job 6 (PRs) | 1-2 min | 1-2 min | - |
| **Jobs 4+5+6 Combined** | **6-9 min** | **3-4 min** | **~50% faster** |
| Job 7 (Summary) | <1 min | <1 min | No change |
| **Total** | **15-20 min** | **8-12 min** | **~40-50% faster** |

#### Resource Utilization

- **Before**: Sequential execution, one runner at a time
- **After**: Up to 3 runners simultaneously during Jobs 4, 5 & 6
- **Cost**: Minimal increase (same total compute time, just parallelized)


---

## 🔄 Release Rollback

The rollback workflow safely undoes a release cut by reverting all changes made during the release process.

### When to Use Rollback

- Release was cut by mistake
- Critical issue discovered after release cut
- Need to redo release with different configuration
- Back-merge conflicts cannot be resolved

### What Gets Rolled Back

1. **Release Branch** - Deleted from repository
2. **Pre-release Tag** - Deleted and previous tag restored
3. **Adobe Cloud Manager** - Pipeline reverted to previous branch
4. **Jira Filter** - Deleted from Jira
5. **Release Ticket** - Rollback comment added
6. **Back-merge PR** - Closed with explanation (if still open)
7. **PR Comments** - Bot comments removed from notified PRs

### How to Trigger Rollback

1. Go to **Actions** tab in GitHub
2. Select **"Release Rollback"** workflow
3. Click **"Run workflow"**
4. Fill in the form:

| Field | Example | Description |
|-------|---------|-------------|
| Release branch to delete | `release-2.03.0-minotaur` | The branch created by release cut |
| Previous release branch | `release-2.02.0-loki` | The branch to restore to |
| Jira fix version label | `AEM 2.03.0 - Minotaur` | The exact Jira fix version label used in the release |
| Jira release ticket | `ADCMS-9999` | Release ticket key |
| Reason for rollback | `Critical bug found in build` | Why rollback is needed |

5. Click **"Run workflow"**
6. **Approve the rollback** when prompted (safety gate)
7. Wait for completion

### Rollback Workflow Steps

```
Step 0: Validate inputs and derive metadata
  ↓
Step 0a: Post Slack notification (rollback initiated)
  ↓
Step 1: Approval gate (requires manual approval)
  ↓
Step 2: Delete release branch and tags
  ↓
Step 3: Revert Adobe Cloud Manager pipeline (optional)
  ↓
Step 4: Cleanup Jira artifacts (parallel)
  ↓
Step 5: Cleanup PR artifacts (parallel)
  ↓
Step 6: Post Slack summary (rollback complete)
```

### Safety Features

- **Approval Required**: Rollback cannot proceed without manual approval
- **Validation**: Branch names validated before any changes
- **Slack Notifications**: Team notified at start and completion
- **Graceful Failures**: ACM failures don't block rollback
- **Idempotent**: Safe to re-run if partially completed

### What Rollback Does NOT Do

- ❌ Does not revert commits in develop branch
- ❌ Does not undo merged back-merge PR (only closes if still open)
- ❌ Does not restore deleted Jira tickets
- ❌ Does not revert code changes in any branch

### After Rollback

1. Verify rollback completed successfully in Slack
2. Check Adobe Cloud Manager pipeline points to correct branch
3. Verify release branch and tag are deleted
4. Confirm Jira filter is removed
5. If needed, manually clean up any remaining artifacts
6. Ready to re-run release cut with corrections

### Rollback Slack Notifications

**Start Message:**
```
⚠️ Release Rollback Initiated: AEM 2.03.0 - Minotaur

Release: AEM 2.03.0 - Minotaur
Status: Awaiting Approval
Workflow Run: #42
Initiated By: @iam-udit

Rollback Reason:
Critical bug found in build

Planned Actions:
• Delete release branch
• Delete pre-release tag
• Restore previous pre-release tag
• Revert Adobe Cloud Manager pipeline
• Delete Jira filter
• Add rollback comment to release ticket
• Close back-merge PR (if open)
• Delete bot comments from notified PRs

ℹ️ This rollback requires manual approval before execution.

[View Workflow] (red button)
```

**Completion Message:**
```
✅ Rollback Completed: AEM 2.03.0 - Minotaur

Release: AEM 2.03.0 - Minotaur
Status: Completed
Workflow Run: #42
Initiated By: @iam-udit

Rollback Reason:
Critical bug found in build

Actions Completed:
• Deleted release branch: release-2.03.0-minotaur
• Deleted pre-release tag
• Restored previous pre-release tag
• Reverted to branch: release-2.02.0-loki
• Deleted Jira filter
• Added rollback comment to release ticket
• Closed back-merge PR (if it was open)
• Deleted bot comments from notified PRs

Adobe Cloud Manager:
• Pipeline reverted to release-2.02.0-loki

Initiated by @iam-udit • View workflow
```

### Troubleshooting Rollback

| Problem | Solution |
|---------|----------|
| Approval not appearing | Check environment protection is configured for `release-approval` |
| Branch deletion fails | Branch may not exist - check if already deleted manually |
| ACM revert fails | Manually update pipeline in Cloud Manager (rollback continues) |
| Jira filter not found | Filter may have been deleted manually - rollback continues |
| PR cleanup fails | Manually close back-merge PR and delete bot comments |
