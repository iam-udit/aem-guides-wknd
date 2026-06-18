#!/usr/bin/env node
/**
 * classify_tickets.js
 * -------------------
 * Mirrors the 4 rules your team applies manually after running the
 * browser console script on the GitHub tag comparison page.
 *
 * Rule 1: IGNORE  - ticket is tagged to ANY previous release fix version
 * Rule 2: IGNORE  - ticket has NO fix version AND is Closed or Cancelled
 * Rule 3: INCLUDE - ticket is tagged to the CURRENT release fix version
 * Rule 4: FLAG    - ticket has NO fix version AND is still open
 *                   (listed separately in Slack/release ticket as "needs attention")
 *
 * Outputs (via GITHUB_OUTPUT):
 *   confirmed_tickets      Comma-separated ADCMS-XXXX IDs (Rule 3)
 *   untagged_open_tickets  Comma-separated ADCMS-XXXX IDs (Rule 4)
 *   ticket_count           Number of confirmed tickets
 *
 * Environment variables:
 *   JIRA_BASE_URL        e.g. https://jsw.ibm.com
 *   JIRA_USER_EMAIL
 *   JIRA_API_TOKEN
 *   RAW_TICKETS          Comma-separated IDs from tag comparison
 *   NEW_VERSION_LABEL    e.g. "AEM 2.02.0 - Phoenix"
 *   PREV_VERSION_LABEL   e.g. "AEM 2.01.0 - Kraken"
 */

const https  = require('https');
const fs     = require('fs');
const url    = require('url');

const JIRA_BASE      = process.env.JIRA_BASE_URL.replace(/\/$/, '');
const EMAIL          = process.env.JIRA_USER_EMAIL;
const TOKEN          = process.env.JIRA_API_TOKEN;
const RELEASE_TICKET = process.env.JIRA_RELEASE_TICKET;  // e.g. ADCMS-9999
const RAW            = (process.env.RAW_TICKETS || '').split(',').map(t => t.trim()).filter(Boolean);
const NEW_LABEL      = process.env.NEW_VERSION_LABEL;   // "AEM 2.02.0 - Phoenix"
const PREV_LABEL     = process.env.PREV_VERSION_LABEL;  // "AEM 2.01.0 - Kraken"
const GH_OUTPUT      = process.env.GITHUB_OUTPUT;

const AUTH = Buffer.from(`${EMAIL}:${TOKEN}`).toString('base64');

// ── HTTP helper ───────────────────────────────────────────────────────────────
function jiraGet(path) {
  return new Promise((resolve, reject) => {
    const parsed = url.parse(`${JIRA_BASE}/rest/api/3/${path}`);
    const options = {
      hostname: parsed.hostname,
      path:     parsed.path,
      method:   'GET',
      headers: {
        'Authorization': `Basic ${AUTH}`,
        'Accept':        'application/json',
      },
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`Jira API ${res.statusCode} for ${path}: ${data}`));
        } else {
          resolve(JSON.parse(data));
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ── Classify a single ticket ──────────────────────────────────────────────────
async function classifyTicket(ticketId) {
  let issue;
  try {
    issue = await jiraGet(`issue/${ticketId}?fields=fixVersions,status,summary`);
  } catch (err) {
    console.warn(`  Could not fetch ${ticketId}: ${err.message} - skipping`);
    return { id: ticketId, rule: 'SKIP' };
  }

  const fixVersions  = (issue.fields.fixVersions || []).map(v => v.name);
  const statusCat    = issue.fields.status?.statusCategory?.key || '';
  const statusName   = issue.fields.status?.name || '';
  const isDone       = statusCat === 'done'; // covers Done, Closed, Cancelled, Resolved
  const isCancelled  = /cancel/i.test(statusName);
  const hasNoFix     = fixVersions.length === 0;

  console.log(`  ${ticketId} | Fix versions: [${fixVersions.join(', ') || 'none'}] | Status: ${statusName}`);

  // Rule 1 - tagged to a PREVIOUS release fix version (ignore)
  // We check: has any fix version that is NOT the current one
  // (meaning it was already accounted for in a prior release)
  const hasPrevFixVersion = fixVersions.some(v =>
    v !== NEW_LABEL && /^AEM\s/.test(v)
  );
  if (hasPrevFixVersion) {
    console.log(`    Rule 1: IGNORE (tagged to previous fix version)`);
    return { id: ticketId, rule: 'IGNORE_PREV_FIX' };
  }

  // Rule 2 - no fix version AND closed/cancelled (ignore)
  if (hasNoFix && (isDone || isCancelled)) {
    console.log(`    Rule 2: IGNORE (no fix version and closed/cancelled)`);
    return { id: ticketId, rule: 'IGNORE_CLOSED' };
  }

  // Rule 3 - tagged to the CURRENT release fix version (include/confirmed)
  if (fixVersions.includes(NEW_LABEL)) {
    console.log(`    Rule 3: CONFIRMED (tagged to current fix version)`);
    return { id: ticketId, rule: 'CONFIRMED' };
  }

  // Rule 4 - no fix version AND still open (flag)
  if (hasNoFix && !isDone && !isCancelled) {
    console.log(`    Rule 4: FLAG (no fix version, still open - code merged but not tagged)`);
    return { id: ticketId, rule: 'UNTAGGED_OPEN' };
  }

  // Fallback - has a fix version but it's the current one was not matched above
  // (shouldn't normally reach here, but treat as confirmed)
  console.log(`    Fallback: Treating as CONFIRMED`);
  return { id: ticketId, rule: 'CONFIRMED' };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  if (RAW.length === 0) {
    console.log('No tickets to classify');
    fs.appendFileSync(GH_OUTPUT, `confirmed_tickets=\nuntagged_open_tickets=\nticket_count=0\n`);
    return;
  }

  console.log(`\nClassifying ${RAW.length} tickets against Jira API\n`);
  console.log(`  Current fix version:  "${NEW_LABEL}"`);
  console.log(`  Previous fix version: "${PREV_LABEL}"`);
  if (RELEASE_TICKET) {
    console.log(`  Release ticket:       "${RELEASE_TICKET}" (will be excluded from results)\n`);
  } else {
    console.log();
  }

  const results = [];
  // Process sequentially to avoid hammering Jira API
  for (const id of RAW) {
    results.push(await classifyTicket(id));
  }

  const confirmed    = results.filter(r => r.rule === 'CONFIRMED').map(r => r.id);
  const untaggedOpen = results.filter(r => r.rule === 'UNTAGGED_OPEN').map(r => r.id);
  const ignoredPrev  = results.filter(r => r.rule === 'IGNORE_PREV_FIX').map(r => r.id);
  const ignoredClosed= results.filter(r => r.rule === 'IGNORE_CLOSED').map(r => r.id);

  // Filter out the release ticket itself from all lists
  const filterReleaseTicket = (tickets) => {
    if (!RELEASE_TICKET) return tickets;
    return tickets.filter(id => id !== RELEASE_TICKET);
  };

  const confirmedFiltered    = filterReleaseTicket(confirmed);
  const untaggedOpenFiltered = filterReleaseTicket(untaggedOpen);

  if (RELEASE_TICKET && (confirmed.length !== confirmedFiltered.length || untaggedOpen.length !== untaggedOpenFiltered.length)) {
    console.log(`\n⚠️  Release ticket ${RELEASE_TICKET} was found in commits and excluded from results`);
  }

  console.log(`\n========================================`);
  console.log(`Confirmed (Rule 3):        ${confirmedFiltered.length} tickets - ${confirmedFiltered.join(', ') || 'none'}`);
  console.log(`Untagged and open (Rule 4): ${untaggedOpenFiltered.length} tickets - ${untaggedOpenFiltered.join(', ') || 'none'}`);
  console.log(`Ignored (previous fix):     ${ignoredPrev.length} tickets - ${ignoredPrev.join(', ') || 'none'}`);
  console.log(`Ignored (closed, no fix):   ${ignoredClosed.length} tickets - ${ignoredClosed.join(', ') || 'none'}`);
  console.log(`========================================\n`);

  fs.appendFileSync(GH_OUTPUT, [
    `confirmed_tickets=${confirmedFiltered.join(',')}`,
    `untagged_open_tickets=${untaggedOpenFiltered.join(',')}`,
    `ticket_count=${confirmedFiltered.length}`,
    '',
  ].join('\n'));
}

main().catch(err => { console.error(err); process.exit(1); });