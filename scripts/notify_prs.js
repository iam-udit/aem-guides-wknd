#!/usr/bin/env node
/**
 * notify_prs.js
 * -------------
 * Finds all open PRs targeting `develop` and posts a comment
 * asking devs to retarget or clean up fix versions.
 *
 * Env vars:
 *   GH_TOKEN
 *   GITHUB_SERVER_URL    e.g. https://github.ibm.com
 *   GITHUB_REPOSITORY    e.g. IBM/adcms
 *   GITHUB_RUN_NUMBER
 *   GITHUB_RUN_ID
 *   NEW_RELEASE_BRANCH   e.g. release/2.02.0
 *   NEW_VERSION          e.g. 2.02.0
 *   NEW_VERSION_LABEL    e.g. "AEM 2.02.0 - Phoenix"
 */

const https  = require('https');
const url    = require('url');

const TOKEN       = process.env.GH_TOKEN;
const SERVER_URL  = (process.env.GITHUB_SERVER_URL || 'https://github.com').replace(/\/$/, '');
const REPO        = process.env.GITHUB_REPOSITORY;
const RUN_NUMBER  = process.env.GITHUB_RUN_NUMBER || '?';
const RUN_ID      = process.env.GITHUB_RUN_ID     || '';
const NEW_BRANCH  = process.env.NEW_RELEASE_BRANCH;
const NEW_VER     = process.env.NEW_VERSION;
const NEW_LABEL   = process.env.NEW_VERSION_LABEL;

// GitHub Enterprise: API is at <server>/api/v3
const GHE_HOST  = SERVER_URL.replace(/^https?:\/\//, '');
const API_BASE  = `https://${GHE_HOST}/api/v3`;

const HEADERS = {
  'Authorization':        `Bearer ${TOKEN}`,
  'Accept':               'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'Content-Type':         'application/json',
};

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
        ...HEADERS,
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

// ── Comment body ──────────────────────────────────────────────────────────────
function buildComment(author) {
  const runURL = `${SERVER_URL}/${REPO}/actions/runs/${RUN_ID}`;
  return `👋 Hi @${author} — automated notice from the **ADCMS Release Cut bot**.

---

**Release \`${NEW_LABEL}\` has been cut.** Branch \`${NEW_BRANCH}\` now exists as the new release branch.

Please check the following for this PR:

| # | Your situation | Action needed |
|---|---|---|
| 1 | PR contains changes **intended for \`${NEW_LABEL}\`** | Retarget from \`develop\` → \`${NEW_BRANCH}\` |
| 2 | PR is **not intended for this release** | No action — will ship in a future release |
| 3 | Jira ticket has **fix version \`${NEW_LABEL}\`** but PR targets \`develop\` | Either retarget to \`${NEW_BRANCH}\` OR remove the fix version from Jira |
| 4 | Your files were involved in a **back-merge conflict** | Cross-verify your changes are intact on \`develop\` after conflict resolution |

If unsure, check with the release manager before making changes.

---
_Auto-posted by [Release Cut workflow run #${RUN_NUMBER}](${runURL})_`;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n[PR Notify] Fetching open PRs targeting \`develop\` in ${REPO}...`);

  const prs = await getAllOpenPRs();
  console.log(`[PR Notify] Found ${prs.length} open PRs\n`);

  if (!prs.length) {
    console.log('[PR Notify] Nothing to do.');
    return;
  }

  let commented = 0;
  for (const pr of prs) {
    const { number, title, user } = pr;
    const author = user?.login || 'unknown';
    try {
      await ghRequest('POST', `/repos/${REPO}/issues/${number}/comments`, {
        body: buildComment(author),
      });
      console.log(`  ✅ PR #${number} — "${title}" (@${author})`);
      commented++;
    } catch (err) {
      console.error(`  ❌ PR #${number} — failed: ${err.message}`);
    }
  }

  console.log(`\n[PR Notify] Done — commented on ${commented}/${prs.length} PRs`);
}

main().catch(err => { console.error(err); process.exit(1); });