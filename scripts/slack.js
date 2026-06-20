#!/usr/bin/env node
/**
 * slack.js
 * --------
 * Handles all Slack notifications for the release cut workflow using threaded messages.
 *
 * Thread Structure:
 * 1. Main thread message - posted at workflow start
 * 2. Back-merge reply - posted after back-merge completes (includes conflict owners if conflicts exist)
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
 *     NEW_VERSION_LABEL, PREV_RELEASE_BRANCH, PR_BRANCH, PR_URL, ALREADY_MERGED,
 *     HAD_CONFLICT, CONFLICT_FILES (comma-separated), OWNERS_JSON (optional, for conflict owners),
 *     THREAD_TS (from start message)
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
  const ownersJsonPath = process.env.OWNERS_JSON;

  if (!threadTs) {
    console.log('[Slack] THREAD_TS not provided, posting as standalone message');
  }

  // Load owners data if conflicts exist and owners file is provided
  let ownersData = null;
  if (hadConflict && ownersJsonPath) {
    try {
      const fileContent = fs.readFileSync(ownersJsonPath, 'utf8');
      ownersData = JSON.parse(fileContent);
    } catch (err) {
      console.warn(`[Slack] Could not load owners data: ${err.message}`);
    }
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

  // Build conflict payload with optional owner information
  const conflictBlocks = [
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
    }
  ];

  // Add file owners section if available
  if (ownersData && ownersData.files && ownersData.files.length > 0) {
    // Add divider before file owners
    conflictBlocks.push({ type: 'divider' });
    
    // Add each file with its owners
    ownersData.files.forEach(file => {
      const developHandle = file.develop_owner.slack_id
        ? `<@${file.develop_owner.slack_id}>`
        : file.develop_owner.slack_handle;
      
      const releaseHandle = file.release_owner.slack_id
        ? `<@${file.release_owner.slack_id}>`
        : file.release_owner.slack_handle;

      conflictBlocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*\`${file.path}\`*\n• Develop branch owner: ${developHandle}\n• Release branch owner: ${releaseHandle}`
        }
      });
    });

    // Add divider after file owners
    conflictBlocks.push({ type: 'divider' });

    // Add all file owners mention
    const ownerMentions = ownersData.unique_owners.map(id => `<@${id}>`).join(', ');
    if (ownerMentions) {
      conflictBlocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*All File Owners*\n${ownerMentions}`
        }
      });
    }

    // Add release cut owner if available
    if (ownersData.release_cut_owner_slack_id) {
      conflictBlocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Release Cut Owner*\n<@${ownersData.release_cut_owner_slack_id}>`
        }
      });
    }
  } else {
    // Fallback to simple file list if no owner data
    conflictBlocks.push({
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
    });
  }

  // Add required action section
  conflictBlocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `*Required Action*\n• Check out the back-merge branch${prBranch ? ` \`${prBranch}\`` : ''}\n• Resolve all merge conflicts\n• Commit and push the resolution\n• Merge the pull request into \`develop\`\n• Workflow execution will continue automatically after merge`
    }
  });

  // Add PR button
  conflictBlocks.push({
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
  });

  const payload = hadConflict
    ? {
        channel: CHANNEL_ID,
        text: ':warning: Back-merge PR Raised (Merge Conflicts)',
        blocks: conflictBlocks
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
  const acmPipelineUrl = process.env.ACM_PIPELINE_URL || '';
  const backMerge = process.env.BACK_MERGE_RESULT || 'unknown';
  const approval = process.env.APPROVAL_RESULT || 'unknown';
  const awaitPr = process.env.AWAIT_PR_RESULT || 'unknown';
  const cutBranch = process.env.CUT_BRANCH_RESULT || 'unknown';
  const rotateTags = process.env.ROTATE_TAGS_RESULT || 'unknown';
  const jira = process.env.JIRA_RESULT || 'unknown';
  const prs = process.env.PRS_RESULT || 'unknown';

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

  function isFailureLike(result) {
    return ['failure', 'cancelled', 'timed_out', 'action_required'].includes(result);
  }

  function describeResult(result, successText, failureText, cancelledText, skippedText) {
    if (result === 'success') return successText;
    if (result === 'cancelled') return cancelledText;
    if (result === 'skipped') return skippedText;
    return failureText;
  }

  function buildFailureReasons() {
    const reasons = [];

    if (backMerge === 'failure') {
      reasons.push('• Back-merge setup failed before the release branch could be cut');
    }

    if (approval === 'cancelled') {
      reasons.push('• Manual approval for the already-merged back-merge path was cancelled');
    } else if (approval === 'failure') {
      reasons.push('• Manual approval for the already-merged back-merge path failed');
    }

    if (awaitPr === 'cancelled') {
      reasons.push('• Waiting for the back-merge PR was cancelled before the PR was merged');
    } else if (awaitPr === 'failure') {
      reasons.push('• Back-merge PR was not merged successfully or timed out while waiting');
    }

    if (cutBranch === 'cancelled') {
      reasons.push('• Release branch creation was cancelled');
    } else if (cutBranch === 'failure') {
      reasons.push('• Failed to create or push the new release branch');
    } else if (cutBranch === 'skipped' && (isFailureLike(approval) || isFailureLike(awaitPr) || backMerge === 'failure')) {
      reasons.push('• Release branch creation was skipped because the back-merge path did not complete successfully');
    }

    if (rotateTags === 'cancelled') {
      reasons.push('• Tag rotation was cancelled');
    } else if (rotateTags === 'failure') {
      reasons.push('• Failed while rotating release tags');
    } else if (rotateTags === 'skipped' && isFailureLike(cutBranch)) {
      reasons.push('• Tag rotation was skipped because the release branch was not created successfully');
    }

    if (jira === 'cancelled') {
      reasons.push('• Jira release updates were cancelled');
    } else if (jira === 'failure') {
      reasons.push('• Jira release updates failed');
    } else if (jira === 'skipped' && isFailureLike(rotateTags)) {
      reasons.push('• Jira release updates were skipped because tag rotation did not complete successfully');
    }

    if (prs === 'cancelled') {
      reasons.push('• Open PR notifications were cancelled');
    } else if (prs === 'failure') {
      reasons.push('• Open PR notifications failed');
    } else if (prs === 'skipped' && isFailureLike(jira)) {
      reasons.push('• Open PR notifications were skipped because Jira release updates did not complete successfully');
    }

    return reasons;
  }

  const coreSuccess = jira === 'success' && prs === 'success';
  const acmFailed = acmStatus !== 'success';
  const failureReasons = buildFailureReasons();

  const acmStatusText = acmFailed
    ? `*Adobe Cloud Manager* (Optional)\n• Status: ${describeResult(acmStatus, 'Success', 'Failed', 'Cancelled', 'Skipped')}\n• ${acmError || 'Check workflow logs for details'}\n• Action: Update pipeline branch and trigger build manually in Cloud Manager`
    : acmPipelineUrl
      ? `*Adobe Cloud Manager*\n• Pipeline branch updated to \`${newBranch}\`\n• Stage pipeline triggered successfully\n• <${acmPipelineUrl}|View Pipeline Execution>`
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
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*Final Progress*\n\`${progressBar}\`\n${progress.completed}/${progress.total} stages completed${progress.failed > 0 ? ` (${progress.failed} failed)` : ''}`
            }
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
              text: `*Failure Summary*\n${failureReasons.join('\n') || '• Review workflow logs for details.'}`
            }
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*Job Results*\n• Back-merge: ${backMerge}\n• Approval gate: ${approval}\n• Await PR merge: ${awaitPr}\n• Cut release branch: ${cutBranch}\n• Rotate tags: ${rotateTags}\n• Jira updates: ${jira}\n• PR notifications: ${prs}`
            }
          },
          ...(acmFailed ? [{
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*Adobe Cloud Manager* (Optional)\n• Status: ${describeResult(acmStatus, 'Success', 'Failed', 'Cancelled', 'Skipped')}\n• Also failed, but this is not blocking\n${acmError ? `• ${acmError}` : ''}`
            }
          }] : []),
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: '*Required Follow-up*\n• Review workflow logs\n• Fix the blocking step and re-run workflow\n• If the back-merge PR is still open, merge it before retrying\n• If only ACM failed, update Cloud Manager manually'
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
 * Builds the Slack message for rollback workflow start.
 *
 * @returns {object} Slack message payload for rollback initiation.
 */
function buildRollbackStartMessage() {
  const runUrl = process.env.RUN_URL || '';
  const actor = process.env.GITHUB_ACTOR || 'unknown';
  const runNumber = process.env.RUN_NUMBER || '?';
  const release = process.env.NEW_VERSION_LABEL || '';
  const reason = process.env.ROLLBACK_REASON || 'Not specified';

  return {
    channel: CHANNEL_ID,
    text: `:warning: Release Rollback Initiated: ${release}`,
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: `:warning: Release Rollback Initiated: ${release}`,
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
            text: `*Status*\nAwaiting Approval`
          },
          {
            type: 'mrkdwn',
            text: `*Workflow Run*\n#${runNumber}`
          },
          {
            type: 'mrkdwn',
            text: `*Initiated By*\n@${actor}`
          }
        ]
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Rollback Reason*\n${reason}`
        }
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*Planned Actions*\n• Delete release branch\n• Delete pre-release tag\n• Restore previous pre-release tag\n• Revert Adobe Cloud Manager pipeline\n• Delete Jira filter\n• Add rollback comment to release ticket\n• Close back-merge PR (if open)\n• Delete bot comments from notified PRs'
        }
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: ':information_source: *This rollback requires manual approval before execution.*'
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
            url: runUrl,
            style: 'danger'
          }
        ]
      }
    ]
  };
}

/**
 * Builds the Slack summary message for rollback completion.
 *
 * @returns {object} Slack message payload for rollback summary.
 */
function buildRollbackSummaryReply() {
  const release = process.env.NEW_VERSION_LABEL || '';
  const releaseBranch = process.env.RELEASE_BRANCH_TO_DELETE || '';
  const prevBranch = process.env.PREVIOUS_RELEASE_BRANCH || '';
  const reason = process.env.ROLLBACK_REASON || 'Not specified';
  const actor = process.env.GITHUB_ACTOR || 'unknown';
  const runNumber = process.env.RUN_NUMBER || '?';
  const runUrl = process.env.RUN_URL || '';
  const threadTs = process.env.THREAD_TS;

  const deleteBranch = process.env.DELETE_BRANCH_RESULT || 'unknown';
  const acm = process.env.ACM_RESULT || 'unknown';
  const acmStatus = process.env.ACM_STATUS || acm;
  const jira = process.env.JIRA_RESULT || 'unknown';
  const prs = process.env.PRS_RESULT || 'unknown';

  if (!threadTs) {
    console.log('[Slack] THREAD_TS not provided, posting as standalone message');
  }

  const allSuccess = deleteBranch === 'success' && jira === 'success' && prs === 'success';
  const acmFailed = acmStatus !== 'success';

  const payload = allSuccess
    ? {
        channel: CHANNEL_ID,
        text: acmFailed
          ? `:white_check_mark: Rollback Completed (ACM Warning): ${release}`
          : `:white_check_mark: Rollback Completed: ${release}`,
        blocks: [
          {
            type: 'header',
            text: {
              type: 'plain_text',
              text: acmFailed
                ? `:white_check_mark: Rollback Completed (ACM Warning): ${release}`
                : `:white_check_mark: Rollback Completed: ${release}`,
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
                text: `*Workflow Run*\n#${runNumber}`
              },
              {
                type: 'mrkdwn',
                text: `*Initiated By*\n@${actor}`
              }
            ]
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*Rollback Reason*\n${reason}`
            }
          },
          {
            type: 'divider'
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*Actions Completed*\n• Deleted release branch: \`${releaseBranch}\`\n• Deleted pre-release tag\n• Restored previous pre-release tag\n• Reverted to branch: \`${prevBranch}\`\n• Deleted Jira filter\n• Added rollback comment to release ticket\n• Closed back-merge PR (if it was open)\n• Deleted bot comments from notified PRs`
            }
          },
          ...(acmFailed ? [{
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*Adobe Cloud Manager* (Optional)\n• Status: Failed\n• Action: Manually revert pipeline to \`${prevBranch}\` in Cloud Manager`
            }
          }, {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: ':information_source: *Note:* Adobe Cloud Manager is an optional step. The rollback completed successfully. Please update the pipeline manually in Cloud Manager.'
            }
          }] : [{
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*Adobe Cloud Manager*\n• Pipeline reverted to \`${prevBranch}\``
            }
          }]),
          {
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text: `Initiated by @${actor} • <${runUrl}|View workflow>`
              }
            ]
          }
        ]
      }
    : {
        channel: CHANNEL_ID,
        text: `:x: Rollback Failed: ${release}`,
        blocks: [
          {
            type: 'header',
            text: {
              type: 'plain_text',
              text: `:x: Rollback Failed: ${release}`,
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
                text: `*Workflow Run*\n#${runNumber}`
              },
              {
                type: 'mrkdwn',
                text: `*Initiated By*\n@${actor}`
              }
            ]
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*Rollback Reason*\n${reason}`
            }
          },
          {
            type: 'divider'
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*Job Results*\n• Delete branch/tags: ${deleteBranch}\n• Revert ACM pipeline: ${acmStatus}\n• Cleanup Jira: ${jira}\n• Cleanup PRs: ${prs}`
            }
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: '*Required Follow-up*\n• Review workflow logs for failure details\n• Complete rollback steps manually if needed\n• Verify system state before retrying'
            }
          },
          {
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text: `Initiated by @${actor} • <${runUrl}|View workflow logs>`
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
    case 'summary':
      payload = buildSummaryReply();
      messageType = 'summary (thread reply)';
      break;
    case 'rollback_start':
      payload = buildRollbackStartMessage();
      messageType = 'rollback start (main thread)';
      break;
    case 'rollback_summary':
      payload = buildRollbackSummaryReply();
      messageType = 'rollback summary (thread reply)';
      break;
    default:
      console.error(`Unknown NOTIFICATION_TYPE: "${TYPE}". Must be start | backmerge | summary | rollback_start | rollback_summary`);
      process.exit(1);
  }

  console.log(`[Slack] Sending "${messageType}" notification`);
  const response = await postToSlack(payload);
  console.log(`[Slack] Notification sent successfully`);

  // For start messages, save the thread timestamp for later replies
  if ((TYPE === 'start' || TYPE === 'rollback_start') && response.ts) {
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