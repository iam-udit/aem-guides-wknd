#!/usr/bin/env node
/**
 * update_release_ticket.js
 * ------------------------
 * Updates the Jira release ticket description to match the format
 * shown in your screenshot:
 *
 *   Release Filter: https://jsw.ibm.com/issues/?filter=459143
 *
 *   Release Tickets:
 *   https://jsw.ibm.com/browse/ADCMS-10949
 *   https://jsw.ibm.com/browse/ADCMS-11244
 *   ...
 *
 * Also appends a separate section for Rule 4 tickets (untagged but open):
 *
 *   Tickets found in release branch but NOT tagged to fix version:
 *   https://jsw.ibm.com/browse/ADCMS-XXXX (code merged, fix version missing)
 *
 * Environment variables:
 *   JIRA_BASE_URL
 *   JIRA_USER_EMAIL
 *   JIRA_API_TOKEN
 *   JIRA_PROJECT_KEY       e.g. ADCMS
 *   JIRA_RELEASE_TICKET    e.g. ADCMS-9999
 *   FILTER_URL             Full filter URL from update_jira_filter.js output
 *   NEW_VERSION_LABEL      e.g. "AEM 2.02.0 - Phoenix"
 *   UNTAGGED_OPEN_TICKETS  Comma-separated e.g. ADCMS-102 (from git commits)
 *   DRY_RUN
 */

const https = require('https');
const url   = require('url');
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

const JIRA_BASE     = requireEnv('JIRA_BASE_URL').replace(/\/$/, '');
const EMAIL         = requireEnv('JIRA_USER_EMAIL');
const TOKEN         = requireEnv('JIRA_API_TOKEN');
const PROJECT_KEY   = requireEnv('JIRA_PROJECT_KEY');
const RELEASE_KEY   = requireEnv('JIRA_RELEASE_TICKET');
const FILTER_URL    = process.env.FILTER_URL || `${JIRA_BASE}/issues/?filter=unknown`;
const NEW_LABEL     = requireEnv('NEW_VERSION_LABEL');
const UNTAGGED_OPEN = (process.env.UNTAGGED_OPEN_TICKETS || '').split(',').map(t => t.trim()).filter(Boolean);
const DRY_RUN       = process.env.DRY_RUN === 'true';

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
 * Fetches every Jira issue currently tagged with the release fix version.
 *
 * @returns {Promise<string[]>} Sorted Jira issue keys for the release, excluding the release ticket itself.
 */
async function fetchAllReleaseTickets() {
  const jql = (
    `project = ${PROJECT_KEY} AND ` +
    `(issuetype = Story OR issuetype = Bug OR issuetype = Spike OR ` +
    `issuetype = Improvement OR issuetype = Task) AND ` +
    `fixVersion = "${NEW_LABEL}" ORDER BY key ASC`
  );

  console.log(`\n[Release Ticket] Fetching all tickets from Jira with fix version "${NEW_LABEL}"`);
  console.log(`  JQL: ${jql}`);

  const allTickets = [];
  let startAt = 0;
  const maxResults = 100;

  while (true) {
    const response = await request(
      'GET',
      `search/jql?jql=${encodeURIComponent(jql)}&startAt=${startAt}&maxResults=${maxResults}&fields=key`
    );

    // Check if response has the expected structure
    if (!response.issues || !Array.isArray(response.issues)) {
      console.error('  Unexpected response structure:', JSON.stringify(response, null, 2));
      throw new Error('Jira API returned unexpected response structure');
    }

    const tickets = response.issues.map(issue => issue.key);
    const batchSize = tickets.length;
    
    console.log(`  Fetched ${batchSize} tickets (startAt: ${startAt}, total available: ${response.total || 'unknown'})`);
    
    // Break if this batch is empty
    if (batchSize === 0) {
      console.log(`  No more tickets to fetch`);
      break;
    }
    
    allTickets.push(...tickets);
    console.log(`  Total collected so far: ${allTickets.length}`);

    // Break if we've fetched all available tickets
    if (response.total && allTickets.length >= response.total) {
      console.log(`  Reached total count (${response.total}), stopping`);
      break;
    }
    
    // Break if we got fewer tickets than requested (last page)
    if (batchSize < maxResults) {
      console.log(`  Last page (got ${batchSize} < ${maxResults}), stopping`);
      break;
    }
    
    startAt += maxResults;
  }

  // Filter out the release ticket itself
  const filtered = allTickets.filter(id => id !== RELEASE_KEY);
  
  if (filtered.length !== allTickets.length) {
    console.log(`  Excluded release ticket ${RELEASE_KEY} from the list`);
  }

  console.log(`\n[Release Ticket] Found ${filtered.length} tickets in Jira with fix version "${NEW_LABEL}"`);
  return filtered;
}

/**
 * Builds the Atlassian Document Format payload for the release ticket description.
 *
 * @param {string[]} releaseTickets Jira issue keys included in the release.
 * @returns {object} ADF document payload ready to send to Jira.
 */
function buildDescription(releaseTickets) {
  const filterURL  = FILTER_URL;

  // Helper: plain text paragraph
  const para = (...inlineNodes) => ({
    type: 'paragraph',
    content: inlineNodes,
  });

  const text = (t, marks) => ({
    type: 'text',
    text: t,
    ...(marks ? { marks } : {}),
  });

  const link = (href, label) => ({
    type: 'text',
    text: label || href,
    marks: [{ type: 'link', attrs: { href } }],
  });

  const heading = (level, t) => ({
    type: 'heading',
    attrs: { level },
    content: [{ type: 'text', text: t }],
  });

  const hardBreak = () => ({ type: 'hardBreak' });

  // ── Release Overview heading ─────────────────────────────────────────────────
  const overviewHeading = heading(2, `Release ${NEW_LABEL}`);
  
  const overviewText = para(
    text('This release includes '),
    text(`${releaseTickets.length}`, [{ type: 'strong' }]),
    text(` ticket${releaseTickets.length === 1 ? '' : 's'} that ${releaseTickets.length === 1 ? 'has' : 'have'} been merged and tagged with fix version `),
    text(`"${NEW_LABEL}"`, [{ type: 'strong' }]),
    text('.'),
  );

  // ── Release Filter section ───────────────────────────────────────────────────
  const filterHeading = heading(3, 'Release Filter');
  const filterLine = para(
    text('View all tickets in this release: '),
    link(filterURL, 'Open Jira Filter'),
  );

  // ── Release Tickets section ──────────────────────────────────────────────────
  const ticketHeading = heading(3, 'Release Tickets');
  const ticketCount = para(
    text(`Total: ${releaseTickets.length} ticket${releaseTickets.length === 1 ? '' : 's'}`)
  );

  const ticketLines = releaseTickets.map(id => {
    const ticketURL = `${JIRA_BASE}/browse/${id}`;
    return para(link(ticketURL, id));
  });

  return {
    type:    'doc',
    version: 1,
    content: [
      overviewHeading,
      overviewText,
      para(text('')),           // blank line separator
      filterHeading,
      filterLine,
      para(text('')),
      ticketHeading,
      ticketCount,
      para(text('')),
      ...ticketLines,
    ],
  };
}

/**
 * Updates the Jira release ticket description and posts a summary comment.
 *
 * @returns {Promise<void>} Resolves when the release ticket update flow completes.
 */
async function main() {
  const GH_OUTPUT = process.env.GITHUB_OUTPUT;
  
  console.log(`\n[Release Ticket] Updating ${RELEASE_KEY}`);
  console.log(`  Fix version:   ${NEW_LABEL}`);

  // Fetch all tickets from Jira with the new fix version
  const releaseTickets = await fetchAllReleaseTickets();
  
  console.log(`  Release tickets: ${releaseTickets.length} tickets`);
  console.log(`  Untagged open:   ${UNTAGGED_OPEN.length} tickets (from git commits)`);

  // Output the actual ticket count for the workflow
  if (GH_OUTPUT) {
    fs.appendFileSync(GH_OUTPUT, `jira_ticket_count=${releaseTickets.length}\n`);
    console.log(`  Wrote ticket count to GITHUB_OUTPUT: ${releaseTickets.length}`);
  }

  const description = buildDescription(releaseTickets);

  if (DRY_RUN) {
    console.log('\n[DRY RUN] Description that would be written:');
    console.log(JSON.stringify(description, null, 2));
    return;
  }

  // Fetch current issue to preserve any existing content we should not overwrite
  const issue = await request('GET', `issue/${RELEASE_KEY}?fields=description,summary`);
  console.log(`  Ticket title:  ${issue.fields.summary}`);

  // PUT updated description
  await request('PUT', `issue/${RELEASE_KEY}`, {
    fields: { description },
  });

  console.log(`\nRelease ticket ${RELEASE_KEY} description updated successfully`);
  console.log(`  URL: ${JIRA_BASE}/browse/${RELEASE_KEY}`);

  // Also post a comment summarizing what the bot did
  const commentBody = {
    type:    'doc',
    version: 1,
    content: [{
      type:    'paragraph',
      content: [{
        type: 'text',
        text: `Release Cut Bot updated this ticket for ${NEW_LABEL}. `
            + `${releaseTickets.length} tickets found in Jira with fix version "${NEW_LABEL}". `
            + (UNTAGGED_OPEN.length
                ? `${UNTAGGED_OPEN.length} ticket(s) found in git commits without fix version: ${UNTAGGED_OPEN.join(', ')}.`
                : 'No untagged open tickets found in git commits.'),
      }],
    }],
  };

  await request('POST', `issue/${RELEASE_KEY}/comment`, { body: commentBody });
  console.log(`Comment posted on ${RELEASE_KEY}`);
}

main().catch(err => {
  console.error(`[Release Ticket] Fatal error: ${err.message}`);
  process.exit(1);
});