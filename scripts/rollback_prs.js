#!/usr/bin/env node
/**
 * rollback_prs.js
 * ---------------
 * Handles PR cleanup during release rollback:
 *   - Closes the back-merge PR (if still open)
 *   - Deletes bot comments from all PRs that were notified about the release
 *
 * Environment variables:
 *   GH_TOKEN
 *   GITHUB_SERVER_URL
 *   GITHUB_REPOSITORY
 *   RELEASE_BRANCH_TO_DELETE    e.g. release-2.03.0-minotaur
 *   NEW_VERSION_LABEL           e.g. "AEM 2.03.0 - Minotaur"
 *   ROLLBACK_REASON
 */

const https = require('https');
const url   = require('url');

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

const TOKEN            = requireEnv('GH_TOKEN');
const SERVER_URL       = (process.env.GITHUB_SERVER_URL || 'https://github.com').replace(/\/$/, '');
const REPO             = requireEnv('GITHUB_REPOSITORY');
const RELEASE_BRANCH   = requireEnv('RELEASE_BRANCH_TO_DELETE');
const VERSION_LABEL    = requireEnv('NEW_VERSION_LABEL');
const ROLLBACK_REASON  = requireEnv('ROLLBACK_REASON');

// Determine API base URL
const GHE_HOST = SERVER_URL.replace(/^https?:\/\//, '');
const API_BASE = GHE_HOST === 'github.com'
  ? 'https://api.github.com'
  : `https://${GHE_HOST}/api/v3`;

const GH_HEADERS = {
  'Authorization':        `Bearer ${TOKEN}`,
  'Accept':               'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'Content-Type':         'application/json',
  'User-Agent':           'ADCMS Release Bot (rollback)',
};

/**
 * Executes a GitHub REST API request and parses the JSON response body.
 *
 * @param {string} method HTTP method to use.
 * @param {string} path GitHub API path relative to the resolved API base URL.
 * @param {object} [body] Optional JSON payload for write operations.
 * @returns {Promise<object|Array>} Parsed GitHub API response payload.
 */
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
          return;
        }

        try {
          resolve(data ? JSON.parse(data) : {});
        } catch (err) {
          reject(new Error(`Failed to parse GitHub response for ${method} ${path}: ${err.message}`));
        }
      });
    });

    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * Finds and closes the back-merge PR if it exists and is still open.
 *
 * @returns {Promise<void>} Resolves when back-merge PR is closed or not found.
 */
async function closeBackMergePR() {
  console.log(`\n[PR Rollback] Looking for back-merge PR for ${RELEASE_BRANCH}`);
  
  // Expected back-merge branch name pattern
  const backMergeBranch = `chore/back-merge-${RELEASE_BRANCH.replace('release-', '')}`;
  
  try {
    // Find open PRs with this head branch
    const prs = await ghRequest('GET', `/repos/${REPO}/pulls?state=open&per_page=100`);
    
    const backMergePR = prs.find(pr => 
      pr.head.ref === backMergeBranch || 
      pr.head.ref.includes(`back-merge-${RELEASE_BRANCH}`)
    );
    
    if (!backMergePR) {
      console.log(`  ⚠️  No open back-merge PR found (may have been merged or closed already)`);
      return;
    }
    
    console.log(`  Found back-merge PR #${backMergePR.number}: "${backMergePR.title}"`);
    
    // Close the PR with a comment
    const closeComment = `⚠️ **Release Rollback**\n\n` +
      `This back-merge PR is being closed because release ${VERSION_LABEL} has been rolled back.\n\n` +
      `**Reason:** ${ROLLBACK_REASON}\n\n` +
      `The release branch \`${RELEASE_BRANCH}\` has been deleted. ` +
      `This back-merge is no longer needed.`;
    
    await ghRequest('POST', `/repos/${REPO}/issues/${backMergePR.number}/comments`, {
      body: closeComment
    });
    
    await ghRequest('PATCH', `/repos/${REPO}/pulls/${backMergePR.number}`, {
      state: 'closed'
    });
    
    console.log(`  ✅ Closed back-merge PR #${backMergePR.number}`);
    
  } catch (err) {
    console.error(`  ❌ Error handling back-merge PR: ${err.message}`);
    // Don't fail the rollback if we can't close the PR
  }
}

/**
 * Finds all bot comments related to the rolled-back release and deletes them.
 *
 * @returns {Promise<void>} Resolves when all bot comments are deleted.
 */
async function deleteBotComments() {
  console.log(`\n[PR Rollback] Searching for bot comments about ${VERSION_LABEL}`);
  console.log(`  DEBUG: NEW_VERSION_LABEL env var = "${process.env.NEW_VERSION_LABEL}"`);
  console.log(`  DEBUG: VERSION_LABEL constant = "${VERSION_LABEL}"`);
  console.log(`  DEBUG: RELEASE_BRANCH constant = "${RELEASE_BRANCH}"`);
  
  try {
    // Get all open PRs targeting develop
    const prs = await ghRequest('GET', `/repos/${REPO}/pulls?base=develop&state=open&per_page=100`);
    
    console.log(`  Found ${prs.length} open PRs targeting develop`);
    
    let deletedCount = 0;
    
    for (const pr of prs) {
      const { number, title } = pr;
      
      console.log(`\n  Checking PR #${number}: "${title}"`);
      
      try {
        // Get all comments on this PR
        const comments = await ghRequest('GET', `/repos/${REPO}/issues/${number}/comments`);
        
        console.log(`    Total comments: ${comments.length}`);
        
        // Check each comment in detail
        comments.forEach((comment, idx) => {
          console.log(`    Comment ${idx + 1} (ID: ${comment.id}):`);
          console.log(`      Author: ${comment.user?.login} (Type: ${comment.user?.type})`);
          console.log(`      Preview: ${(comment.body || '').substring(0, 100)}...`);
        });
        
        // Find bot comments that mention this release
        const botComments = comments.filter(comment => {
          const body = comment.body || '';
          const isBot = comment.user?.login === 'github-actions[bot]' ||
                        comment.user?.type === 'Bot';
          
          // Check for version label (with or without markdown bold)
          const mentionsVersionLabel = body.includes(VERSION_LABEL);
          // Also check for version label wrapped in markdown bold
          const mentionsVersionLabelBold = body.includes(`**${VERSION_LABEL}**`);
          // Check for release branch
          const mentionsReleaseBranch = body.includes(RELEASE_BRANCH);
          
          const mentionsRelease = mentionsVersionLabel || mentionsVersionLabelBold || mentionsReleaseBranch;
          
          if (isBot) {
            console.log(`      Comment ${comment.id} is from bot: ${comment.user?.login}`);
            console.log(`        Comment preview: ${body.substring(0, 150)}...`);
            console.log(`        Mentions VERSION_LABEL ("${VERSION_LABEL}"): ${mentionsVersionLabel}`);
            console.log(`        Mentions VERSION_LABEL bold ("**${VERSION_LABEL}**"): ${mentionsVersionLabelBold}`);
            console.log(`        Mentions RELEASE_BRANCH ("${RELEASE_BRANCH}"): ${mentionsReleaseBranch}`);
            console.log(`        Will delete: ${mentionsRelease}`);
          }
          
          return isBot && mentionsRelease;
        });
        
        if (botComments.length === 0) {
          continue;
        }
        
        console.log(`  PR #${number}: Found ${botComments.length} bot comment(s) to delete`);
        
        // Delete each bot comment
        for (const comment of botComments) {
          try {
            await ghRequest('DELETE', `/repos/${REPO}/issues/comments/${comment.id}`);
            deletedCount++;
            console.log(`    ✓ Deleted comment ${comment.id}`);
          } catch (err) {
            console.warn(`    ✗ Could not delete comment ${comment.id}: ${err.message}`);
          }
        }
        
      } catch (err) {
        console.warn(`  ⚠️  Could not process PR #${number}: ${err.message}`);
      }
    }
    
    console.log(`\n  ✅ Deleted ${deletedCount} bot comment(s) total`);
    
  } catch (err) {
    console.error(`  ❌ Error deleting bot comments: ${err.message}`);
    // Don't fail the rollback if we can't delete comments
  }
}

/**
 * Main rollback function for PR cleanup.
 *
 * @returns {Promise<void>} Resolves when PR rollback completes.
 */
async function main() {
  console.log(`\n[PR Rollback] Starting PR cleanup for ${VERSION_LABEL}`);
  console.log(`  Repository: ${REPO}`);
  console.log(`  API Base: ${API_BASE}`);
  
  // Close back-merge PR if it exists
  await closeBackMergePR();
  
  // Delete bot comments from notified PRs
  await deleteBotComments();
  
  console.log(`\n[PR Rollback] PR cleanup complete\n`);
}

main().catch(err => {
  console.error(`[PR Rollback] Fatal error: ${err.message}`);
  process.exit(1);
});

// Made with Bob
