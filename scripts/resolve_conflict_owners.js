#!/usr/bin/env node
/**
 * resolve_conflict_owners.js
 * --------------------------
 * Identifies the last commit author on each conflicting file from both the
 * develop branch and the previous release branch, resolves their Slack user IDs
 * via the Slack API using their GitHub commit email, and outputs structured JSON.
 *
 * Environment variables:
 *   GH_TOKEN                  GitHub token to fetch commit authors
 *   SLACK_BOT_TOKEN           Slack bot token to look up users by email
 *   CONFLICT_FILES            Comma-separated list of conflicting file paths
 *   PREV_RELEASE_BRANCH       The release branch name
 *   GITHUB_ACTOR              The person who triggered the release cut workflow
 *   GITHUB_REPOSITORY         Repository name for API calls
 *   OWNERS_OUTPUT_PATH        File path to write the JSON output
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

const GH_TOKEN          = requireEnv('GH_TOKEN');
const SLACK_BOT_TOKEN   = requireEnv('SLACK_BOT_TOKEN');
const CONFLICT_FILES    = requireEnv('CONFLICT_FILES');
const PREV_BRANCH       = requireEnv('PREV_RELEASE_BRANCH');
const GITHUB_ACTOR      = requireEnv('GITHUB_ACTOR');
const REPO              = requireEnv('GITHUB_REPOSITORY');
const OUTPUT_PATH       = requireEnv('OWNERS_OUTPUT_PATH');

const SERVER_URL = (process.env.GITHUB_SERVER_URL || 'https://github.com').replace(/\/$/, '');
const GHE_HOST   = SERVER_URL.replace(/^https?:\/\//, '');
const API_BASE   = GHE_HOST === 'github.com'
  ? 'https://api.github.com'
  : `https://${GHE_HOST}/api/v3`;

const GH_HEADERS = {
  'Authorization':        `Bearer ${GH_TOKEN}`,
  'Accept':               'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent':           'ADCMS Release Bot (conflict-owners)',
};

/**
 * Executes a GitHub REST API request and parses the JSON response body.
 *
 * @param {string} method HTTP method to use.
 * @param {string} path GitHub API path relative to the resolved API base URL.
 * @returns {Promise<object|Array>} Parsed GitHub API response payload.
 */
function ghRequest(method, path) {
  return new Promise((resolve, reject) => {
    const parsed  = url.parse(`${API_BASE}${path}`);
    const options = {
      hostname: parsed.hostname,
      path:     parsed.path,
      method,
      headers:  GH_HEADERS,
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
    req.end();
  });
}

/**
 * Looks up a Slack user by their email address.
 *
 * @param {string} email Email address to search for.
 * @returns {Promise<object|null>} Slack user object or null if not found.
 */
function lookupSlackUserByEmail(email) {
  return new Promise((resolve, reject) => {
    const parsed = url.parse(`https://slack.com/api/users.lookupByEmail?email=${encodeURIComponent(email)}`);
    const options = {
      hostname: parsed.hostname,
      path:     parsed.path,
      method:   'GET',
      headers: {
        'Authorization': `Bearer ${SLACK_BOT_TOKEN}`,
        'Content-Type':  'application/json',
      },
    };

    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const response = JSON.parse(data);
          console.log(`      Slack API response for ${email}:`, JSON.stringify(response, null, 2));
          if (response.ok && response.user) {
            resolve(response.user);
          } else {
            console.log(`      Slack lookup failed: ${response.error || 'user not found'}`);
            resolve(null);
          }
        } catch (err) {
          reject(new Error(`Failed to parse Slack response: ${err.message}`));
        }
      });
    });

    req.on('error', reject);
    req.end();
  });
}

/**
 * Fetches the last commit author for a specific file on a given branch.
 *
 * @param {string} filePath Path to the file in the repository.
 * @param {string} branch Branch name to check.
 * @returns {Promise<object>} Object with github_username and email.
 */
async function getLastCommitAuthor(filePath, branch) {
  try {
    // Get commits for this file on the specified branch
    const commits = await ghRequest('GET', `/repos/${REPO}/commits?path=${encodeURIComponent(filePath)}&sha=${encodeURIComponent(branch)}&per_page=1`);
    
    if (!commits || commits.length === 0) {
      console.warn(`  No commits found for ${filePath} on ${branch}`);
      return { github_username: 'unknown', email: 'unknown@example.com' };
    }

    const lastCommit = commits[0];
    const commitAuthor = lastCommit.commit.author;
    const githubUser = lastCommit.author?.login || commitAuthor.name || 'unknown';
    
    // The email from commit.author is the one used in the git commit
    const email = commitAuthor.email || 'unknown@example.com';

    console.log(`      Found: ${githubUser} <${email}>`);
    return { github_username: githubUser, email };
  } catch (err) {
    console.warn(`  Error fetching commit author for ${filePath} on ${branch}: ${err.message}`);
    return { github_username: 'unknown', email: 'unknown@example.com' };
  }
}

/**
 * Resolves owner information including Slack user ID and handle.
 *
 * @param {object} author Object with github_username and email.
 * @returns {Promise<object>} Owner object with slack_id and slack_handle.
 */
async function resolveOwner(author) {
  const owner = {
    github_username: author.github_username,
    email: author.email,
    slack_id: null,
    slack_handle: null,
  };

  // Skip lookup for unknown/invalid emails
  if (!author.email || author.email === 'unknown@example.com' || !author.email.includes('@')) {
    owner.slack_handle = `github:${author.github_username}`;
    console.log(`      Skipping Slack lookup for invalid email: ${author.email}`);
    return owner;
  }

  try {
    console.log(`      Looking up Slack user for: ${author.email}`);
    const slackUser = await lookupSlackUserByEmail(author.email);
    if (slackUser) {
      owner.slack_id = slackUser.id;
      owner.slack_handle = `@${slackUser.name || slackUser.real_name || author.github_username}`;
      console.log(`      ✓ Found Slack user: ${owner.slack_handle} (${owner.slack_id})`);
    } else {
      // Email mismatch - use GitHub username prefixed with github:
      owner.slack_handle = `github:${author.github_username}`;
      console.log(`      ✗ No Slack user found, using: ${owner.slack_handle}`);
    }
  } catch (err) {
    console.warn(`      Could not resolve Slack user for ${author.email}: ${err.message}`);
    owner.slack_handle = `github:${author.github_username}`;
  }

  return owner;
}

/**
 * Main function to process all conflicting files and generate the output JSON.
 *
 * @returns {Promise<void>} Resolves when processing completes and output is written.
 */
async function main() {
  console.log('\n[Conflict Owners] Resolving file owners for conflicting files\n');

  const files = CONFLICT_FILES.split(',').map(f => f.trim()).filter(Boolean);
  
  if (files.length === 0) {
    console.log('[Conflict Owners] No conflicting files provided');
    const emptyOutput = {
      files: [],
      unique_owners: [],
      release_cut_owner_slack_id: null,
    };
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(emptyOutput, null, 2));
    return;
  }

  console.log(`Processing ${files.length} conflicting file(s):\n`);

  const fileOwners = [];
  const uniqueSlackIds = new Set();

  for (const filePath of files) {
    console.log(`  ${filePath}`);
    
    // Get last commit author from develop branch
    console.log(`    Checking develop branch...`);
    const developAuthor = await getLastCommitAuthor(filePath, 'develop');
    
    // Get last commit author from previous release branch
    console.log(`    Checking ${PREV_BRANCH}...`);
    const releaseAuthor = await getLastCommitAuthor(filePath, PREV_BRANCH);
    
    // Resolve Slack users
    console.log(`    Resolving Slack users...`);
    console.log(`      Develop owner:`);
    const developOwner = await resolveOwner(developAuthor);
    console.log(`      Release owner:`);
    const releaseOwner = await resolveOwner(releaseAuthor);
    
    fileOwners.push({
      path: filePath,
      develop_owner: developOwner,
      release_owner: releaseOwner,
    });

    // Collect unique Slack IDs
    if (developOwner.slack_id) uniqueSlackIds.add(developOwner.slack_id);
    if (releaseOwner.slack_id) uniqueSlackIds.add(releaseOwner.slack_id);
    
    console.log();
  }

  // Resolve release cut owner (workflow trigger)
  console.log(`Resolving release cut owner: ${GITHUB_ACTOR}`);
  let releaseCutOwnerSlackId = null;
  
  try {
    // Try to get the GitHub user's email
    const actorData = await ghRequest('GET', `/users/${GITHUB_ACTOR}`);
    console.log(`  GitHub user data:`, JSON.stringify(actorData, null, 2));
    
    if (actorData.email) {
      console.log(`  Attempting Slack lookup for: ${actorData.email}`);
      const slackUser = await lookupSlackUserByEmail(actorData.email);
      if (slackUser) {
        releaseCutOwnerSlackId = slackUser.id;
        uniqueSlackIds.add(slackUser.id);
        console.log(`  ✓ Found Slack user: ${slackUser.name} (${slackUser.id})`);
      } else {
        console.log(`  ✗ No Slack user found for email: ${actorData.email}`);
      }
    } else {
      console.log(`  ✗ No public email available for GitHub user: ${GITHUB_ACTOR}`);
    }
  } catch (err) {
    console.warn(`  Could not resolve release cut owner: ${err.message}`);
  }

  const output = {
    files: fileOwners,
    unique_owners: Array.from(uniqueSlackIds),
    release_cut_owner_slack_id: releaseCutOwnerSlackId,
  };

  console.log(`\n[Conflict Owners] Writing output to ${OUTPUT_PATH}`);
  console.log(`  Total files: ${fileOwners.length}`);
  console.log(`  Unique owners: ${output.unique_owners.length}`);
  console.log(`  Release cut owner: ${releaseCutOwnerSlackId || 'not resolved'}\n`);

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
  console.log('[Conflict Owners] Complete\n');
}

main().catch(err => {
  console.error(`[Conflict Owners] Fatal error: ${err.message}`);
  process.exit(1);
});

// Made with Bob
