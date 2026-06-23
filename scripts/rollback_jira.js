#!/usr/bin/env node
/**
 * rollback_jira.js
 * ----------------
 * Handles Jira cleanup during release rollback:
 *   - Finds and deletes the Jira filter for the rolled-back release
 *   - Adds a rollback comment to the release ticket
 *
 * Environment variables:
 *   JIRA_BASE_URL
 *   JIRA_USER_EMAIL
 *   JIRA_API_TOKEN
 *   JIRA_PROJECT_KEY
 *   JIRA_RELEASE_TICKET      e.g. ADCMS-9999
 *   NEW_VERSION_LABEL        e.g. "AEM 2.03.0 - Minotaur"
 *   ROLLBACK_REASON
 *   GITHUB_ACTOR
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

const JIRA_BASE     = requireEnv('JIRA_BASE_URL').replace(/\/$/, '');
const EMAIL         = requireEnv('JIRA_USER_EMAIL');
const TOKEN         = requireEnv('JIRA_API_TOKEN');
const PROJECT_KEY   = requireEnv('JIRA_PROJECT_KEY');
const RELEASE_KEY   = requireEnv('JIRA_RELEASE_TICKET');
const VERSION_LABEL = requireEnv('NEW_VERSION_LABEL');
const REASON        = requireEnv('ROLLBACK_REASON');
const ACTOR         = process.env.GITHUB_ACTOR || 'unknown';

const AUTH = Buffer.from(`${EMAIL}:${TOKEN}`).toString('base64');

/**
 * Executes a Jira REST API request and parses the JSON response body.
 *
 * @param {string} method HTTP method to use.
 * @param {string} path Jira API path relative to /rest/api/3/.
 * @param {object} [body] Optional JSON payload for write operations.
 * @returns {Promise<object|Array>} Parsed Jira API response payload.
 */
function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const parsed  = url.parse(`${JIRA_BASE}/rest/api/3/${path}`);
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: parsed.hostname,
      path:     parsed.path,
      method,
      headers: {
        'Authorization': `Basic ${AUTH}`,
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
          reject(new Error(`Jira ${res.statusCode} on ${method} ${path}: ${data}`));
          return;
        }

        try {
          resolve(data ? JSON.parse(data) : {});
        } catch (err) {
          reject(new Error(`Failed to parse Jira response for ${method} ${path}: ${err.message}`));
        }
      });
    });

    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * Finds the Jira filter for the rolled-back release version.
 *
 * @returns {Promise<string|null>} Filter ID if found, null otherwise.
 */
async function findReleaseFilter() {
  console.log(`\n[Jira Rollback] Searching for filter: "${VERSION_LABEL}"`);
  console.log(`  DEBUG: NEW_VERSION_LABEL env var = "${process.env.NEW_VERSION_LABEL}"`);
  console.log(`  DEBUG: VERSION_LABEL constant = "${VERSION_LABEL}"`);
  
  try {
    // Jira's filterName parameter does fuzzy matching, so we need to:
    // 1. Get ALL filters (or use a broader search)
    // 2. Filter client-side for exact match
    
    console.log(`  Fetching all filters to find exact match...`);
    
    let allFilters = [];
    let startAt = 0;
    const maxResults = 50;
    
    // Paginate through all filters
    while (true) {
      const searchUrl = `filter/search?maxResults=${maxResults}&startAt=${startAt}`;
      console.log(`  DEBUG: Fetching page: ${searchUrl}`);
      
      const response = await request('GET', searchUrl);
      
      if (response.values && response.values.length > 0) {
        allFilters.push(...response.values);
        console.log(`  Fetched ${response.values.length} filters (total so far: ${allFilters.length})`);
        
        // Check if we've reached the end
        if (response.isLast || response.values.length < maxResults) {
          break;
        }
        
        startAt += maxResults;
      } else {
        break;
      }
    }
    
    console.log(`  Total filters fetched: ${allFilters.length}`);
    console.log(`  Searching for exact match: "${VERSION_LABEL}"`);
    
    // Find exact match
    const exactMatch = allFilters.find(f => f.name === VERSION_LABEL);
    
    if (exactMatch) {
      console.log(`  ✓ Found exact match: "${exactMatch.name}" (ID: ${exactMatch.id})`);
      return exactMatch.id;
    } else {
      console.log(`  ✗ No exact match found for "${VERSION_LABEL}"`);
      
      // Show similar filters for debugging
      const similar = allFilters.filter(f =>
        f.name.toLowerCase().includes('aem') ||
        f.name.toLowerCase().includes(VERSION_LABEL.toLowerCase().split(' ')[0])
      ).slice(0, 5);
      
      if (similar.length > 0) {
        console.log(`  Similar filters found:`);
        similar.forEach((f, idx) => {
          console.log(`    ${idx + 1}. "${f.name}" (ID: ${f.id})`);
        });
      }
      
      return null;
    }
  } catch (err) {
    console.warn(`  Could not search for filter: ${err.message}`);
    return null;
  }
}

/**
 * Deletes a Jira filter by ID.
 *
 * @param {string} filterId Filter ID to delete.
 * @returns {Promise<void>} Resolves when filter is deleted.
 */
async function deleteFilter(filterId) {
  console.log(`\n[Jira Rollback] Deleting filter ID: ${filterId}`);
  
  try {
    await request('DELETE', `filter/${filterId}`);
    console.log(`  ✅ Filter deleted successfully`);
  } catch (err) {
    console.warn(`  ⚠️  Could not delete filter: ${err.message}`);
  }
}

/**
 * Clears the release ticket description.
 *
 * @returns {Promise<void>} Resolves when description is cleared.
 */
async function clearReleaseTicketDescription() {
  console.log(`\n[Jira Rollback] Clearing description for ${RELEASE_KEY}`);
  
  const emptyDescription = {
    type:    'doc',
    version: 1,
    content: [{
      type:    'paragraph',
      content: [{
        type: 'text',
        text: `This release has been rolled back. See comments for details.`,
      }],
    }],
  };

  try {
    await request('PUT', `issue/${RELEASE_KEY}`, {
      fields: { description: emptyDescription }
    });
    console.log(`  ✅ Release ticket description cleared`);
  } catch (err) {
    console.error(`  ❌ Failed to clear description: ${err.message}`);
    throw err;
  }
}

/**
 * Adds a rollback comment to the release ticket.
 *
 * @returns {Promise<void>} Resolves when comment is posted.
 */
async function addRollbackComment() {
  console.log(`\n[Jira Rollback] Adding rollback comment to ${RELEASE_KEY}`);
  
  const commentBody = {
    type:    'doc',
    version: 1,
    content: [{
      type:    'paragraph',
      content: [{
        type: 'text',
        text: `⚠️ Release Rollback Executed\n\n` +
              `Release ${VERSION_LABEL} has been rolled back by @${ACTOR}.\n\n` +
              `Reason: ${REASON}\n\n` +
              `Actions performed:\n` +
              `• Deleted release branch\n` +
              `• Deleted pre-release tag and latest tag\n` +
              `• Restored previous pre-release tag\n` +
              `• Reverted Adobe Cloud Manager pipeline\n` +
              `• Deleted Jira filter\n` +
              `• Cleared release ticket description\n` +
              `• Closed back-merge PR (if open)\n` +
              `• Removed bot comments from notified PRs\n\n` +
              `This release ticket is no longer valid for the current release cycle.`,
      }],
    }],
  };

  try {
    await request('POST', `issue/${RELEASE_KEY}/comment`, { body: commentBody });
    console.log(`  ✅ Rollback comment added to ${RELEASE_KEY}`);
  } catch (err) {
    console.error(`  ❌ Failed to add comment: ${err.message}`);
    throw err;
  }
}

/**
 * Main rollback function for Jira cleanup.
 *
 * @returns {Promise<void>} Resolves when Jira rollback completes.
 */
async function main() {
  console.log(`\n[Jira Rollback] Starting Jira cleanup for ${VERSION_LABEL}`);
  
  // Find and delete the filter
  const filterId = await findReleaseFilter();
  if (filterId) {
    await deleteFilter(filterId);
  } else {
    console.log(`  ⚠️  No filter to delete (may have been deleted manually)`);
  }
  
  // Clear release ticket description
  await clearReleaseTicketDescription();
  
  // Add rollback comment to release ticket
  await addRollbackComment();
  
  console.log(`\n[Jira Rollback] Jira cleanup complete\n`);
}

main().catch(err => {
  console.error(`[Jira Rollback] Fatal error: ${err.message}`);
  process.exit(1);
});

// Made with Bob
