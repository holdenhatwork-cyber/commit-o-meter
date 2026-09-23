/* Builds a public snapshot of a private GitLab project.
 *
 * SAFETY CONTRACT — this script is the only thing that ever touches the token,
 * and it must never write any of the following into the output file:
 *   - source code, diffs or file contents  (never fetched: only /commits?with_stats,
 *     which returns counts, and /languages, which returns percentages)
 *   - commit messages, titles or SHAs      (present in the API response; dropped here)
 *   - author or committer e-mail addresses (present in the API response; dropped here)
 *   - the token itself
 *
 * The output is built by CONSTRUCTING a fresh object from named fields, never by
 * filtering or spreading the API response. verify-snapshot.mjs independently
 * re-checks the result and fails the build if anything forbidden slipped through.
 */

const HOST = process.env.GITLAB_HOST || 'gitlab.nortal.com';
const PROJECT = process.env.GITLAB_PROJECT || 'Anton.Zatkin/empis-overseer';
const TOKEN = process.env.GITLAB_TOKEN;
const OUT = process.env.SNAPSHOT_OUT || 'data/overseer.json';
const MAX_PAGES = 100;                        // 10k commits
const WEEK = 604800000, DAY = 86400000;

if (!TOKEN) {
  console.error('GITLAB_TOKEN is not set. Refusing to run.');
  process.exit(1);
}

const base = `https://${HOST}/api/v4/projects/${encodeURIComponent(PROJECT)}`;

async function api(path) {
  const res = await fetch(base + path, {
    headers: { 'PRIVATE-TOKEN': TOKEN },
  });
  if (!res.ok) {
    // Never echo the body: an error page could quote the request, token included.
    throw new Error(`GitLab returned HTTP ${res.status} for ${path.split('?')[0]}`);
  }
  return res.json();
}

function weekStart(ms) {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - d.getUTCDay());
}
const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);

async function main() {
  console.log(`Fetching ${PROJECT} from ${HOST}…`);

  const meta = await api('');
  const langs = await api('/languages').catch(() => ({}));

  const weekly = new Map();
  const days = Object.create(null);
  const people = new Map();
  let totalCommits = 0, adds = 0, dels = 0, truncated = false;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const batch = await api(`/repository/commits?per_page=100&with_stats=true&page=${page}`);
    if (!Array.isArray(batch) || batch.length === 0) break;

    for (const c of batch) {
      // Read ONLY these three fields. Everything else on `c` — id, title,
      // message, author_email, committer_email, web_url — is deliberately ignored.
      const when = c.committed_date || c.created_at;
      const authorName = c.author_name;
      const a = (c.stats && c.stats.additions) || 0;
      const d = (c.stats && c.stats.deletions) || 0;

      const ts = Date.parse(when);
      if (Number.isNaN(ts)) continue;

      totalCommits++; adds += a; dels += d;

      const wk = weekStart(ts);
      const slot = weekly.get(wk) || { t: wk, commits: 0, adds: 0, dels: 0 };
      slot.commits++; slot.adds += a; slot.dels += d;
      weekly.set(wk, slot);

      const dk = dayKey(ts);
      days[dk] = (days[dk] || 0) + 1;

      // Strip anything e-mail shaped defensively, in case a display name is one.
      const name = String(authorName || 'unknown').includes('@')
        ? String(authorName).split('@')[0]
        : String(authorName || 'unknown');
      const p = people.get(name) || { name, commits: 0, adds: 0, dels: 0 };
      p.commits++; p.adds += a; p.dels += d;
      people.set(name, p);
    }

    if (batch.length < 100) break;
    if (page === MAX_PAGES) truncated = true;
  }

  const langList = Object.keys(langs)
    .map((k) => ({ name: String(k), pct: Number(langs[k]) }))
    .sort((x, y) => y.pct - x.pct);

  const snapshot = {
    generatedAt: Date.now(),
    source: 'GitLab',
    sourceNote: truncated
      ? `Snapshot of the ${totalCommits.toLocaleString('en-US')} most recent commits.`
      : `Snapshot of every commit on ${meta.default_branch || 'the default branch'}.`,
    repo: {
      // Deliberately omitted: description and avatar_url, which can carry
      // client-identifying text or require auth to load.
      name: String(meta.path_with_namespace || PROJECT),
      url: String(meta.web_url || `https://${HOST}/${PROJECT}`),
      desc: null,
      avatar: null,
      created: Date.parse(meta.created_at) || null,
      pushed: Date.parse(meta.last_activity_at) || null,
      stars: typeof meta.star_count === 'number' ? meta.star_count : null,
      branch: String(meta.default_branch || ''),
    },
    totalCommits,
    adds,
    dels,
    weekly: [...weekly.values()].sort((x, y) => x.t - y.t),
    days,
    people: [...people.values()].sort((x, y) => y.commits - x.commits),
    languages: langList,
    langNote: 'Share of tracked bytes, as reported by GitLab.',
    truncated,
  };

  const { writeFile, mkdir } = await import('node:fs/promises');
  const { dirname } = await import('node:path');
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(snapshot, null, 1) + '\n', 'utf8');

  console.log(
    `Wrote ${OUT}: ${totalCommits} commits, ${people.size} people, ` +
    `+${adds}/-${dels} lines, ${snapshot.weekly.length} weeks.`
  );
}

main().catch((err) => {
  console.error('Snapshot failed:', err.message);
  process.exit(1);
});
