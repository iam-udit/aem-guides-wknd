#!/usr/bin/env node
/**
 * slack.js
 * --------
 * Handles all Slack notifications for the release cut workflow using threaded messages.
 *
 * Thread Structure:
 * 1. Main thread message - posted at workflow start
 * 2. Back-merge reply - posted after back-merge completes
 * 3. Final summary reply - posted at workflow end
 *
 * Environment variables:
 *   SLACK_BOT_TOKEN     Slack Bot User OAuth Token (xoxb-...)
 *   SLACK_CHANNEL_ID    Channel ID (e.g., C01234567)
 *   NOTIFICATION_TYPE   One of: start | backmerge | summary
 *   
 *   For 'start':
 *     NEW_VERSION_LABEL, GITHUB_ACTOR, RUN_NUMBER, RUN_URL
 *   
 *   For 'backmerge':
 *     NEW_VERSION_LABEL, PREV_RELEASE_BRANCH, PR_URL, HAD_CONFLICT, 
 *     CONFLICT_FILES (comma-separated), THREAD_TS (from start message)
 *   
 *   For 'summary':
 *     NEW_VERSION_LABEL, NEW_RELEASE_BRANCH, NEW_PRERELEASE_TAG,
 *     PREV_LATEST_TAG, PREV_RELEASE_BRANCH, TICKET_COUNT, FILTER_URL,
 *     JIRA_RELEASE_TICKET, UNTAGGED_TICKETS, ACM_RESULT, JIRA_RESULT,
 *     PRS_RESULT, GITHUB_ACTOR, RUN_NUMBER, RUN_URL, WORKFLOW_DURATION,
 *     THREAD_TS (from start message)
 */

const https = require('https');
const url   = require('url');
const fs    = require('fs');

const BOT_TOKEN  = process.env.SLACK_BOT_TOKEN;
const CHANNEL_ID = process.env.SLACK_CHANNEL_ID;
const TYPE       = process.env.NOTIFICATION_TYPE;

if (!BOT_TOKEN)  { console.error('SLACK_BOT_TOKEN is required'); process.exit(1); }
if (!CHANNEL_ID) { console.error('SLACK_CHANNEL_ID is required'); process.exit(1); }
if (!TYPE)       { console.error('NOTIFICATION_TYPE is required'); process.exit(1); }

// ── HTTP post to Slack API ────────────────────────────────────────────────────
function postToSlack(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const options = {
      hostname: 'slack.com',
      path:     '/api/chat.postMessage',
      method:   'POST',
      headers: {
        'Authorization':  `Bearer ${BOT_TOKEN}`,
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const response = JSON.parse(data);
          if (!response.ok) {
            reject(new Error(`Slack API error: ${response.error || 'Unknown error'}`));
          } else {
            resolve(response);
          }
        } catch (err) {
          reject(new Error(`Failed to parse Slack response: ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Build start message (main thread) ─────────────────────────────────────────
function buildStartMessage() {
  const runUrl = process.env.RUN_URL || '';
  const actor = process.env.GITHUB_ACTOR || 'unknown';
  const runNumber = process.env.RUN_NUMBER || '?';
  const release = process.env.NEW_VERSION_LABEL || '';

  return {
    channel: CHANNEL_ID,
    text: `🚀 Release Cut Started: ${release}`,
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: `🚀 Release Cut Started: ${release}`,
          emoji: true
        }
      },
      {
        type: 'section',
        fields: [
          {
            type: 'mrkdwn',
            text: `*Workflow Run:*\n#${runNumber}`
          },
          {
            type: 'mrkdwn',
            text: `*Triggered By:*\n@${actor}`
          },
          {
            type: 'mrkdwn',
            text: `*Status:*\nIn Progress ⏳`
          }
        ]
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*📋 Steps:*\n⏳ Back-merge previous release → develop\n⏸️ Cut new release branch\n⏸️ Rotate tags\n⏸️ Adobe Cloud Manager pipeline\n⏸️ Jira updates\n⏸️ PR notifications\n⏸️ Final summary`
        }
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: '🔗 View Workflow',
              emoji: true
            },
            url: runUrl
          }
        ]
      }
    ]
  };
}

// ── Build back-merge reply (thread reply) ─────────────────────────────────────
function buildBackmergeReply() {
  const hadConflict = process.env.HAD_CONFLICT === 'true';
  const prUrl = process.env.PR_URL || '';
  const prevBranch = process.env.PREV_RELEASE_BRANCH || '';
  const threadTs = process.env.THREAD_TS;

  if (!threadTs) {
    console.log('[Slack] THREAD_TS not provided, posting as standalone message');
  }

  if (hadConflict) {
    const conflictFiles = (process.env.CONFLICT_FILES || '')
      .split(',')
      .map(f => f.trim())
      .filter(Boolean)
      .map(f => `• \`${f}\``)
      .join('\n');

    const payload = {
      channel: CHANNEL_ID,
      text: `⚠️ Back-merge Conflicts Detected`,
      blocks: [
        {
          type: 'header',
          text: {
            type: 'plain_text',
            text: '⚠️ Back-merge Conflicts Detected',
            emoji: true
          }
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `Back-merge PR created: \`${prevBranch}\` → \`develop\``
          }
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Conflicting files:*\n${conflictFiles || 'Unknown — check the PR for details'}`
          }
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Action Required:*\n1. Check out the back-merge branch\n2. Resolve all conflict markers\n3. Commit and push the resolution\n4. Merge the PR into \`develop\`\n5. Workflow will automatically continue once merged`
          }
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: {
                type: 'plain_text',
                text: '🔗 View PR',
                emoji: true
              },
              url: prUrl,
              style: 'danger'
            }
          ]
        }
      ]
    };
    
    // Only add thread_ts if it's available
    if (threadTs) {
      payload.thread_ts = threadTs;
    }
    
    return payload;
  } else {
    const payload = {
      channel: CHANNEL_ID,
      text: `✅ Back-merge Completed (No Conflicts)`,
      blocks: [
        {
          type: 'header',
          text: {
            type: 'plain_text',
            text: '✅ Back-merge Completed (No Conflicts)',
            emoji: true
          }
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `Back-merge PR created: \`${prevBranch}\` → \`develop\``
          }
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Action Required:*\n• Review and merge the PR into \`develop\`\n• Workflow will automatically continue once merged`
          }
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: {
                type: 'plain_text',
                text: '🔗 View PR',
                emoji: true
              },
              url: prUrl,
              style: 'primary'
            }
          ]
        }
      ]
    };
    
    // Only add thread_ts if it's available
    if (threadTs) {
      payload.thread_ts = threadTs;
    }
    
    return payload;
  }
}

// ── Build summary reply (thread reply) ────────────────────────────────────────
function buildSummaryReply() {
  const acm = process.env.ACM_RESULT || 'unknown';
  const jira = process.env.JIRA_RESULT || 'unknown';
  const prs = process.env.PRS_RESULT || 'unknown';
  const allOk = acm === 'success' && jira === 'success' && prs === 'success';
  const threadTs = process.env.THREAD_TS;

  if (!threadTs) {
    console.log('[Slack] THREAD_TS not provided, posting as standalone message');
  }

  const release = process.env.NEW_VERSION_LABEL || '';
  const newBranch = process.env.NEW_RELEASE_BRANCH || '';
  const newTag = process.env.NEW_PRERELEASE_TAG || '';
  const prevTag = process.env.PREV_LATEST_TAG || '';
  const prevBranch = process.env.PREV_RELEASE_BRANCH || '';
  const ticketCount = process.env.TICKET_COUNT || '0';
  const filterUrl = process.env.FILTER_URL || '';
  const releaseTicket = process.env.JIRA_RELEASE_TICKET || '';
  const duration = process.env.WORKFLOW_DURATION || 'N/A';
  const runUrl = process.env.RUN_URL || '';
  const actor = process.env.GITHUB_ACTOR || 'unknown';
  const runNumber = process.env.RUN_NUMBER || '?';

  const untagged = (process.env.UNTAGGED_TICKETS || '')
    .split(',')
    .map(t => t.trim())
    .filter(Boolean);

  const untaggedText = untagged.length > 0
    ? untagged.join(', ')
    : 'None';

  if (allOk) {
    const payload = {
      channel: CHANNEL_ID,
      text: `✅ Release Cut Completed Successfully`,
      blocks: [
        {
          type: 'header',
          text: {
            type: 'plain_text',
            text: '✅ Release Cut Completed Successfully',
            emoji: true
          }
        },
        {
          type: 'section',
          fields: [
            {
              type: 'mrkdwn',
              text: `*Release:*\n${release}`
            },
            {
              type: 'mrkdwn',
              text: `*Duration:*\n${duration}`
            }
          ]
        },
        {
          type: 'divider'
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*📦 Release Details:*\n• New branch: \`${newBranch}\`\n• Pre-release tag: \`${newTag}\`\n• Previous latest tag: \`${prevTag}\` (on \`${prevBranch}\`)`
          }
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*📊 Jira Updates:*\n• Tickets confirmed: ${ticketCount} tickets tagged to fix version\n• Untagged tickets: ${untaggedText}\n• <${filterUrl}|View Filter>\n• Release ticket: ${releaseTicket} - description updated`
          }
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*☁️ Adobe Cloud Manager:*\n• Stage pipeline triggered successfully`
          }
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*💬 PR Notifications:*\n• All open PRs targeting \`develop\` have been notified`
          }
        },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: `Triggered by @${actor} • Run #${runNumber} • <${runUrl}|View Workflow>`
            }
          ]
        }
      ]
    };
    
    // Only add thread_ts if it's available
    if (threadTs) {
      payload.thread_ts = threadTs;
    }
    
    return payload;
  } else {
    // Build failure details
    const failedSteps = [];
    if (acm !== 'success') failedSteps.push(`• ❌ Adobe Cloud Manager pipeline (${acm})`);
    if (jira !== 'success') failedSteps.push(`• ❌ Jira updates (${jira})`);
    if (prs !== 'success') failedSteps.push(`• ❌ PR notifications (${prs})`);

    const payload = {
      channel: CHANNEL_ID,
      text: `❌ Release Cut Failed`,
      blocks: [
        {
          type: 'header',
          text: {
            type: 'plain_text',
            text: '❌ Release Cut Failed',
            emoji: true
          }
        },
        {
          type: 'section',
          fields: [
            {
              type: 'mrkdwn',
              text: `*Release:*\n${release}`
            },
            {
              type: 'mrkdwn',
              text: `*Duration:*\n${duration}`
            }
          ]
        },
        {
          type: 'divider'
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*⚠️ Failed Steps:*\n${failedSteps.join('\n')}`
          }
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*🔧 Next Steps:*\n1. Check the workflow logs for detailed error messages\n2. Resolve any issues manually\n3. Re-run failed jobs if needed`
          }
        },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: `Triggered by @${actor} • Run #${runNumber} • <${runUrl}|View Logs>`
            }
          ]
        }
      ]
    };
    
    // Only add thread_ts if it's available
    if (threadTs) {
      payload.thread_ts = threadTs;
    }
    
    return payload;
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  let payload;
  let messageType;

  switch (TYPE) {
    case 'start':
      payload = buildStartMessage();
      messageType = 'start (main thread)';
      break;
    case 'backmerge':
      payload = buildBackmergeReply();
      messageType = 'back-merge (thread reply)';
      break;
    case 'summary':
      payload = buildSummaryReply();
      messageType = 'summary (thread reply)';
      break;
    default:
      console.error(`Unknown NOTIFICATION_TYPE: "${TYPE}". Must be start | backmerge | summary`);
      process.exit(1);
  }

  console.log(`[Slack] Sending "${messageType}" notification`);
  const response = await postToSlack(payload);
  console.log(`[Slack] Notification sent successfully`);

  // For start message, save the thread timestamp for later replies
  if (TYPE === 'start' && response.ts) {
    const outputFile = process.env.GITHUB_OUTPUT;
    if (outputFile) {
      fs.appendFileSync(outputFile, `slack_thread_ts=${response.ts}\n`);
      console.log(`[Slack] Thread timestamp saved: ${response.ts}`);
    }
  }
}

main().catch(err => { console.error(`[Slack] Error: ${err.message}`); process.exit(1); });

// Made with Bob
