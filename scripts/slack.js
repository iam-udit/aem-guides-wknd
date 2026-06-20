#!/usr/bin/env node
/**
 * slack.js
 * --------
 * Handles all Slack notifications for the release cut workflow using threaded messages.
 *
 * Thread Structure:
 * 1. Main thread message - posted at workflow start
 * 2. Back-merge reply - posted after back-merge completes
 * 3. Conflict owners reply - posted when conflicts are detected (optional)
 * 4. Final summary reply - posted at workflow end
 *
 * Environment variables:
 *   SLACK_BOT_TOKEN     Slack Bot User OAuth Token (xoxb-...)
 *   SLACK_CHANNEL_ID    Channel ID (e.g., C01234567)
 *   NOTIFICATION_TYPE   One of: start | backmerge | conflict_owners | summary
 *
 *   For 'start':
 *     NEW_VERSION_LABEL, GITHUB_ACTOR, RUN_NUMBER, RUN_URL
 *
 *   For 'backmerge':
 *     NEW_VERSION_LABEL, PREV_RELEASE_BRANCH, PR_BRANCH, PR_URL, ALREADY_MERGED,
 *     HAD_CONFLICT, CONFLICT_FILES (comma-separated), THREAD_TS (from start message)
 *
 *   For 'conflict_owners':
 *     OWNERS_JSON (path to JSON file), THREAD_TS, PR_URL, NEW_VERSION_LABEL
 *
 *   For 'summary':
 *     NEW_VERSION_LABEL, NEW_RELEASE_BRANCH, NEW_PRERELEASE_TAG,
 *     PREV_LATEST_TAG, PREV_RELEASE_BRANCH, TICKET_COUNT, FILTER_URL,
 *     JIRA_RELEASE_TICKET, UNTAGGED_TICKETS, ACM_RESULT, JIRA_RESULT,
 *     PRS_RESULT, GITHUB_ACTOR, RUN_NUMBER, RUN_URL, WORKFLOW_DURATION,
 *     THREAD_TS (from start message)
 */

const https = require('https');
const fs    = require('fs');

/**
 * Reads and validates a required environment variable.
 *
 * @param {string} name Environment variable name.
 * @returns {string} Trimmed environment variable value.
 * @throws {Error} Thrown when the variable is missing or blank.
 */
function requireEnv(name) {
  const value = process.env[name];
  if (!value || !String(value).trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return String(value).trim();
}

const BOT_TOKEN  = requireEnv('SLACK_BOT_TOKEN');
const CHANNEL_ID = requireEnv('SLACK_CHANNEL_ID');
const TYPE       = requireEnv('NOTIFICATION_TYPE');

/**
 * Sends a message payload to Slack using chat.postMessage.
 *
 * @param {object} payload Slack message payload.
 * @returns {Promise<object>} Parsed Slack API response.
 */
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

/**
 * Builds the root Slack thread message posted when the workflow starts.
 *
 * @returns {object} Slack message payload for the workflow start notification.
 */
function buildStartMessage() {
  const runUrl = process.env.RUN_URL || '';
  const actor = process.env.GITHUB_ACTOR || 'unknown';
  const runNumber = process.env.RUN_NUMBER || '?';
  const release = process.env.NEW_VERSION_LABEL || '';

  return {
    channel: CHANNEL_ID,
    text: `:rocket: Release Cut Started: ${release}`,
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: `:rocket: Release Cut Started: ${release}`,
          emoji: true
        }
      },
      {
        type: 'section',
        fields: [
          {
            type: 'mrkdwn',
            text: `*Release*\n${release}`
          },
          {
            type: 'mrkdwn',
            text: `*Status*\nIn Progress`
          },
          {
            type: 'mrkdwn',
            text: `*Workflow Run*\n#${runNumber}`
          },
          {
            type: 'mrkdwn',
            text: `*Triggered By*\n@${actor}`
          }
        ]
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*Planned Stages*\n• Back-merge previous release into `develop`\n• Cut next release branch\n• Rotate release tags\n• Update Adobe Cloud Manager pipeline\n• Update Jira artifacts\n• Notify open pull requests\n• Publish final summary'
        }
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: 'View Workflow',
              emoji: false
            },
            url: runUrl
          }
        ]
      }
    ]
  };
}

/**
 * Builds the threaded Slack reply for the back-merge stage.
 *
 * @returns {object} Slack message payload describing clean merge or conflict status.
 */
function buildBackmergeReply() {
  const alreadyMerged = process.env.ALREADY_MERGED === 'true';
  const hadConflict = process.env.HAD_CONFLICT === 'true';
  const prUrl = process.env.PR_URL || '';
  const prevBranch = process.env.PREV_RELEASE_BRANCH || '';
  const prBranch = process.env.PR_BRANCH || '';
  const threadTs = process.env.THREAD_TS;

  if (!threadTs) {
    console.log('[Slack] THREAD_TS not provided, posting as standalone message');
  }

  // Handle "already merged" scenario - branches are in sync
  if (alreadyMerged) {
    const runUrl = process.env.RUN_URL || '';
    
    const payload = {
      channel: CHANNEL_ID,
      text: ':white_check_mark: Back-merge Not Required (Already in Sync) - Approval Needed',
      blocks: [
        {
          type: 'header',
          text: {
            type: 'plain_text',
            text: ':white_check_mark: Back-merge Not Required (Already in Sync)',
            emoji: true
          }
        },
        {
          type: 'section',
          fields: [
            {
              type: 'mrkdwn',
              text: '*Stage*\nBack-merge'
            },
            {
              type: 'mrkdwn',
              text: '*Status*\nAwaiting Approval'
            }
          ]
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Scope*\nPrevious release branch \`${prevBranch}\` is already merged into \`develop\`.`
          }
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: '*Result*\nNo changes detected between branches — back-merge was likely completed manually.'
          }
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: '*Required Action*\n• Verify that the manual back-merge is correct and intentional\n• Review the workflow run and approve to continue\n• Workflow will proceed with remaining release cut steps after approval'
          }
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: {
                type: 'plain_text',
                text: 'Review & Approve Workflow',
                emoji: false
              },
              url: runUrl,
              style: 'primary'
            }
          ]
        }
      ]
    };

    if (threadTs) {
      payload.thread_ts = threadTs;
    }

    return payload;
  }

  const payload = hadConflict
    ? {
        channel: CHANNEL_ID,
        text: ':warning: Back-merge PR Raised (Merge Conflicts)',
        blocks: [
          {
            type: 'header',
            text: {
              type: 'plain_text',
              text: ':warning: Back-merge PR Raised (Merge Conflicts)',
              emoji: true
            }
          },
          {
            type: 'section',
            fields: [
              {
                type: 'mrkdwn',
                text: '*Stage*\nBack-merge'
              },
              {
                type: 'mrkdwn',
                text: '*Status*\nConflicts Require Action'
              }
            ]
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*Scope*\nPrevious release branch \`${prevBranch}\` is being merged into \`develop\`.`
            }
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*Conflicting Files*\n${(process.env.CONFLICT_FILES || '')
                .split(',')
                .map(f => f.trim())
                .filter(Boolean)
                .map(f => `• \`${f}\``)
                .join('\n') || '• Review the pull request for file-level details.'}`
            }
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*Required Action*\n• Check out the back-merge branch${prBranch ? ` \`${prBranch}\`` : ''}\n• Resolve all merge conflicts\n• Commit and push the resolution\n• Merge the pull request into \`develop\`\n• Workflow execution will continue automatically after merge`
            }
          },
          {
            type: 'actions',
            elements: [
              {
                type: 'button',
                text: {
                  type: 'plain_text',
                  text: 'Open Pull Request',
                  emoji: false
                },
                url: prUrl,
                style: 'danger'
              }
            ]
          }
        ]
      }
    : {
        channel: CHANNEL_ID,
        text: ':white_check_mark: Back-merge PR Raised (No Conflicts)',
        blocks: [
          {
            type: 'header',
            text: {
              type: 'plain_text',
              text: ':white_check_mark: Back-merge PR Raised (No Conflicts)',
              emoji: true
            }
          },
          {
            type: 'section',
            fields: [
              {
                type: 'mrkdwn',
                text: '*Stage*\nBack-merge'
              },
              {
                type: 'mrkdwn',
                text: '*Status*\nReady for Review'
              }
            ]
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*Scope*\nPrevious release branch \`${prevBranch}\` has been merged into the back-merge PR targeting \`develop\`.`
            }
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*Required Action*\n• Check out the back-merge branch${prBranch ? ` \`${prBranch}\`` : ''}\n• Review and merge the pull request into \`develop\`\n• Workflow execution will continue automatically after merge`
            }
          },
          {
            type: 'actions',
            elements: [
              {
                type: 'button',
                text: {
                  type: 'plain_text',
                  text: 'Open Pull Request',
                  emoji: false
                },
                url: prUrl,
                style: 'primary'
              }
            ]
          }
        ]
      };

  if (threadTs) {
    payload.thread_ts = threadTs;
  }

  return payload;
}

/**
 * Builds the threaded Slack summary message for workflow completion.
 *
 * @returns {object} Slack message payload for success or failure summary.
 */
function buildSummaryReply() {
  const acm = process.env.ACM_RESULT || 'unknown';
  const acmStatus = process.env.ACM_STATUS || acm;
  const acmError = process.env.ACM_ERROR_MESSAGE || '';
  const jira = process.env.JIRA_RESULT || 'unknown';
  const prs = process.env.PRS_RESULT || 'unknown';
  
  // Core workflow success = Jira + PRs succeeded (ACM is optional)
  const coreSuccess = jira === 'success' && prs === 'success';
  const acmFailed = acm !== 'success';
  
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
  const jiraBase = process.env.JIRA_BASE_URL || '';
  const releaseTicketUrl = jiraBase && releaseTicket ? `${jiraBase}/browse/${releaseTicket}` : '';
  const duration = process.env.WORKFLOW_DURATION || 'N/A';
  const runUrl = process.env.RUN_URL || '';
  const actor = process.env.GITHUB_ACTOR || 'unknown';
  const runNumber = process.env.RUN_NUMBER || '?';

  const untagged = (process.env.UNTAGGED_TICKETS || '')
    .split(',')
    .map(t => t.trim())
    .filter(Boolean);

  const untaggedText = untagged.length > 0
    ? `\n${untagged.map(ticket => `• ${ticket}`).join('\n')}`
    : ' None';

  // Build ACM status section
  const acmStatusText = acmFailed
    ? `*Adobe Cloud Manager* (Optional)\n• Status: Failed\n• ${acmError || 'Check workflow logs for details'}\n• Action: Update pipeline branch and trigger build manually in Cloud Manager`
    : `*Adobe Cloud Manager*\n• Pipeline branch updated to \`${newBranch}\`\n• Stage pipeline triggered successfully`;

  const payload = coreSuccess
    ? {
        channel: CHANNEL_ID,
        text: acmFailed
          ? `:white_check_mark: Release Cut Completed (ACM Warning): ${release}`
          : `:white_check_mark: Release Cut Completed: ${release}`,
        blocks: [
          {
            type: 'header',
            text: {
              type: 'plain_text',
              text: acmFailed
                ? `:white_check_mark: Release Cut Completed (ACM Warning): ${release}`
                : `:white_check_mark: Release Cut Completed: ${release}`,
              emoji: true
            }
          },
          {
            type: 'section',
            fields: [
              {
                type: 'mrkdwn',
                text: `*Release*\n${release}`
              },
              {
                type: 'mrkdwn',
                text: acmFailed ? `*Status*\nCompleted with ACM Warning` : `*Status*\nCompleted`
              },
              {
                type: 'mrkdwn',
                text: `*Duration*\n${duration}`
              },
              {
                type: 'mrkdwn',
                text: `*Workflow Run*\n#${runNumber}`
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
              text: `*Release Artifacts*\n• New release branch: \`${newBranch}\`\n• New pre-release tag: \`${newTag}\`\n• Previous latest tag: \`${prevTag}\` on \`${prevBranch}\``
            }
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*Jira Outcome*\n• Confirmed tickets: ${ticketCount}\n• Untagged tickets requiring review:\n${untaggedText}\n• Filter: <${filterUrl}|Open filter>\n• Release ticket: <${releaseTicketUrl}|${releaseTicket}>`
            }
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: acmStatusText
            }
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*Core Workflow Status*\n• Jira artifacts updated\n• Open pull requests notified`
            }
          },
          ...(acmFailed ? [{
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: ':information_source: *Note:* Adobe Cloud Manager is an optional step. The release cut completed successfully. Please update the pipeline manually in Cloud Manager.'
            }
          }] : []),
          {
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text: `Triggered by @${actor} • <${runUrl}|View workflow>`
              }
            ]
          }
        ]
      }
    : {
        channel: CHANNEL_ID,
        text: `:x: Release Cut Failed: ${release}`,
        blocks: [
          {
            type: 'header',
            text: {
              type: 'plain_text',
              text: `:x: Release Cut Failed: ${release}`,
              emoji: true
            }
          },
          {
            type: 'section',
            fields: [
              {
                type: 'mrkdwn',
                text: `*Release*\n${release}`
              },
              {
                type: 'mrkdwn',
                text: `*Status*\nFailed`
              },
              {
                type: 'mrkdwn',
                text: `*Duration*\n${duration}`
              },
              {
                type: 'mrkdwn',
                text: `*Workflow Run*\n#${runNumber}`
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
              text: `*Failed Steps*\n${[
                jira !== 'success' ? `• Jira updates: ${jira}` : null,
                prs !== 'success' ? `• PR notifications: ${prs}` : null
              ].filter(Boolean).join('\n') || '• Review workflow logs for details.'}`
            }
          },
          ...(acmFailed ? [{
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*Adobe Cloud Manager* (Optional)\n• Also failed, but this is not blocking\n${acmError ? `• ${acmError}` : ''}`
            }
          }] : []),
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: '*Required Follow-up*\n• Review workflow logs\n• Fix failed steps and re-run workflow\n• If only ACM failed, update Cloud Manager manually'
            }
          },
          {
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text: `Triggered by @${actor} • <${runUrl}|View workflow logs>`
              }
            ]
          }
        ]
      };

  if (threadTs) {
    payload.thread_ts = threadTs;
  }

  return payload;
}

/**
 * Builds the threaded Slack reply for conflict owners notification.
 *
 * @returns {object} Slack message payload listing file owners for each conflicting file.
 */
function buildConflictOwnersReply() {
  const ownersJsonPath = process.env.OWNERS_JSON;
  const threadTs = process.env.THREAD_TS;
  const prUrl = process.env.PR_URL || '';
  const release = process.env.NEW_VERSION_LABEL || '';

  if (!threadTs) {
    console.log('[Slack] THREAD_TS not provided, posting as standalone message');
  }

  if (!ownersJsonPath) {
    throw new Error('OWNERS_JSON environment variable is required for conflict_owners notification');
  }

  // Read the owners JSON file
  let ownersData;
  try {
    const fileContent = fs.readFileSync(ownersJsonPath, 'utf8');
    ownersData = JSON.parse(fileContent);
  } catch (err) {
    throw new Error(`Failed to read or parse owners JSON from ${ownersJsonPath}: ${err.message}`);
  }

  const { files, unique_owners, release_cut_owner_slack_id } = ownersData;

  // Build file list with owners
  const fileBlocks = files.map(file => {
    const developHandle = file.develop_owner.slack_id
      ? `<@${file.develop_owner.slack_id}>`
      : file.develop_owner.slack_handle;
    
    const releaseHandle = file.release_owner.slack_id
      ? `<@${file.release_owner.slack_id}>`
      : file.release_owner.slack_handle;

    return {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*\`${file.path}\`*\n• Develop branch owner: ${developHandle}\n• Release branch owner: ${releaseHandle}`
      }
    };
  });

  // Build unique owners mention line
  const ownerMentions = unique_owners.map(id => `<@${id}>`).join(', ');
  const allOwnersMention = ownerMentions || 'No owners could be resolved';

  // Build release cut owner mention
  const releaseCutOwnerMention = release_cut_owner_slack_id
    ? `<@${release_cut_owner_slack_id}>`
    : process.env.GITHUB_ACTOR || 'Release cut owner';

  const payload = {
    channel: CHANNEL_ID,
    text: ':busts_in_silhouette: Conflict Owners — Action Required',
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: ':busts_in_silhouette: Conflict Owners — Action Required',
          emoji: true
        }
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `The following files have merge conflicts in the back-merge pull request. Each file shows the last person who modified it on both branches.`
        }
      },
      {
        type: 'divider'
      },
      ...fileBlocks,
      {
        type: 'divider'
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*All File Owners*\n${allOwnersMention}`
        }
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Release Cut Owner*\n${releaseCutOwnerMention}`
        }
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*Required Action*\n• Review the conflicting files listed above\n• Coordinate with the file owners to resolve conflicts\n• Resolve conflicts in the pull request\n• Merge the PR into `develop`'
        }
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: 'Open Pull Request',
              emoji: false
            },
            url: prUrl,
            style: 'danger'
          }
        ]
      }
    ]
  };

  if (threadTs) {
    payload.thread_ts = threadTs;
  }

  return payload;
}

/**
 * Selects the requested notification type, posts it to Slack, and exports thread metadata.
 *
 * @returns {Promise<void>} Resolves when the Slack notification has been sent.
 */
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
    case 'conflict_owners':
      payload = buildConflictOwnersReply();
      messageType = 'conflict owners (thread reply)';
      break;
    case 'summary':
      payload = buildSummaryReply();
      messageType = 'summary (thread reply)';
      break;
    default:
      console.error(`Unknown NOTIFICATION_TYPE: "${TYPE}". Must be start | backmerge | conflict_owners | summary`);
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

main().catch(err => {
  console.error(`[Slack] Fatal error: ${err.message}`);
  process.exit(1);
});

// Made with Bob