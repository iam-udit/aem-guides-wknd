#!/usr/bin/env node
/**
 * workflow_visualizer.js
 * ----------------------
 * Generates a visual representation of the release cut workflow progress.
 * Creates an ASCII diagram and optionally a Mermaid diagram for Slack/GitHub.
 *
 * Environment variables:
 *   WORKFLOW_STAGE           Current stage (start|backmerge|cut|tags|acm|jira|prs|complete)
 *   BACK_MERGE_RESULT        Job result: success|failure|cancelled|skipped
 *   APPROVAL_RESULT          Job result: success|failure|cancelled|skipped
 *   AWAIT_PR_RESULT          Job result: success|failure|cancelled|skipped
 *   CUT_BRANCH_RESULT        Job result: success|failure|cancelled|skipped
 *   ROTATE_TAGS_RESULT       Job result: success|failure|cancelled|skipped
 *   ACM_RESULT               Job result: success|failure|cancelled|skipped
 *   JIRA_RESULT              Job result: success|failure|cancelled|skipped
 *   PRS_RESULT               Job result: success|failure|cancelled|skipped
 *   OUTPUT_FORMAT            ascii|mermaid|both (default: both)
 */

const fs = require('fs');

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

const WORKFLOW_STAGE = (process.env.WORKFLOW_STAGE || 'start').toLowerCase();
const OUTPUT_FORMAT = (process.env.OUTPUT_FORMAT || 'both').toLowerCase();
const GH_OUTPUT = process.env.GITHUB_OUTPUT;

// Job results
const BACK_MERGE = (process.env.BACK_MERGE_RESULT || 'pending').toLowerCase();
const APPROVAL = (process.env.APPROVAL_RESULT || 'pending').toLowerCase();
const AWAIT_PR = (process.env.AWAIT_PR_RESULT || 'pending').toLowerCase();
const CUT_BRANCH = (process.env.CUT_BRANCH_RESULT || 'pending').toLowerCase();
const ROTATE_TAGS = (process.env.ROTATE_TAGS_RESULT || 'pending').toLowerCase();
const ACM = (process.env.ACM_RESULT || 'pending').toLowerCase();
const JIRA = (process.env.JIRA_RESULT || 'pending').toLowerCase();
const PRS = (process.env.PRS_RESULT || 'pending').toLowerCase();

/**
 * Workflow stages definition with their dependencies and status.
 */
const STAGES = [
  { id: 'start', name: 'Start', emoji: '🚀', result: 'success' },
  { id: 'backmerge', name: 'Back-merge', emoji: '🔀', result: BACK_MERGE },
  { id: 'approval', name: 'Approval Gate', emoji: '✋', result: APPROVAL },
  { id: 'await', name: 'Await PR Merge', emoji: '⏳', result: AWAIT_PR },
  { id: 'cut', name: 'Cut Branch', emoji: '✂️', result: CUT_BRANCH },
  { id: 'tags', name: 'Rotate Tags', emoji: '🏷️', result: ROTATE_TAGS },
  { id: 'acm', name: 'Adobe CM', emoji: '☁️', result: ACM },
  { id: 'jira', name: 'Jira Updates', emoji: '📋', result: JIRA },
  { id: 'prs', name: 'Notify PRs', emoji: '📢', result: PRS },
  { id: 'complete', name: 'Complete', emoji: '✅', result: WORKFLOW_STAGE === 'complete' ? 'success' : 'pending' }
];

/**
 * Get status icon for a job result.
 *
 * @param {string} result Job result status.
 * @returns {string} Status icon.
 */
function getStatusIcon(result) {
  switch (result) {
    case 'success': return '✅';
    case 'failure': return '❌';
    case 'cancelled': return '🚫';
    case 'skipped': return '⏭️';
    case 'in_progress': return '⏳';
    default: return '⚪';
  }
}

/**
 * Get status color for Mermaid diagram.
 *
 * @param {string} result Job result status.
 * @returns {string} Mermaid color class.
 */
function getStatusColor(result) {
  switch (result) {
    case 'success': return 'done';
    case 'failure': return 'crit';
    case 'cancelled': return 'crit';
    case 'skipped': return 'active';
    case 'in_progress': return 'active';
    default: return '';
  }
}

/**
 * Determine if a stage is currently active.
 *
 * @param {string} stageId Stage identifier.
 * @returns {boolean} True if stage is currently active.
 */
function isActiveStage(stageId) {
  return WORKFLOW_STAGE === stageId;
}

/**
 * Generate ASCII workflow visualization.
 *
 * @returns {string} ASCII diagram of workflow progress.
 */
function generateASCII() {
  const lines = [];
  
  lines.push('');
  lines.push('═══════════════════════════════════════════════════════════════');
  lines.push('                    RELEASE CUT WORKFLOW                       ');
  lines.push('═══════════════════════════════════════════════════════════════');
  lines.push('');

  STAGES.forEach((stage, index) => {
    const status = getStatusIcon(stage.result);
    const active = isActiveStage(stage.id) ? ' ◀ CURRENT' : '';
    const connector = index < STAGES.length - 1 ? '    │' : '';
    
    lines.push(`  ${status} ${stage.emoji}  ${stage.name}${active}`);
    if (connector) {
      lines.push(connector);
    }
  });

  lines.push('');
  lines.push('═══════════════════════════════════════════════════════════════');
  lines.push('Legend: ✅ Done  ❌ Failed  🚫 Cancelled  ⏭️ Skipped  ⚪ Pending');
  lines.push('═══════════════════════════════════════════════════════════════');
  lines.push('');

  return lines.join('\n');
}

/**
 * Generate Mermaid workflow diagram.
 *
 * @returns {string} Mermaid diagram syntax.
 */
function generateMermaid() {
  const lines = [];
  
  lines.push('```mermaid');
  lines.push('graph TD');
  lines.push('    classDef done fill:#90EE90,stroke:#006400,stroke-width:2px,color:#000');
  lines.push('    classDef crit fill:#FFB6C1,stroke:#8B0000,stroke-width:2px,color:#000');
  lines.push('    classDef active fill:#87CEEB,stroke:#00008B,stroke-width:2px,color:#000');
  lines.push('    classDef pending fill:#D3D3D3,stroke:#696969,stroke-width:1px,color:#000');
  lines.push('');

  STAGES.forEach((stage, index) => {
    const nodeId = `S${index}`;
    const label = `${stage.emoji} ${stage.name}`;
    const colorClass = getStatusColor(stage.result);
    
    lines.push(`    ${nodeId}["${label}"]:::${colorClass || 'pending'}`);
    
    if (index < STAGES.length - 1) {
      const nextNodeId = `S${index + 1}`;
      lines.push(`    ${nodeId} --> ${nextNodeId}`);
    }
  });

  lines.push('```');
  
  return lines.join('\n');
}

/**
 * Generate progress percentage.
 *
 * @returns {number} Progress percentage (0-100).
 */
function calculateProgress() {
  const completed = STAGES.filter(s => s.result === 'success').length;
  return Math.round((completed / STAGES.length) * 100);
}

/**
 * Generate progress bar.
 *
 * @param {number} percentage Progress percentage.
 * @param {number} width Bar width in characters.
 * @returns {string} Progress bar string.
 */
function generateProgressBar(percentage, width = 20) {
  const filled = Math.round((percentage / 100) * width);
  const empty = width - filled;
  return `[${'█'.repeat(filled)}${'░'.repeat(empty)}] ${percentage}%`;
}

/**
 * Main function to generate and output workflow visualization.
 *
 * @returns {Promise<void>} Resolves when visualization is generated.
 */
async function main() {
  console.log('[Workflow Visualizer] Generating workflow visualization\n');
  
  const progress = calculateProgress();
  const progressBar = generateProgressBar(progress);
  
  console.log(`Progress: ${progressBar}\n`);

  let output = '';

  if (OUTPUT_FORMAT === 'ascii' || OUTPUT_FORMAT === 'both') {
    const ascii = generateASCII();
    console.log(ascii);
    output += ascii;
  }

  if (OUTPUT_FORMAT === 'mermaid' || OUTPUT_FORMAT === 'both') {
    const mermaid = generateMermaid();
    console.log('\nMermaid Diagram:\n');
    console.log(mermaid);
    output += '\n\n' + mermaid;
  }

  // Export for use in other scripts
  if (GH_OUTPUT) {
    // Escape newlines for GitHub Actions output
    const escapedOutput = output.replace(/\n/g, '%0A');
    fs.appendFileSync(GH_OUTPUT, `workflow_visualization<<EOF\n${output}\nEOF\n`);
    fs.appendFileSync(GH_OUTPUT, `workflow_progress=${progress}\n`);
    console.log(`\n[Workflow Visualizer] Exported to GITHUB_OUTPUT`);
  }

  console.log('\n[Workflow Visualizer] Visualization complete');
}

main().catch(err => {
  console.error(`[Workflow Visualizer] Fatal error: ${err.message}`);
  process.exit(1);
});

// Made with Bob