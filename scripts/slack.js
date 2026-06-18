#!/usr/bin/env node
/**
 * slack.js
 * --------
 * Handles all Slack notifications for the release cut workflow.
 * Using Node.js instead of curl inline JSON avoids all shell
 * escaping and special character issues entirely.
 *
 * Environment variables always required:
 *   SLACK_WEBHOOK_URL
 *   NOTIFICATION_TYPE   One of:
 *                         conflict  - back-merge conflict detected
 *                         clean_pr  - back-merge clean, PR raised
 *                         summary   - final release cut summary
 *
 * Additional environment variables per type:
 *
 *   conflict:
 *     NEW_VERSION_LABEL, PREV_RELEASE_BRANCH, GITHUB_ACTOR,
 *     CONFLICT_FILES (comma-separated), PR_URL
 *
 *   clean_pr:
 *     NEW_VERSION_LABEL, PR_URL, GITHUB_ACTOR
 *
 *   summary:
 *     NEW_VERSION_LABEL, NEW_RELEASE_BRANCH, NEW_PRERELEASE_TAG,
 *     PREV_LATEST_TAG, PREV_RELEASE_BRANCH,
 *     TICKET_COUNT, FILTER_URL, JIRA_RELEASE_TICKET,
 *     UNTAGGED_TICKETS (comma-separated, may be empty),
 *     ACM_RESULT, JIRA_RESULT, PRS_RESULT,
 *     GITHUB_ACTOR, RUN_NUMBER, RUN_URL
 */

const https = require('https');
const url   = require('url');

const WEBHOOK  = process.env.SLACK_WEBHOOK_URL;
const TYPE     = process.env.NOTIFICATION_TYPE;

if (!WEBHOOK) { console.error('SLACK_WEBHOOK_URL is required'); process.exit(1); }
if (!TYPE)    { console.error('NOTIFICATION_TYPE is required'); process.exit(1); }

// ── HTTP post to Slack webhook ────────────────────────────────────────────────
function postToSlack(payload) {
  return new Promise((resolve, reject) => {
    const body    = JSON.stringify(payload);
    const parsed  = url.parse(WEBHOOK);
    const options = {
      hostname: parsed.hostname,
      path:     parsed.path,
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`Slack returned HTTP ${res.statusCode}: ${data}`));
        } else {
          resolve(data);
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── field helper — always returns a valid Slack field object ──────────────────
function field(title, value, short = false) {
  return { title, value: value || '—', short };
}

// ── Notification builders ─────────────────────────────────────────────────────

function buildConflict() {
  const conflictFiles = (process.env.CONFLICT_FILES || '')
    .split(',')
    .map(f => f.trim())
    .filter(Boolean);

  const filesText = conflictFiles.length > 0
    ? conflictFiles.map(f => `• ${f}`).join('\n')
    : 'Unknown — check the PR for details';

  return {
    text: '*Release Cut - Merge Conflict Action Required*',
    attachments: [{
      color: 'warning',
      fields: [
        field('Release',           process.env.NEW_VERSION_LABEL,    true),
        field('Triggered by',      process.env.GITHUB_ACTOR,         true),
        field('Back-merge',        `\`${process.env.PREV_RELEASE_BRANCH}\` to \`develop\``),
        field('Conflicting files', filesText),
        field('Pull request',      process.env.PR_URL),
        field('Next step',         'Resolve the conflicts, merge the pull request into develop. The workflow will automatically continue once the pull request is merged.'),
      ],
      footer: `Run #${process.env.RUN_NUMBER || '?'}`,
    }],
  };
}

function buildCleanPR() {
  return {
    text: '*Release Cut - Back-merge Pull Request Raised (No Conflicts)*',
    attachments: [{
      color: 'good',
      fields: [
        field('Release',        process.env.NEW_VERSION_LABEL, true),
        field('Triggered by',   process.env.GITHUB_ACTOR,      true),
        field('Pull request',   process.env.PR_URL),
        field('Action required', 'Review and merge the pull request into develop. The workflow will automatically continue once the pull request is merged.'),
      ],
      footer: `Run #${process.env.RUN_NUMBER || '?'}`,
    }],
  };
}

function buildSummary() {
  const acm   = process.env.ACM_RESULT  || 'unknown';
  const jira  = process.env.JIRA_RESULT || 'unknown';
  const prs   = process.env.PRS_RESULT  || 'unknown';
  const allOk = acm === 'success' && jira === 'success' && prs === 'success';

  const untagged = (process.env.UNTAGGED_TICKETS || '')
    .split(',')
    .map(t => t.trim())
    .filter(Boolean);

  const untaggedText = untagged.length > 0
    ? `${untagged.length} ticket(s) found with code merged but no fix version: ${untagged.join(', ')}`
    : 'None';

  const fields = [
    field('New release branch',   `\`${process.env.NEW_RELEASE_BRANCH}\``,  true),
    field('Pre-release tag',      `\`${process.env.NEW_PRERELEASE_TAG}\``,   true),
    field('Previous latest tag',  `\`${process.env.PREV_LATEST_TAG}\` created on \`${process.env.PREV_RELEASE_BRANCH}\``),
    field('Tickets confirmed',    `${process.env.TICKET_COUNT || 0} tickets tagged to fix version`),
    field('Jira filter',          process.env.FILTER_URL),
    field('Release ticket',       `${process.env.JIRA_RELEASE_TICKET} - description updated`),
    field('Stage pipeline',       acm === 'success' ? 'Triggered in Adobe Cloud Manager successfully' : `ACM step result: ${acm}`),
    field('Untagged tickets',     untaggedText),
    field('Workflow run',         process.env.RUN_URL),
  ];

  return {
    text: `*ADCMS Release Cut - ${process.env.NEW_VERSION_LABEL}* ${allOk ? '(Completed Successfully)' : '(Completed with Warnings)'}`,
    attachments: [{
      color:  allOk ? 'good' : 'danger',
      fields,
      footer: `Triggered by ${process.env.GITHUB_ACTOR} - Run #${process.env.RUN_NUMBER || '?'}`,
    }],
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  let payload;

  switch (TYPE) {
    case 'conflict': payload = buildConflict(); break;
    case 'clean_pr': payload = buildCleanPR();  break;
    case 'summary':  payload = buildSummary();  break;
    default:
      console.error(`Unknown NOTIFICATION_TYPE: "${TYPE}". Must be conflict | clean_pr | summary`);
      process.exit(1);
  }

  console.log(`[Slack] Sending "${TYPE}" notification`);
  await postToSlack(payload);
  console.log(`[Slack] Notification sent successfully`);
}

main().catch(err => { console.error(`[Slack] Error: ${err.message}`); process.exit(1); });