#!/usr/bin/env node
/**
 * update_jira_filter.js
 * ----------------------
 * Creates a brand new Jira saved filter for the new release version.
 *
 * Uses your exact JQL:
 *   project = ADCMS AND (issuetype = Story OR issuetype = Bug OR
 *   issuetype = Spike OR issuetype = Improvement OR issuetype = Task)
 *   AND fixVersion = "AEM 2.02.0 - Phoenix" ORDER BY key ASC
 *
 * The new filter URL is written to GITHUB_OUTPUT as `filter_url`
 * so downstream steps (release ticket, Slack) can reference it.
 *
 * Environment variables:
 *   JIRA_BASE_URL
 *   JIRA_USER_EMAIL
 *   JIRA_API_TOKEN
 *   JIRA_PROJECT_KEY     e.g. ADCMS
 *   NEW_VERSION_LABEL    e.g. "AEM 2.02.0 - Phoenix"
 *   DRY_RUN
 */

const https  = require('https');
const url    = require('url');
const fs     = require('fs');

const JIRA_BASE  = process.env.JIRA_BASE_URL.replace(/\/$/, '');
const EMAIL      = process.env.JIRA_USER_EMAIL;
const TOKEN      = process.env.JIRA_API_TOKEN;
const PROJECT    = process.env.JIRA_PROJECT_KEY;
const NEW_LABEL  = process.env.NEW_VERSION_LABEL;   // e.g. "AEM 2.02.0 - Phoenix"
const DRY_RUN    = process.env.DRY_RUN === 'true';
const GH_OUTPUT  = process.env.GITHUB_OUTPUT;

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
          reject(new Error(`Jira API ${res.statusCode} on ${method} ${path}: ${data}`));
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

// ── Build JQL — your exact format, only fixVersion swapped ───────────────────
function buildJQL() {
  return (
    `project = ${PROJECT} AND ` +
    `(issuetype = Story OR issuetype = Bug OR issuetype = Spike OR ` +
    `issuetype = Improvement OR issuetype = Task) AND ` +
    `fixVersion = "${NEW_LABEL}" ORDER BY key ASC`
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const jql        = buildJQL();
  const filterName = `${PROJECT} Release ${NEW_LABEL}`;

  console.log(`\n[Jira Filter] Creating new filter`);
  console.log(`  Name: "${filterName}"`);
  console.log(`  JQL:  ${jql}`);

  if (DRY_RUN) {
    console.log('\n[DRY RUN] Would create new filter - skipping');
    if (GH_OUTPUT) fs.appendFileSync(GH_OUTPUT, `filter_url=${JIRA_BASE}/issues/?filter=DRY_RUN\nfilter_id=0\n`);
    return;
  }

  // Fetch project ID first (required for sharePermissions)
  console.log(`\n[Jira Filter] Fetching project ID for ${PROJECT}`);
  const projectData = await request('GET', `project/${PROJECT}`);
  const projectId = projectData.id;
  console.log(`  Project ID: ${projectId}`);

  const result = await request('POST', 'filter', {
    name:        filterName,
    description: `Auto-created by Release Cut workflow for ${NEW_LABEL}`,
    jql,
    // Share with everyone in the project so the ADCMS team can access it
    sharePermissions: [
      { type: 'project', project: { id: projectId } },
    ],
  });

  const filterId  = result.id;
  const filterURL = `${JIRA_BASE}/issues/?filter=${filterId}`;

  console.log(`\nFilter created successfully`);
  console.log(`  ID:   ${filterId}`);
  console.log(`  Name: ${result.name}`);
  console.log(`  URL:  ${filterURL}`);

  // Write to GITHUB_OUTPUT so downstream jobs can use the URL
  if (GH_OUTPUT) {
    fs.appendFileSync(GH_OUTPUT, `filter_url=${filterURL}\nfilter_id=${filterId}\n`);
  }
}

main().catch(err => { console.error(err.message); process.exit(1); });