/* Independent gate on the generated snapshot.
 *
 * fetch-snapshot.mjs is written to be safe; this script assumes it isn't.
 * It re-reads the finished file and refuses to let the workflow commit
 * anything containing commit messages, e-mail addresses, SHAs or credentials.
 *
 * The key check is a strict ALLOWLIST of object keys: a future edit that starts
 * copying extra API fields through fails here rather than shipping quietly.
 */

import { readFile } from 'node:fs/promises';

const FILE = process.argv[2] || process.env.SNAPSHOT_OUT || 'data/overseer.json';

const ALLOWED_KEYS = new Set([
  'generatedAt', 'source', 'sourceNote', 'repo', 'totalCommits', 'adds', 'dels',
  'weekly', 'days', 'people', 'languages', 'langNote', 'truncated',
  // repo
  'name', 'url', 'desc', 'avatar', 'created', 'pushed', 'stars', 'branch',
  // weekly buckets
  't', 'commits',
  // languages
  'pct',
]);

// Keys that must never appear, whatever else changes.
const FORBIDDEN_KEYS = new Set([
  'message', 'title', 'body', 'description', 'id', 'short_id', 'sha',
  'author_email', 'committer_email', 'email', 'web_url', 'diff', 'content',
  'token', 'private_token', 'password',
]);

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const SECRETS = [
  /glpat-[A-Za-z0-9_-]{10,}/,       // GitLab PAT
  /glrt-[A-Za-z0-9_-]{10,}/,        // GitLab runner token
  /gh[pousr]_[A-Za-z0-9]{20,}/,     // GitHub tokens
  /-----BEGIN [A-Z ]*PRIVATE KEY/,  // any private key
];
// A 40-char hex run is a git SHA; 7-char short SHAs are too collision-prone
// with ordinary words to test for safely.
const SHA = /\b[0-9a-f]{40}\b/;

const problems = [];

function walk(node, path) {
  if (node === null || node === undefined) return;

  if (Array.isArray(node)) {
    node.forEach((v, i) => walk(v, `${path}[${i}]`));
    return;
  }

  if (typeof node === 'object') {
    for (const key of Object.keys(node)) {
      const here = path ? `${path}.${key}` : key;
      const lower = key.toLowerCase();

      // `days` is a map keyed by date, so its keys are data, not field names.
      const isDateMapKey = /^days(\.|$)/.test(path) || path === 'days';

      if (!isDateMapKey) {
        if (FORBIDDEN_KEYS.has(lower)) {
          problems.push(`forbidden key "${here}"`);
        } else if (!ALLOWED_KEYS.has(key)) {
          problems.push(`key not on the allowlist: "${here}"`);
        }
      } else if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) {
        problems.push(`days key is not a date: "${here}"`);
      }

      walk(node[key], here);
    }
    return;
  }

  if (typeof node === 'string') {
    if (EMAIL.test(node)) problems.push(`e-mail address in ${path}: "${node.slice(0, 40)}"`);
    if (SHA.test(node)) problems.push(`commit SHA in ${path}`);
    for (const re of SECRETS) {
      if (re.test(node)) problems.push(`possible credential in ${path}`);
    }
  }
}

const raw = await readFile(FILE, 'utf8');
let data;
try {
  data = JSON.parse(raw);
} catch (e) {
  console.error(`${FILE} is not valid JSON: ${e.message}`);
  process.exit(1);
}

walk(data, '');

// Sanity checks: an empty or broken snapshot should not silently replace a good one.
if (!data.totalCommits || data.totalCommits < 1) problems.push('totalCommits is zero or missing');
if (!Array.isArray(data.people) || data.people.length < 1) problems.push('no contributors');
if (!Array.isArray(data.weekly) || data.weekly.length < 1) problems.push('no weekly buckets');

// The whole-file scan catches anything the structural walk cannot reach.
for (const re of SECRETS) {
  if (re.test(raw)) problems.push('credential pattern found in the raw file');
}

if (problems.length) {
  console.error('Snapshot REJECTED — it must not be published:\n');
  for (const p of [...new Set(problems)]) console.error('  ✗ ' + p);
  process.exit(1);
}

console.log(
  `Snapshot OK: ${data.totalCommits} commits, ${data.people.length} people, ` +
  `${data.weekly.length} weeks. No messages, e-mails, SHAs or credentials found.`
);
