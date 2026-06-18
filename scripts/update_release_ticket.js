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

const JIRA_BASE     = process.env.JIRA_BASE_URL.replace(/\/$/, '');
const EMAIL         = process.env.JIRA_USER_EMAIL;
const TOKEN         = process.env.JIRA_API_TOKEN;
const PROJECT_KEY   = process.env.JIRA_PROJECT_KEY;
const RELEASE_KEY   = process.env.JIRA_RELEASE_TICKET;
const FILTER_URL    = process.env.FILTER_URL || `${JIRA_BASE}/issues/?filter=unknown`;
const NEW_LABEL     = process.env.NEW_VERSION_LABEL;
const UNTAGGED_OPEN = (process.env.UNTAGGED_OPEN_TICKETS || '').split(',').map(t => t.trim()).filter(Boolean);
const DRY_RUN       = process.env.DRY_RUN === 'true';

const AUTH = Buffer.from(`${EMAIL}:${TOKEN}`).toString('base64');

// ── HTTP helper ───────────────────────────────────────────────────────────────
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

// ── Fetch all tickets from Jira with the new fix version ─────────────────────
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
      `search?jql=${encodeURIComponent(jql)}&startAt=${startAt}&maxResults=${maxResults}&fields=key`
    );

    const tickets = response.issues.map(issue => issue.key);
    allTickets.push(...tickets);

    console.log(`  Fetched ${tickets.length} tickets (total so far: ${allTickets.length})`);

    if (response.total <= startAt + maxResults) {
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

// ── Build ADF (Atlassian Document Format) description ─────────────────────────
// Matches the format in your screenshot exactly:
//   Release Filter: <link>
//   (blank line)
//   Release Tickets:
//   <link per ticket>
//   ...
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

  const hardBreak = () => ({ type: 'hardBreak' });

  // ── Release Filter line ──────────────────────────────────────────────────────
  const filterLine = para(
    text('Release Filter: '),
    link(filterURL, filterURL),
  );

  // ── Release Tickets section ──────────────────────────────────────────────────
  // Each ticket on its own paragraph (matching the screenshot layout)
  const ticketHeaderLine = para(text('Release Tickets:'));

  const ticketLines = releaseTickets.map(id => {
    const ticketURL = `${JIRA_BASE}/browse/${id}`;
    return para(link(ticketURL, ticketURL));
  });

  // ── Untagged open tickets warning (Rule 4) ───────────────────────────────────
  const untaggedSection = [];
  if (UNTAGGED_OPEN.length > 0) {
    untaggedSection.push(para(
      text('Tickets found in release branch but NOT tagged to fix version '),
      text(`"${NEW_LABEL}"`, [{ type: 'strong' }]),
      text(' - code is merged but fix version is missing. Please review:'),
    ));
    UNTAGGED_OPEN.forEach(id => {
      const ticketURL = `${JIRA_BASE}/browse/${id}`;
      untaggedSection.push(para(link(ticketURL, ticketURL)));
    });
  }

  // ── Auto-generated footer note ───────────────────────────────────────────────
  const footerLine = para(
    text('_Auto-updated by Release Cut workflow. Verify the ticket list — cherry-picks or hotfixes without commit references may need manual addition._'),
  );

  return {
    type:    'doc',
    version: 1,
    content: [
      filterLine,
      para(text('')),           // blank line separator
      ticketHeaderLine,
      ...ticketLines,
      ...(untaggedSection.length ? [para(text('')), ...untaggedSection] : []),
      para(text('')),
      footerLine,
    ],
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n[Release Ticket] Updating ${RELEASE_KEY}`);
  console.log(`  Fix version:   ${NEW_LABEL}`);

  // Fetch all tickets from Jira with the new fix version
  const releaseTickets = await fetchAllReleaseTickets();
  
  console.log(`  Release tickets: ${releaseTickets.length} tickets`);
  console.log(`  Untagged open:   ${UNTAGGED_OPEN.length} tickets (from git commits)`);

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

main().catch(err => { console.error(err.message); process.exit(1); });