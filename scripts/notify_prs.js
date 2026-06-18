#!/usr/bin/env node
/**
 * notify_prs.js
 * -------------
 * Finds all open PRs targeting `develop`, extracts Jira ticket IDs from their
 * title and description, checks if those tickets are tagged with the new release
 * version, and posts a targeted comment only on PRs with matching tickets.
 *
 * Environment variables:
 *   GH_TOKEN
 *   GITHUB_SERVER_URL    e.g. https://github.ibm.com
 *   GITHUB_REPOSITORY    e.g. IBM/adcms
 *   GITHUB_RUN_NUMBER
 *   GITHUB_RUN_ID
 *   NEW_RELEASE_BRANCH   e.g. release-2.03.0-minotaur
 *   NEW_VERSION          e.g. 2.03.0
 *   NEW_VERSION_LABEL    e.g. "AEM 2.03.0 - Minotaur"
 *   JIRA_BASE_URL        e.g. https://jsw.ibm.com
 *   JIRA_USER_EMAIL
 *   JIRA_API_TOKEN
 *   JIRA_PROJECT_KEY     e.g. ADCMS
 */

const https  = require('https');
const url    = require('url');

const TOKEN         = process.env.GH_TOKEN;
const SERVER_URL    = (process.env.GITHUB_SERVER_URL || 'https://github.com').replace(/\/$/, '');
const REPO          = process.env.GITHUB_REPOSITORY;
const RUN_NUMBER    = process.env.GITHUB_RUN_NUMBER || '?';
const RUN_ID        = process.env.GITHUB_RUN_ID     || '';
const NEW_BRANCH    = process.env.NEW_RELEASE_BRANCH;
const NEW_VER       = process.env.NEW_VERSION;
const NEW_LABEL     = process.env.NEW_VERSION_LABEL;
const JIRA_BASE     = process.env.JIRA_BASE_URL.replace(/\/$/, '');
const JIRA_EMAIL    = process.env.JIRA_USER_EMAIL;
const JIRA_TOKEN    = process.env.JIRA_API_TOKEN;
const PROJECT_KEY   = process.env.JIRA_PROJECT_KEY;

// Fail fast if GH_TOKEN is missing
if (!TOKEN) {
  console.error('GH_TOKEN is not set. Set the GH_TOKEN secret for this workflow.');
  process.exit(1);
}

// Determine API base URL based on server
const GHE_HOST = SERVER_URL.replace(/^https?:\/\//, '');
const API_BASE = GHE_HOST === 'github.com'
  ? 'https://api.github.com'
  : `https://${GHE_HOST}/api/v3`;

const GH_HEADERS = {
  'Authorization':        `Bearer ${TOKEN}`,
  'Accept':               'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'Content-Type':         'application/json',
  'User-Agent':           `ADCMS Release Bot (release-cut run ${RUN_NUMBER || RUN_ID || 'local'})`,
};

const JIRA_AUTH = Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString('base64');

// ── HTTP helpers ──────────────────────────────────────────────────────────────
function ghRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const parsed  = url.parse(`${API_BASE}${path}`);
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: parsed.hostname,
      path:     parsed.path,
      method,
      headers: {
        ...GH_HEADERS,
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    };

    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`GitHub API ${res.statusCode} for ${method} ${path}: ${data}`));
        } else {
          resolve(data ? JSON.parse(data) : {});
        }
      });
    });

    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function jiraRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const parsed  = url.parse(`${JIRA_BASE}/rest/api/3/${path}`);
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: parsed.hostname,
      path:     parsed.path,
      method,
      headers: {
        'Authorization': `Basic ${JIRA_AUTH}`,
        'Accept':        'application/json',
        'Content-Type':  'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    };

    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`Jira API ${res.statusCode} for ${method} ${path}: ${data}`));
        } else {
          resolve(data ? JSON.parse(data) : {});
        }
      });
    });

    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function getAllOpenPRs() {
  const prs  = [];
  let   page = 1;
  while (true) {
    const batch = await ghRequest(
      'GET',
      `/repos/${REPO}/pulls?base=develop&state=open&per_page=100&page=${page}`
    );
    if (!batch.length) break;
    prs.push(...batch);
    page++;
  }
  return prs;
}

// ── Extract ticket IDs from PR title and body ─────────────────────────────────
function extractTicketIds(title, body) {
  const text = `${title}\n${body || ''}`;
  const matches = text.match(new RegExp(`${PROJECT_KEY}-[0-9]{1,}`, 'g'));
  if (!matches) return [];
  // Return unique ticket IDs
  return [...new Set(matches)];
}

// ── Check if ticket has the new release fix version ──────────────────────────
async function checkTicketFixVersion(ticketId) {
  try {
    const issue = await jiraRequest('GET', `issue/${ticketId}?fields=fixVersions`);
    const fixVersions = (issue.fields.fixVersions || []).map(v => v.name);
    return fixVersions.includes(NEW_LABEL);
  } catch (err) {
    console.warn(`  Warning: Could not fetch ${ticketId}: ${err.message}`);
    return false;
  }
}

// ── Build targeted comment for PR with matching tickets ──────────────────────
function buildTargetedComment(author, matchingTickets) {
  const ticketLinks = matchingTickets.map(id =>
    `[${id}](${JIRA_BASE}/browse/${id})`
  ).join(', ');

  const ticketList = matchingTickets.length === 1 ? 'ticket' : 'tickets';
  const isAre = matchingTickets.length === 1 ? 'is' : 'are';
  
  return `@${author} — ${ticketLinks} ${isAre} currently tagged with ${NEW_LABEL}, and its release branch has been cut. Please either rebase its feature branch & change its target branch of this PR to [${NEW_BRANCH}](${SERVER_URL}/${REPO}/tree/${NEW_BRANCH}) or remove the release tag from the ${ticketList} if it's not supposed to be part of it.`;
}

// ── Build generic comment for PR without matching tickets ────────────────────
function buildGenericComment(author) {
  return `@${author} — Release **${NEW_LABEL}** has been cut, and the new release branch [${NEW_BRANCH}](${SERVER_URL}/${REPO}/tree/${NEW_BRANCH}) is now available.

If this PR contains changes intended for **${NEW_LABEL}**, please rebase your feature branch and retarget this PR to [${NEW_BRANCH}](${SERVER_URL}/${REPO}/tree/${NEW_BRANCH}).

If this PR is **not** intended for this release, no action is needed — it will be included in a future release.`;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n[PR Notify] Fetching open pull requests targeting develop in ${REPO}`);
  console.log(`[PR Notify] API Base: ${API_BASE}`);
  console.log(`[PR Notify] Checking for tickets tagged with: ${NEW_LABEL}\n`);

  let prs;
  try {
    prs = await getAllOpenPRs();
  } catch (err) {
    if (err.message.includes('404')) {
      console.warn(`\n[PR Notify] Warning: Could not access repository ${REPO}`);
      console.warn(`[PR Notify] Skipping PR notifications\n`);
      return;
    }
    throw err;
  }

  console.log(`[PR Notify] Found ${prs.length} open pull requests\n`);

  if (!prs.length) {
    console.log('[PR Notify] No open pull requests found');
    return;
  }

  let targetedComments = 0;
  let genericComments = 0;

  for (const pr of prs) {
    const { number, title, body, user } = pr;
    const author = user?.login || 'unknown';
    
    console.log(`\n  PR #${number} - "${title}" (@${author})`);
    
    // Extract ticket IDs from PR
    const ticketIds = extractTicketIds(title, body);
    
    if (ticketIds.length === 0) {
      console.log(`    No ${PROJECT_KEY} tickets found - posting generic notification`);
      
      // Post generic comment
      try {
        await ghRequest('POST', `/repos/${REPO}/issues/${number}/comments`, {
          body: buildGenericComment(author),
        });
        console.log(`    ✓ Generic comment posted`);
        genericComments++;
      } catch (err) {
        console.error(`    ✗ Failed to post comment: ${err.message}`);
      }
      continue;
    }
    
    console.log(`    Found tickets: ${ticketIds.join(', ')}`);
    
    // Check which tickets have the new release fix version
    const matchingTickets = [];
    for (const ticketId of ticketIds) {
      const hasFixVersion = await checkTicketFixVersion(ticketId);
      if (hasFixVersion) {
        matchingTickets.push(ticketId);
        console.log(`      ${ticketId} - ✓ Tagged with ${NEW_LABEL}`);
      } else {
        console.log(`      ${ticketId} - ✗ Not tagged with ${NEW_LABEL}`);
      }
    }
    
    if (matchingTickets.length === 0) {
      console.log(`    No tickets match release version - posting generic notification`);
      
      // Post generic comment
      try {
        await ghRequest('POST', `/repos/${REPO}/issues/${number}/comments`, {
          body: buildGenericComment(author),
        });
        console.log(`    ✓ Generic comment posted`);
        genericComments++;
      } catch (err) {
        console.error(`    ✗ Failed to post comment: ${err.message}`);
      }
      continue;
    }
    
    // Post targeted comment
    try {
      await ghRequest('POST', `/repos/${REPO}/issues/${number}/comments`, {
        body: buildTargetedComment(author, matchingTickets),
      });
      console.log(`    ✓ Targeted comment posted (${matchingTickets.length} matching ticket(s))`);
      targetedComments++;
    } catch (err) {
      console.error(`    ✗ Failed to post comment: ${err.message}`);
    }
  }

  console.log(`\n========================================`);
  console.log(`[PR Notify] Completed`);
  console.log(`  Targeted comments: ${targetedComments} PR(s) (tickets match release)`);
  console.log(`  Generic comments:  ${genericComments} PR(s) (no matching tickets)`);
  console.log(`  Total notified:    ${targetedComments + genericComments} PR(s)`);
  console.log(`========================================\n`);
}

main().catch(err => { console.error(err); process.exit(1); });

// Made with Bob
