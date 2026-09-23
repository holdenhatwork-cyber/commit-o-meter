/* Commit-o-meter — a static, browser-only dashboard for GitLab / GitHub repos.
   No build step, no server, no dependencies. */
(function () {
  'use strict';

  /* ------------------------------------------------------------------ utils */
  var $ = function (id) { return document.getElementById(id); };
  var WEEK = 604800000, DAY = 86400000;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function num(n) { return Math.round(n || 0).toLocaleString('en-US'); }
  function compact(n) {
    n = Math.round(n || 0);
    if (n >= 1e9) return (n / 1e9).toFixed(n >= 1e10 ? 0 : 1).replace(/\.0$/, '') + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M';
    if (n >= 1e4) return (n / 1e3).toFixed(0) + 'k';
    return n.toLocaleString('en-US');
  }
  function plural(n, one, many) { return n === 1 ? one : (many || one + 's'); }
  function weekStart(ms) {                       // Sunday 00:00 UTC
    var d = new Date(ms);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - d.getUTCDay());
  }
  function dayKey(ms) { return new Date(ms).toISOString().slice(0, 10); }
  function fmtDate(ms) {
    return new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  }
  // Weekly buckets only exist where something happened; the x-axis is linear in
  // time, so quiet weeks have to be materialised as zeros or the gaps lie.
  function densifyWeekly(sparse) {
    if (sparse.length < 2) return sparse;
    var byT = {};
    sparse.forEach(function (w) { byT[w.t] = w; });
    var out = [];
    for (var t = sparse[0].t; t <= sparse[sparse.length - 1].t; t += WEEK) {
      out.push(byT[t] || { t: t, commits: 0, adds: 0, dels: 0 });
    }
    return out;
  }

  function niceMax(v) {
    if (v <= 0) return 1;
    var mag = Math.pow(10, Math.floor(Math.log10(v))), r = v / mag;
    return (r <= 1 ? 1 : r <= 2 ? 2 : r <= 2.5 ? 2.5 : r <= 5 ? 5 : 10) * mag;
  }

  /* ------------------------------------------------------------------ theme */
  var themeKey = 'com.theme';
  try {
    var savedTheme = localStorage.getItem(themeKey);
    if (savedTheme) document.documentElement.setAttribute('data-theme', savedTheme);
  } catch (e) { /* storage blocked — fall back to OS preference */ }

  $('themeToggle').addEventListener('click', function () {
    var cur = document.documentElement.getAttribute('data-theme');
    var isDark = cur ? cur === 'dark'
      : window.matchMedia('(prefers-color-scheme: dark)').matches;
    var next = isDark ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem(themeKey, next); } catch (e) { /* ignore */ }
    if (lastModel) render(lastModel);          // re-draw SVGs with new tokens
  });

  /* ------------------------------------------------------------------ tokens */
  function tokenKey(host) { return 'com.token.' + host; }
  function getToken(host) {
    try { return localStorage.getItem(tokenKey(host)) || ''; } catch (e) { return ''; }
  }
  function listTokenHosts() {
    var out = [];
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf('com.token.') === 0) out.push(k.slice(10));
      }
    } catch (e) { /* ignore */ }
    return out;
  }
  function refreshTokenState() {
    var hosts = listTokenHosts();
    $('tokenState').textContent = hosts.length
      ? 'Token stored for: ' + hosts.join(', ')
      : 'No token stored. Public repos still work without one.';
  }
  $('tokenSave').addEventListener('click', function () {
    var host = $('tokenHost').value.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    var tok = $('tokenInput').value.trim();
    if (!host || !tok) { $('tokenState').textContent = 'Enter both a host and a token.'; return; }
    try { localStorage.setItem(tokenKey(host), tok); } catch (e) {
      $('tokenState').textContent = 'This browser blocked local storage, so the token could not be saved.';
      return;
    }
    $('tokenInput').value = '';
    refreshTokenState();
  });
  $('tokenClear').addEventListener('click', function () {
    listTokenHosts().forEach(function (h) {
      try { localStorage.removeItem(tokenKey(h)); } catch (e) { /* ignore */ }
    });
    $('tokenInput').value = '';
    refreshTokenState();
  });
  refreshTokenState();

  /* ------------------------------------------------------------------ target parsing */
  function parseTarget(raw) {
    var s = String(raw || '').trim();
    if (!s) return null;
    s = s.replace(/^git@([^:]+):(.+?)(\.git)?$/, 'https://$1/$2');   // ssh remote
    s = s.replace(/\.git$/, '');

    if (!/^https?:\/\//i.test(s)) {
      if (/^[\w.-]+\/[\w.-]+$/.test(s)) return { kind: 'github', host: 'github.com', path: s };
      s = 'https://' + s;
    }
    var u;
    try { u = new URL(s); } catch (e) { return null; }

    var path = u.pathname.replace(/^\/+|\/+$/g, '');
    path = path.split('/-/')[0];                                      // strip /-/tree/main etc.
    path = path.replace(/\/(tree|blob|commits?|merge_requests|pulls?)\/.*$/, '');
    if (!path || path.indexOf('/') === -1) return null;

    var host = u.hostname;
    if (/(^|\.)github\.com$/i.test(host)) {
      return { kind: 'github', host: 'github.com', path: path.split('/').slice(0, 2).join('/') };
    }
    return { kind: 'gitlab', host: host, path: path, origin: u.origin };
  }

  /* ------------------------------------------------------------------ fetching */
  function apiFetch(url, host) {
    var headers = {};
    var tok = getToken(host);
    if (tok) headers[host === 'github.com' ? 'Authorization' : 'PRIVATE-TOKEN'] =
      host === 'github.com' ? 'Bearer ' + tok : tok;
    if (host === 'github.com') headers.Accept = 'application/vnd.github+json';
    return fetch(url, { headers: headers, mode: 'cors', credentials: 'omit' });
  }

  function httpError(res, host) {
    var e = new Error('HTTP ' + res.status);
    e.status = res.status;
    e.host = host;
    return e;
  }

  /* ---- GitHub ---- */
  function githubStats(url, host, tries) {
    // /stats/* endpoints answer 202 (with an empty object) while GitHub computes
    // them in the background; poll politely, then give up and report "no data".
    tries = tries == null ? 6 : tries;
    return apiFetch(url, host).then(function (res) {
      if (res.status === 202) {
        if (tries <= 0) return [];
        return new Promise(function (r) { setTimeout(r, 1500); })
          .then(function () { return githubStats(url, host, tries - 1); });
      }
      if (res.status === 204) return [];
      if (!res.ok) throw httpError(res, host);
      return res.json().then(function (j) { return Array.isArray(j) ? j : []; });
    });
  }

  function loadGitHub(t, progress) {
    var base = 'https://api.github.com/repos/' + t.path;
    progress('Asking GitHub about ' + t.path + '…');

    return apiFetch(base, t.host).then(function (res) {
      if (!res.ok) throw httpError(res, t.host);
      return res.json();
    }).then(function (meta) {
      progress('Counting commits and crunching a year of history…');
      return Promise.all([
        meta,
        githubStats(base + '/stats/contributors', t.host).catch(function () { return []; }),
        githubStats(base + '/stats/commit_activity', t.host).catch(function () { return []; }),
        apiFetch(base + '/languages', t.host).then(function (r) { return r.ok ? r.json() : {}; })
          .catch(function () { return {}; }),
        apiFetch(base + '/commits?per_page=1', t.host).then(function (r) {
          var link = r.headers.get('Link') || '';
          var m = link.match(/[?&]page=(\d+)>;\s*rel="last"/);
          return m ? parseInt(m[1], 10) : (r.ok ? r.json().then(function (a) { return a.length; }) : 0);
        }).catch(function () { return 0; })
      ]);
    }).then(function (parts) {
      var meta = parts[0], langs = parts[3] || {}, linkCount = parts[4] || 0;
      var contrib = Array.isArray(parts[1]) ? parts[1] : [];
      var activity = Array.isArray(parts[2]) ? parts[2] : [];

      var weeklyMap = {}, adds = 0, dels = 0, statCommits = 0;
      var people = contrib.map(function (c) {
        var a = 0, d = 0;
        (c.weeks || []).forEach(function (w) {
          a += w.a; d += w.d;
          if (w.c || w.a || w.d) {
            var k = w.w * 1000;
            var slot = weeklyMap[k] || (weeklyMap[k] = { t: k, commits: 0, adds: 0, dels: 0 });
            slot.commits += w.c; slot.adds += w.a; slot.dels += w.d;
          }
        });
        adds += a; dels += d; statCommits += c.total || 0;
        return {
          name: (c.author && c.author.login) || 'unknown',
          url: c.author && c.author.html_url,
          avatar: c.author && c.author.avatar_url,
          commits: c.total || 0, adds: a, dels: d
        };
      });

      var days = {};
      activity.forEach(function (w) {
        (w.days || []).forEach(function (n, i) {
          if (n) days[dayKey(w.week * 1000 + i * DAY)] = n;
        });
      });

      var totalBytes = 0;
      Object.keys(langs).forEach(function (k) { totalBytes += langs[k]; });

      return {
        source: 'GitHub',
        sourceNote: (adds || dels)
          ? 'Line counts come from GitHub’s contributor statistics.'
          : 'GitHub does not publish per-line statistics for a repository this large, so only commit counts are shown.',
        repo: {
          name: meta.full_name, url: meta.html_url, desc: meta.description,
          avatar: meta.owner && meta.owner.avatar_url,
          created: Date.parse(meta.created_at), pushed: Date.parse(meta.pushed_at),
          stars: meta.stargazers_count, branch: meta.default_branch
        },
        totalCommits: Math.max(linkCount, statCommits),
        adds: adds, dels: dels,
        weekly: Object.keys(weeklyMap).map(function (k) { return weeklyMap[k]; })
          .sort(function (a, b) { return a.t - b.t; }),
        days: days,
        people: people.sort(function (a, b) { return b.commits - a.commits; }),
        languages: Object.keys(langs).map(function (k) {
          return { name: k, pct: totalBytes ? langs[k] / totalBytes * 100 : 0 };
        }).sort(function (a, b) { return b.pct - a.pct; }),
        langNote: 'Share of tracked bytes in the repo.',
        truncated: contrib.length >= 100
      };
    });
  }

  /* ---- GitLab ---- */
  function loadGitLab(t, progress) {
    var origin = t.origin || ('https://' + t.host);
    var pid = encodeURIComponent(t.path);
    var base = origin + '/api/v4/projects/' + pid;
    progress('Asking ' + t.host + ' about ' + t.path + '…');

    return apiFetch(base, t.host).then(function (res) {
      if (!res.ok) throw httpError(res, t.host);
      return res.json();
    }).then(function (meta) {
      return apiFetch(base + '/languages', t.host)
        .then(function (r) { return r.ok ? r.json() : {}; })
        .catch(function () { return {}; })
        .then(function (langs) { return { meta: meta, langs: langs }; });
    }).then(function (ctx) {
      var commits = [], MAX_PAGES = 40, truncated = false;

      function page(n) {
        progress('Walking the commit history… ' + num(commits.length) + ' commits so far');
        var url = base + '/repository/commits?per_page=100&with_stats=true&page=' + n;
        return apiFetch(url, t.host).then(function (res) {
          if (!res.ok) throw httpError(res, t.host);
          return res.json();
        }).then(function (batch) {
          if (!Array.isArray(batch) || !batch.length) return;
          commits = commits.concat(batch);
          if (batch.length < 100) return;
          if (n >= MAX_PAGES) { truncated = true; return; }
          return page(n + 1);
        });
      }

      return page(1).then(function () {
        var weeklyMap = {}, days = {}, byPerson = {}, adds = 0, dels = 0;

        commits.forEach(function (c) {
          var ts = Date.parse(c.committed_date || c.created_at || c.authored_date);
          if (isNaN(ts)) return;
          var a = (c.stats && c.stats.additions) || 0;
          var d = (c.stats && c.stats.deletions) || 0;
          adds += a; dels += d;

          var wk = weekStart(ts);
          var slot = weeklyMap[wk] || (weeklyMap[wk] = { t: wk, commits: 0, adds: 0, dels: 0 });
          slot.commits++; slot.adds += a; slot.dels += d;

          var dk = dayKey(ts);
          days[dk] = (days[dk] || 0) + 1;

          var who = c.author_name || c.committer_name || 'unknown';
          var p = byPerson[who] || (byPerson[who] = { name: who, commits: 0, adds: 0, dels: 0 });
          p.commits++; p.adds += a; p.dels += d;
        });

        var langs = ctx.langs, langList = Object.keys(langs).map(function (k) {
          return { name: k, pct: langs[k] };
        }).sort(function (a, b) { return b.pct - a.pct; });

        var m = ctx.meta;
        return {
          source: 'GitLab',
          sourceNote: truncated
            ? 'Capped at the ' + num(commits.length) + ' most recent commits.'
            : 'Every commit on ' + (m.default_branch || 'the default branch') + ' was read individually.',
          repo: {
            name: m.path_with_namespace || m.name_with_namespace,
            url: m.web_url, desc: m.description,
            avatar: m.avatar_url || (m.namespace && m.namespace.avatar_url),
            created: Date.parse(m.created_at),
            pushed: Date.parse(m.last_activity_at),
            stars: m.star_count, branch: m.default_branch
          },
          totalCommits: commits.length,
          adds: adds, dels: dels,
          weekly: Object.keys(weeklyMap).map(function (k) { return weeklyMap[k]; })
            .sort(function (a, b) { return a.t - b.t; }),
          days: days,
          people: Object.keys(byPerson).map(function (k) { return byPerson[k]; })
            .sort(function (a, b) { return b.commits - a.commits; }),
          languages: langList,
          langNote: 'Share of tracked bytes, as reported by GitLab.',
          truncated: truncated
        };
      });
    });
  }

  /* ---- offline paste mode ---- */
  var GIT_CMD = 'git log --numstat --date=iso-strict --pretty=format:"@|%H|%an|%aI"';

  var EXT_LANG = {
    js: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript', jsx: 'JavaScript',
    ts: 'TypeScript', tsx: 'TypeScript', py: 'Python', rb: 'Ruby', go: 'Go',
    rs: 'Rust', java: 'Java', kt: 'Kotlin', kts: 'Kotlin', scala: 'Scala',
    cs: 'C#', cshtml: 'C#', fs: 'F#', c: 'C', h: 'C', cpp: 'C++', cc: 'C++',
    cxx: 'C++', hpp: 'C++', php: 'PHP', swift: 'Swift', m: 'Objective-C',
    dart: 'Dart', ex: 'Elixir', exs: 'Elixir', erl: 'Erlang', clj: 'Clojure',
    hs: 'Haskell', lua: 'Lua', pl: 'Perl', r: 'R', sql: 'SQL',
    html: 'HTML', htm: 'HTML', css: 'CSS', scss: 'SCSS', sass: 'SCSS',
    less: 'Less', vue: 'Vue', svelte: 'Svelte',
    sh: 'Shell', bash: 'Shell', zsh: 'Shell', ps1: 'PowerShell', bat: 'Batch',
    yml: 'YAML', yaml: 'YAML', json: 'JSON', xml: 'XML', toml: 'TOML',
    md: 'Markdown', rst: 'Markdown', tf: 'Terraform', gradle: 'Gradle',
    dockerfile: 'Docker', proto: 'Protobuf', graphql: 'GraphQL', tex: 'TeX'
  };

  function parseGitLog(text) {
    var lines = String(text).split(/\r?\n/);
    var commits = [], cur = null, langBytes = {};

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (line.slice(0, 2) === '@|') {
        var f = line.slice(2).split('|');
        var ts = Date.parse(f[2]);
        cur = { sha: f[0], who: (f[1] || 'unknown').trim(), ts: ts, adds: 0, dels: 0 };
        if (!isNaN(ts)) commits.push(cur);
        continue;
      }
      var m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
      if (m && cur) {
        var a = m[1] === '-' ? 0 : parseInt(m[1], 10);
        var d = m[2] === '-' ? 0 : parseInt(m[2], 10);
        cur.adds += a; cur.dels += d;
        var ext = (m[3].split('/').pop().split('.').pop() || '').toLowerCase();
        var lang = EXT_LANG[ext] || (/^dockerfile/i.test(m[3].split('/').pop()) ? 'Docker' : null);
        if (lang) langBytes[lang] = (langBytes[lang] || 0) + a;
      }
    }
    if (!commits.length) {
      throw new Error('No commits found in that text. Make sure you copied the whole output of the command, ' +
        'including the lines that start with "@|".');
    }

    var weeklyMap = {}, days = {}, byPerson = {}, adds = 0, dels = 0;
    commits.forEach(function (c) {
      adds += c.adds; dels += c.dels;
      var wk = weekStart(c.ts);
      var slot = weeklyMap[wk] || (weeklyMap[wk] = { t: wk, commits: 0, adds: 0, dels: 0 });
      slot.commits++; slot.adds += c.adds; slot.dels += c.dels;
      var dk = dayKey(c.ts);
      days[dk] = (days[dk] || 0) + 1;
      var p = byPerson[c.who] || (byPerson[c.who] = { name: c.who, commits: 0, adds: 0, dels: 0 });
      p.commits++; p.adds += c.adds; p.dels += c.dels;
    });

    var totalLang = 0;
    Object.keys(langBytes).forEach(function (k) { totalLang += langBytes[k]; });
    var times = commits.map(function (c) { return c.ts; });

    return {
      source: 'git log',
      sourceNote: 'Parsed from pasted output — nothing left your machine.',
      repo: {
        name: 'Your repository', url: null, desc: 'Built from a pasted git log.',
        avatar: null, created: Math.min.apply(null, times), pushed: Math.max.apply(null, times),
        stars: null, branch: null
      },
      totalCommits: commits.length,
      adds: adds, dels: dels,
      weekly: Object.keys(weeklyMap).map(function (k) { return weeklyMap[k]; })
        .sort(function (a, b) { return a.t - b.t; }),
      days: days,
      people: Object.keys(byPerson).map(function (k) { return byPerson[k]; })
        .sort(function (a, b) { return b.commits - a.commits; }),
      languages: Object.keys(langBytes).map(function (k) {
        return { name: k, pct: totalLang ? langBytes[k] / totalLang * 100 : 0 };
      }).sort(function (a, b) { return b.pct - a.pct; }),
      langNote: 'Share of added lines, by file extension.',
      truncated: false
    };
  }

  /* ------------------------------------------------------------------ tooltip */
  var tip = $('tooltip');
  function showTip(html, x, y) {
    tip.innerHTML = html;
    tip.hidden = false;
    var r = tip.getBoundingClientRect();
    var left = Math.min(Math.max(8, x + 14), window.innerWidth - r.width - 8);
    var top = y - r.height - 12;
    if (top < 8) top = y + 18;
    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
  }
  function hideTip() { tip.hidden = true; }
  document.addEventListener('scroll', hideTip, true);

  function bindTips(root) {
    root.querySelectorAll('[data-tip]').forEach(function (el) {
      el.addEventListener('mousemove', function (ev) { showTip(el.getAttribute('data-tip'), ev.clientX, ev.clientY); });
      el.addEventListener('mouseleave', hideTip);
      el.addEventListener('focus', function () {
        var r = el.getBoundingClientRect();
        showTip(el.getAttribute('data-tip'), r.left + r.width / 2, r.top);
      });
      el.addEventListener('blur', hideTip);
    });
  }

  /* ------------------------------------------------------------------ charts */
  function svgOpen(w, h) {
    return '<svg viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="xMidYMid meet" role="img">';
  }

  function timelineChart(weekly) {
    if (!weekly.length) return '<p class="empty-note">No weekly history available.</p>';
    var W = 900, H = 260, L = 48, R = 12, T = 12, B = 30;
    var iw = W - L - R, ih = H - T - B;
    var max = niceMax(Math.max.apply(null, weekly.map(function (d) { return d.commits; })));
    var n = weekly.length;
    var x = function (i) { return L + (n === 1 ? iw / 2 : i * iw / (n - 1)); };
    var y = function (v) { return T + ih - (v / max) * ih; };

    var s = svgOpen(W, H);

    // horizontal grid + y ticks
    [0, .25, .5, .75, 1].forEach(function (f) {
      var yy = T + ih - f * ih;
      s += '<line class="grid-line" x1="' + L + '" y1="' + yy + '" x2="' + (W - R) + '" y2="' + yy + '"/>';
      s += '<text class="tick tick-y" x="' + (L - 8) + '" y="' + (yy + 4) + '">' + compact(max * f) + '</text>';
    });

    var area = 'M' + x(0) + ',' + (T + ih);
    var line = '';
    weekly.forEach(function (d, i) {
      area += ' L' + x(i) + ',' + y(d.commits);
      line += (i ? ' L' : 'M') + x(i) + ',' + y(d.commits);
    });
    area += ' L' + x(n - 1) + ',' + (T + ih) + ' Z';

    s += '<path d="' + area + '" fill="var(--accent)" fill-opacity="0.14"/>';
    s += '<path d="' + line + '" fill="none" stroke="var(--accent)" stroke-width="2" ' +
         'stroke-linejoin="round" stroke-linecap="round"/>';
    s += '<line class="axis-line" x1="' + L + '" y1="' + (T + ih) + '" x2="' + (W - R) + '" y2="' + (T + ih) + '"/>';

    // x ticks — one per year where it fits
    var seenYear = {}, ticks = [];
    weekly.forEach(function (d, i) {
      var yr = new Date(d.t).getUTCFullYear();
      if (!seenYear[yr]) { seenYear[yr] = 1; ticks.push({ i: i, label: yr }); }
    });
    if (ticks.length > 12) ticks = ticks.filter(function (_, k) { return k % Math.ceil(ticks.length / 10) === 0; });
    ticks.forEach(function (t) {
      s += '<text class="tick" x="' + x(t.i) + '" y="' + (H - 10) + '" text-anchor="middle">' + t.label + '</text>';
    });

    // hover targets
    var bw = iw / n;
    weekly.forEach(function (d, i) {
      var cx = x(i);
      s += '<rect class="hit" x="' + (cx - bw / 2) + '" y="' + T + '" width="' + Math.max(bw, 2) + '" height="' + ih +
        '" tabindex="0" data-tip="' + esc('Week of ' + fmtDate(d.t) + '<br><b>' + num(d.commits) + '</b> ' +
          plural(d.commits, 'commit') + '<br><b>+' + num(d.adds) + '</b> / <b>-' + num(d.dels) + '</b> lines') + '"/>';
    });

    return s + '</svg>';
  }

  function churnChart(weekly) {
    var any = weekly.some(function (d) { return d.adds || d.dels; });
    if (!any) return '<p class="empty-note">No per-line statistics were available for this repository.</p>';

    var W = 900, H = 280, L = 56, R = 12, T = 12, B = 30;
    var iw = W - L - R, ih = H - T - B;
    var maxA = niceMax(Math.max.apply(null, weekly.map(function (d) { return d.adds; })));
    var maxD = niceMax(Math.max.apply(null, weekly.map(function (d) { return d.dels; })));
    var span = maxA + maxD || 1;
    var zero = T + ih * (maxA / span);
    var n = weekly.length;
    var step = iw / n;
    var bw = Math.max(1, step - 2);                  // 2px surface gap between bars

    var s = svgOpen(W, H);
    s += '<line class="grid-line" x1="' + L + '" y1="' + T + '" x2="' + (W - R) + '" y2="' + T + '"/>';
    s += '<text class="tick tick-y" x="' + (L - 8) + '" y="' + (T + 4) + '">+' + compact(maxA) + '</text>';
    s += '<text class="tick tick-y" x="' + (L - 8) + '" y="' + (zero + 4) + '">0</text>';
    s += '<line class="grid-line" x1="' + L + '" y1="' + (T + ih) + '" x2="' + (W - R) + '" y2="' + (T + ih) + '"/>';
    s += '<text class="tick tick-y" x="' + (L - 8) + '" y="' + (T + ih + 4) + '">-' + compact(maxD) + '</text>';

    weekly.forEach(function (d, i) {
      var cx = L + i * step + (step - bw) / 2;
      var ha = (d.adds / span) * ih, hd = (d.dels / span) * ih;
      var tipTxt = esc('Week of ' + fmtDate(d.t) + '<br><b>+' + num(d.adds) + '</b> added<br><b>&minus;' +
        num(d.dels) + '</b> deleted<br>net <b>' + (d.adds - d.dels >= 0 ? '+' : '') + num(d.adds - d.dels) + '</b>');
      if (ha > 0) s += '<rect x="' + cx + '" y="' + (zero - ha) + '" width="' + bw + '" height="' + ha +
        '" rx="' + Math.min(2, bw / 2) + '" fill="var(--adds)" tabindex="0" data-tip="' + tipTxt + '"/>';
      if (hd > 0) s += '<rect x="' + cx + '" y="' + zero + '" width="' + bw + '" height="' + hd +
        '" rx="' + Math.min(2, bw / 2) + '" fill="var(--dels)" tabindex="0" data-tip="' + tipTxt + '"/>';
    });

    s += '<line class="axis-line" x1="' + L + '" y1="' + zero + '" x2="' + (W - R) + '" y2="' + zero + '"/>';
    return s + '</svg>';
  }

  function heatmap(days) {
    var CELL = 12, GAP = 3, SP = CELL + GAP, LEFT = 30, TOP = 18;
    var today = new Date();
    var end = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
    var startWeek = weekStart(end) - 52 * WEEK;

    var counts = [];
    for (var w = 0; w < 53; w++) {
      for (var d = 0; d < 7; d++) {
        var ts = startWeek + w * WEEK + d * DAY;
        if (ts > end) continue;
        counts.push({ w: w, d: d, ts: ts, n: days[dayKey(ts)] || 0 });
      }
    }
    var nonZero = counts.filter(function (c) { return c.n > 0; }).map(function (c) { return c.n; })
      .sort(function (a, b) { return a - b; });
    if (!nonZero.length) return '<p class="empty-note">No commits in the last 12 months.</p>';
    var q = function (p) { return nonZero[Math.min(nonZero.length - 1, Math.floor(nonZero.length * p))]; };
    var b1 = q(0.25), b2 = q(0.5), b3 = q(0.85);

    var W = LEFT + 53 * SP + 6, H = TOP + 7 * SP + 6;
    var s = svgOpen(W, H);

    ['Mon', 'Wed', 'Fri'].forEach(function (lbl, k) {
      var row = [1, 3, 5][k];
      s += '<text class="tick" x="' + (LEFT - 6) + '" y="' + (TOP + row * SP + CELL - 2) +
        '" text-anchor="end">' + lbl + '</text>';
    });

    var lastMonth = -1;
    for (var wk = 0; wk < 53; wk++) {
      var mDate = new Date(startWeek + wk * WEEK);
      if (mDate.getUTCMonth() !== lastMonth && mDate.getUTCDate() <= 7) {
        lastMonth = mDate.getUTCMonth();
        s += '<text class="tick" x="' + (LEFT + wk * SP) + '" y="' + (TOP - 6) + '">' +
          mDate.toLocaleDateString('en-GB', { month: 'short' }) + '</text>';
      }
    }

    counts.forEach(function (c) {
      var level = c.n === 0 ? 0 : c.n <= b1 ? 1 : c.n <= b2 ? 2 : c.n <= b3 ? 3 : 4;
      s += '<rect class="heat-cell" x="' + (LEFT + c.w * SP) + '" y="' + (TOP + c.d * SP) +
        '" width="' + CELL + '" height="' + CELL + '" rx="2" fill="var(--q' + level + ')" tabindex="0" data-tip="' +
        esc('<b>' + num(c.n) + '</b> ' + plural(c.n, 'commit') + '<br>' + fmtDate(c.ts)) + '"/>';
    });
    return s + '</svg>';
  }

  function leaderboard(people) {
    if (!people.length) return '<p class="empty-note">No contributor data available.</p>';
    var top = people.slice(0, 8);
    var max = top[0].commits || 1;
    var medals = ['🥇', '🥈', '🥉'];
    return top.map(function (p, i) {
      var who = p.url
        ? '<a href="' + esc(p.url) + '" target="_blank" rel="noopener">' + esc(p.name) + '</a>'
        : '<span class="who">' + esc(p.name) + '</span>';
      var net = p.adds - p.dels;
      var detail = (p.adds || p.dels)
        ? 'Added ' + num(p.adds) + ', deleted ' + num(p.dels) + ' lines (net ' +
          (net >= 0 ? '+' : '') + num(net) + ')'
        : 'Line counts unavailable';
      return '<div class="lb-row">' +
        '<div class="lb-rank">' + (medals[i] || (i + 1)) + '</div>' +
        '<div>' +
          '<div class="lb-name">' + who + '<span class="lb-count">' + num(p.commits) + ' ' +
            plural(p.commits, 'commit') + '</span></div>' +
          '<div class="lb-track" tabindex="0" data-tip="' + esc('<b>' + esc(p.name) + '</b><br>' + detail) + '">' +
            '<span class="lb-fill" style="width:' + (p.commits / max * 100).toFixed(1) + '%"></span>' +
          '</div>' +
        '</div></div>';
    }).join('');
  }

  function languageBar(langs) {
    if (!langs.length) return { bar: '<p class="empty-note">No language data available.</p>', list: '' };
    var top = langs.slice(0, 5);
    var rest = langs.slice(5).reduce(function (a, l) { return a + l.pct; }, 0);
    if (rest > 0.5) top.push({ name: 'Other', pct: rest, other: true });

    var bar = '<div class="lang-bar">' + top.map(function (l, i) {
      var c = l.other ? 'var(--muted)' : 'var(--s' + (i + 1) + ')';
      return '<span style="width:' + l.pct.toFixed(2) + '%;background:' + c + '" tabindex="0" data-tip="' +
        esc('<b>' + esc(l.name) + '</b> — ' + l.pct.toFixed(1) + '%') + '"></span>';
    }).join('') + '</div>';

    var list = top.map(function (l, i) {
      var c = l.other ? 'var(--muted)' : 'var(--s' + (i + 1) + ')';
      return '<li><i class="swatch" style="background:' + c + '"></i>' + esc(l.name) +
        '<span class="pct">' + l.pct.toFixed(1) + '%</span></li>';
    }).join('');

    return { bar: bar, list: list };
  }

  /* ------------------------------------------------------------------ fun maths */
  function funFacts(m) {
    var lines = m.adds, out = [];
    var spanDays = Math.max(1, (m.repo.pushed - m.repo.created) / DAY);

    if (lines > 0) {
      var sheets = Math.ceil(lines / 50);
      var metres = sheets * 0.000105;
      var cmp = metres > 330 ? (metres / 330).toFixed(1) + '× the Eiffel Tower'
        : metres > 8.8 ? (metres / 8.8).toFixed(1) + ' giraffes stacked up'
        : metres > 1.7 ? (metres / 1.7).toFixed(1) + ' people lying end to end'
        : 'about ' + (metres * 100).toFixed(0) + ' cm';
      out.push(['📜', num(sheets) + ' sheets of A4',
        'Printed at 50 lines a page, the stack would be ' + metres.toFixed(metres < 10 ? 2 : 0) +
        ' m tall — ' + cmp + '.']);

      var hours = lines / 30 / 60;
      out.push(['⌨️', hours < 24 ? hours.toFixed(1) + ' hours of typing'
        : (hours / 24).toFixed(1) + ' days of typing',
        'At a relentless 30 lines a minute with no breaks, no meetings and no rethinking anything.']);

      out.push(['🚀', (lines / 145000).toFixed(lines / 145000 < 10 ? 2 : 0) + '× Apollo 11',
        'The Apollo 11 guidance computer ran on roughly 145,000 lines. You wrote ' +
        num(lines) + '.']);

      out.push(['📖', num(Math.round(lines / 4024)) + '× Hamlet',
        'Shakespeare needed 4,024 lines for the whole play. Admittedly his had fewer semicolons.']);
    }

    out.push(['☕', num(m.totalCommits) + ' cups of coffee',
      'One per commit, that is ' + (m.totalCommits * 0.25).toFixed(0) + ' litres — roughly ' +
      (m.totalCommits * 0.25 / 200).toFixed(2) + ' bathtubs.']);

    var hoursPer = spanDays * 24 / Math.max(1, m.totalCommits);
    out.push(['⏱️', hoursPer < 1 ? 'A commit every ' + Math.round(hoursPer * 60) + ' minutes'
      : hoursPer < 48 ? 'A commit every ' + hoursPer.toFixed(1) + ' hours'
      : 'A commit every ' + (hoursPer / 24).toFixed(1) + ' days',
      'Averaged across the ' + num(Math.round(spanDays)) + ' days this repo has existed.']);

    return out;
  }

  function rankFor(n) {
    if (n >= 50000) return ['🐉', 'Legendary monorepo'];
    if (n >= 10000) return ['🏛️', 'Institution'];
    if (n >= 5000) return ['🏭', 'Code factory'];
    if (n >= 1000) return ['🔥', 'Seriously shipping'];
    if (n >= 500) return ['🚀', 'Cruising altitude'];
    if (n >= 100) return ['🌱', 'Growing nicely'];
    if (n >= 20) return ['🐣', 'Just hatched'];
    return ['✨', 'Brand new'];
  }

  function awards(m) {
    var out = [];
    var top = m.people[0];
    if (top) out.push(['🏆', 'Commit champion',
      '<strong>' + esc(top.name) + '</strong> with ' + num(top.commits) + ' ' +
      plural(top.commits, 'commit') + '.']);

    var withLines = m.people.filter(function (p) { return p.adds || p.dels; });
    if (withLines.length) {
      var deleter = withLines.slice().sort(function (a, b) { return b.dels - a.dels; })[0];
      out.push(['🧹', 'Chief destroyer',
        '<strong>' + esc(deleter.name) + '</strong> removed ' + num(deleter.dels) + ' lines. ' +
        'The best code is the code you delete.']);
    }

    if (m.weekly.length) {
      var peak = m.weekly.slice().sort(function (a, b) { return b.commits - a.commits; })[0];
      out.push(['🔥', 'Busiest week',
        'Week of ' + fmtDate(peak.t) + ' — <strong>' + num(peak.commits) + '</strong> ' +
        plural(peak.commits, 'commit') + '. Something was due.']);

      var streak = 0, best = 0, prev = null;
      m.weekly.filter(function (w) { return w.commits > 0; }).forEach(function (w) {
        if (prev !== null && w.t - prev === WEEK) streak++; else streak = 1;
        if (streak > best) best = streak;
        prev = w.t;
      });
      out.push(['📅', 'Longest streak',
        '<strong>' + best + '</strong> consecutive ' + plural(best, 'week') + ' with at least one commit.']);
    }

    var dow = [0, 0, 0, 0, 0, 0, 0];
    Object.keys(m.days).forEach(function (k) {
      dow[new Date(k + 'T00:00:00Z').getUTCDay()] += m.days[k];
    });
    if (dow.some(Boolean)) {
      var names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      var bi = dow.indexOf(Math.max.apply(null, dow));
      var weekendShare = (dow[0] + dow[6]) / dow.reduce(function (a, b) { return a + b; }, 0) * 100;
      out.push(['🗓️', 'Favourite day',
        '<strong>' + names[bi] + '</strong>. ' + weekendShare.toFixed(0) +
        '% of the last year’s commits landed at the weekend.']);
    }
    return out;
  }

  /* ------------------------------------------------------------------ gauge */
  // The next round number above n — the thing the team is pushing towards.
  function nextMilestone(n) {
    if (n < 10) return 10;
    var mag = Math.pow(10, Math.floor(Math.log10(n)));
    var steps = [1, 2, 2.5, 5, 10];
    for (var i = 0; i < steps.length; i++) {
      var t = steps[i] * mag;
      if (t > n) return Math.round(t);
    }
    return Math.round(10 * mag);
  }

  var GA = { cx: 310, cy: 300, R: 232, SW: 26 };

  function gaugePoint(f, r) {
    var a = Math.PI * (1 - f);
    return [GA.cx + r * Math.cos(a), GA.cy - r * Math.sin(a)];
  }
  function gaugeArcPath(f, r) {
    f = Math.max(0, Math.min(1, f));
    var p0 = gaugePoint(0, r), p1 = gaugePoint(f, r);
    if (f <= 0.0005) return 'M' + p0[0] + ',' + p0[1];
    // The sweep is f * 180°, so it never exceeds a half turn: large-arc is always 0.
    return 'M' + p0[0] + ',' + p0[1] + ' A' + r + ',' + r + ' 0 0 1 ' + p1[0] + ',' + p1[1];
  }

  function buildGauge(target) {
    var R = GA.R, cx = GA.cx, cy = GA.cy;
    var s = '<svg viewBox="0 0 620 350" preserveAspectRatio="xMidYMid meet" role="img" ' +
      'aria-label="Commit gauge" id="gaugeSvg">';

    s += '<path class="gauge-track" stroke-width="' + GA.SW + '" d="' + gaugeArcPath(1, R) + '"/>';
    s += '<path class="gauge-fill" id="gaugeArc" stroke-width="' + GA.SW + '" d="' + gaugeArcPath(0, R) + '"/>';

    // scale ticks
    for (var i = 0; i <= 5; i++) {
      var f = i / 5;
      var a = gaugePoint(f, R - GA.SW / 2 - 6), b = gaugePoint(f, R - GA.SW / 2 - 18);
      s += '<line class="gauge-tick-mark" x1="' + a[0] + '" y1="' + a[1] + '" x2="' + b[0] + '" y2="' + b[1] + '"/>';
      var lp = gaugePoint(f, R - GA.SW / 2 - 40);
      s += '<text class="gauge-tick" x="' + lp[0] + '" y="' + (lp[1] + 5) + '">' + compact(target * f) + '</text>';
    }

    // the goal marker sits at the top of the scale
    var gp = gaugePoint(1, R + GA.SW / 2 + 14);
    s += '<circle class="gauge-goal" cx="' + gp[0] + '" cy="' + gp[1] + '" r="5"/>';
    s += '<text class="gauge-goal-text" x="' + (gp[0] - 4) + '" y="' + (gp[1] + 26) + '">GOAL</text>';

    s += '<text class="gauge-value" id="gaugeValue" x="' + cx + '" y="' + (cy - 78) + '" font-size="86">0</text>';
    s += '<text class="gauge-unit" id="gaugeUnit" x="' + cx + '" y="' + (cy - 38) + '" font-size="17">COMMITS</text>';

    s += '<g id="gaugeNeedle" transform="rotate(0,' + cx + ',' + cy + ')">' +
      '<line class="gauge-needle" x1="' + (cx + 30) + '" y1="' + cy + '" x2="' + (cx - (R - 46)) + '" y2="' + cy + '"/>' +
      '</g>';
    s += '<circle class="gauge-hub" cx="' + cx + '" cy="' + cy + '" r="11"/>';

    return s + '</svg>';
  }

  /* ------------------------------------------------------------------ render */
  var lastModel = null, odoTimer = null, shownValue = 0;

  function paintGauge(value, target) {
    var arc = $('gaugeArc'), needle = $('gaugeNeedle'), txt = $('gaugeValue');
    if (!arc) return;
    var f = Math.max(0, Math.min(1, value / target));
    arc.setAttribute('d', gaugeArcPath(f, GA.R));
    needle.setAttribute('transform', 'rotate(' + (f * 180) + ',' + GA.cx + ',' + GA.cy + ')');
    txt.textContent = num(value);
    // keep the headline number inside the dial at any magnitude
    txt.setAttribute('font-size', String(num(value).length > 8 ? 58 : num(value).length > 6 ? 70 : 86));
  }

  function animateGauge(from, to, target) {
    if (odoTimer) cancelAnimationFrame(odoTimer);
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      paintGauge(to, target); shownValue = to; return;
    }
    var start = performance.now(), dur = 1400;
    (function step(now) {
      var p = Math.min(1, (now - start) / dur);
      var eased = 1 - Math.pow(1 - p, 3);
      var v = Math.round(from + (to - from) * eased);
      paintGauge(v, target);
      shownValue = v;
      if (p < 1) odoTimer = requestAnimationFrame(step);
    })(start);
  }

  function render(m) {
    lastModel = m;
    m.weekly = densifyWeekly(m.weekly);
    $('status').hidden = true;
    $('dashboard').hidden = false;

    var r = m.repo;
    var avatar = $('ownerAvatar');
    if (r.avatar) { avatar.src = r.avatar; avatar.hidden = false; } else { avatar.hidden = true; }

    var nameEl = $('repoName');
    nameEl.textContent = r.name;
    if (r.url) { nameEl.href = r.url; nameEl.removeAttribute('aria-disabled'); }
    else { nameEl.removeAttribute('href'); }
    $('repoDesc').textContent = r.desc || '';

    $('odometerLabel').textContent = 'Total commits' + (r.branch ? ' on ' + r.branch : '');

    var target = nextMilestone(m.totalCommits);
    var rebuild = !$('gaugeSvg') || String(target) !== $('gauge').getAttribute('data-target');
    if (rebuild) {
      $('gauge').innerHTML = buildGauge(target);
      $('gauge').setAttribute('data-target', String(target));
      shownValue = 0;
    }
    $('gaugeSvg').setAttribute('aria-label',
      num(m.totalCommits) + ' commits, ' + num(target) + ' is the next milestone');
    animateGauge(shownValue, m.totalCommits, target);

    var togo = target - m.totalCommits;
    $('milestoneLine').innerHTML = togo > 0
      ? '🎯 <strong>' + num(togo) + '</strong> more ' + plural(togo, 'commit') +
        ' to reach <strong>' + num(target) + '</strong>'
      : '🎉 <strong>' + num(target) + '</strong> smashed — next stop <strong>' +
        num(nextMilestone(target)) + '</strong>';

    // "Watch it climb" only makes sense when there is something to re-poll
    var liveable = m.source !== 'git log' && !!session.input;
    $('gaugeActions').hidden = !liveable;
    if (!liveable) stopLive();

    if (session.baseline == null) session.baseline = m.totalCommits;
    var gained = m.totalCommits - session.baseline;
    $('sinceLine').textContent = gained > 0
      ? '+' + num(gained) + ' since you opened this' : '';

    var rank = rankFor(m.totalCommits);
    $('rankLine').innerHTML = rank[0] + ' <strong>' + esc(rank[1]) + '</strong> — ' + esc(m.sourceNote);

    var spanDays = Math.max(1, Math.round((r.pushed - r.created) / DAY));
    var facts = [
      ['Source', m.source],
      ['First commit', isFinite(r.created) ? fmtDate(r.created) : '—'],
      ['Last activity', isFinite(r.pushed) ? fmtDate(r.pushed) : '—'],
      ['Age', num(spanDays) + ' days'],
      ['Contributors', num(m.people.length)]
    ];
    if (r.stars != null) facts.push(['Stars', num(r.stars)]);
    $('miniFacts').innerHTML = facts.map(function (f) {
      return '<div><dt>' + esc(f[0]) + '</dt><dd>' + esc(f[1]) + '</dd></div>';
    }).join('');

    var net = m.adds - m.dels;
    var perDay = m.totalCommits / spanDays;
    var noLines = 'Not reported for this repository';
    var hasLines = m.adds > 0 || m.dels > 0;
    var tiles = [
      ['Lines added', hasLines ? compact(m.adds) : '—', hasLines ? 'pos' : '',
        hasLines ? num(m.adds) + ' in total' : noLines],
      ['Lines deleted', hasLines ? compact(m.dels) : '—', hasLines ? 'neg' : '',
        hasLines ? num(m.dels) + ' in total' : noLines],
      ['Net lines shipped', hasLines ? (net >= 0 ? '+' : '−') + compact(Math.abs(net)) : '—', '',
        hasLines ? 'What actually survives today' : noLines],
      ['Commits per day', perDay.toFixed(perDay < 1 ? 2 : 1), '', 'Averaged over the repo’s whole life'],
      ['Lines per commit', hasLines && m.totalCommits ? num((m.adds + m.dels) / m.totalCommits) : '—', '',
        hasLines ? 'Added plus deleted, per commit' : noLines],
      ['People involved', num(m.people.length), '', 'Distinct commit authors']
    ];
    $('tiles').innerHTML = tiles.map(function (t) {
      return '<div class="tile"><div class="tile-label">' + esc(t[0]) + '</div>' +
        '<div class="tile-value ' + t[2] + '">' + esc(t[1]) + '</div>' +
        '<div class="tile-note">' + esc(t[3]) + '</div></div>';
    }).join('');

    $('funGrid').innerHTML = funFacts(m).map(function (f) {
      return '<div class="fun"><div class="fun-emoji">' + f[0] + '</div><div>' +
        '<div class="fun-big">' + esc(f[1]) + '</div>' +
        '<div class="fun-text">' + esc(f[2]) + '</div></div></div>';
    }).join('');

    $('timelineSub').textContent = m.weekly.length
      ? m.weekly.length + ' weeks of history, from ' + fmtDate(m.weekly[0].t) + ' to today.' : '';
    $('timelineChart').innerHTML = timelineChart(m.weekly);
    $('churnChart').innerHTML = churnChart(m.weekly);
    $('heatmap').innerHTML = heatmap(m.days);

    $('contribSub').textContent = m.people.length > 8
      ? 'Top 8 of ' + num(m.people.length) + ' contributors.'
      : num(m.people.length) + ' ' + plural(m.people.length, 'contributor') + ' in total.';
    $('leaderboard').innerHTML = leaderboard(m.people);

    var lang = languageBar(m.languages);
    $('langSub').textContent = m.langNote;
    $('langBar').innerHTML = lang.bar;
    $('langList').innerHTML = lang.list;

    $('awards').innerHTML = awards(m).map(function (a) {
      return '<div class="award"><div class="award-emoji">' + a[0] + '</div><div>' +
        '<div class="award-title">' + esc(a[1]) + '</div>' +
        '<div class="award-body">' + a[2] + '</div></div></div>';
    }).join('');

    $('dataTable').innerHTML = buildTable(m);

    var share = location.origin + location.pathname + (m.query ? '?repo=' + encodeURIComponent(m.query) : '');
    var link = $('shareLink');
    link.href = share; link.textContent = share;
    $('shareLink').parentNode.hidden = !m.query;

    bindTips($('dashboard'));
  }

  function buildTable(m) {
    var rows = m.weekly.slice().reverse().slice(0, 200);
    var t = '<table><caption class="sr-only">Weekly commit and line counts</caption><thead><tr>' +
      '<th>Week starting</th><th>Commits</th><th>Lines added</th><th>Lines deleted</th><th>Net</th>' +
      '</tr></thead><tbody>';
    rows.forEach(function (w) {
      t += '<tr><td>' + fmtDate(w.t) + '</td><td>' + num(w.commits) + '</td><td>' + num(w.adds) +
        '</td><td>' + num(w.dels) + '</td><td>' + (w.adds - w.dels >= 0 ? '+' : '') +
        num(w.adds - w.dels) + '</td></tr>';
    });
    t += '</tbody></table>';
    if (m.weekly.length > 200) t += '<p class="fine">Showing the most recent 200 weeks.</p>';
    return t;
  }

  /* ------------------------------------------------------------------ status */
  function setBusy(msg) {
    var s = $('status');
    s.className = 'status';
    s.hidden = false;
    s.innerHTML = '<span class="spin"></span>' + esc(msg);
  }

  function setError(title, bullets) {
    var s = $('status');
    s.className = 'status error';
    s.hidden = false;
    s.innerHTML = '<h3>' + esc(title) + '</h3>' +
      (bullets && bullets.length ? '<ul><li>' + bullets.join('</li><li>') + '</li></ul>' : '');
  }

  function explainFailure(err, t) {
    var host = (t && t.host) || err.host || 'the server';
    if (err.status === 404) {
      return setError('That repository was not found on ' + host + '.', [
        'Check the path — it is case-sensitive.',
        'If the project is private, add an access token below and try again.'
      ]);
    }
    if (err.status === 401 || err.status === 403) {
      var bullets = ['The token may be missing, expired, or lack the required scope ' +
        '(<code>read_api</code> for GitLab).'];
      if (host === 'github.com') bullets.push('GitHub allows 60 anonymous calls per hour — a token lifts that to 5,000.');
      return setError('Access denied by ' + host + ' (HTTP ' + err.status + ').', bullets);
    }
    if (err.status) {
      return setError(host + ' answered with HTTP ' + err.status + '.', [
        'This is usually temporary. Try again in a moment.'
      ]);
    }
    // TypeError from fetch — network, DNS, or CORS
    return setError('Could not reach ' + host + ' from your browser.', [
      'If it is an internal server, make sure you are on the VPN.',
      'Corporate GitLab servers often block cross-origin requests from other sites. ' +
        'That is exactly what <strong>offline mode</strong> below is for — it needs no network access at all.',
      'The browser console will show the precise reason.'
    ]);
  }

  /* ------------------------------------------------------------------ run */
  var session = { input: null, target: null, baseline: null, timer: null };
  var LIVE_INTERVAL = 90000;

  function stopLive() {
    if (session.timer) { clearInterval(session.timer); session.timer = null; }
    if ($('liveToggle')) $('liveToggle').checked = false;
  }

  // A quiet re-fetch: same repo, no spinner, no scroll — just nudge the needle.
  function refresh(silent) {
    if (!session.target) return;
    var btn = $('refreshBtn');
    btn.disabled = true;
    btn.textContent = 'Checking…';
    var loader = session.target.kind === 'github' ? loadGitHub : loadGitLab;
    loader(session.target, function () { /* stay quiet during a refresh */ })
      .then(function (m) {
        m.query = session.input;
        render(m);
      })
      .catch(function (err) {
        console.error(err);
        if (!silent) explainFailure(err, session.target);
        else stopLive();               // a failing poll should not nag forever
      })
      .then(function () {
        btn.disabled = false;
        btn.textContent = 'Refresh now';
      });
  }

  $('refreshBtn').addEventListener('click', function () { refresh(false); });
  $('liveToggle').addEventListener('change', function () {
    if (this.checked) {
      session.timer = setInterval(function () { refresh(true); }, LIVE_INTERVAL);
    } else {
      stopLive();
    }
  });

  function run(input, pushUrl) {
    var t = parseTarget(input);
    if (!t) {
      return setError('That does not look like a repository.', [
        'Use a full URL such as <code>https://gitlab.nortal.com/group/project</code>,',
        'or the short form <code>owner/repo</code> for GitHub.'
      ]);
    }
    $('dashboard').hidden = true;
    setBusy('Warming up the odometer…');

    stopLive();                                  // a new repo starts a new count
    session.input = input;
    session.target = t;
    session.baseline = null;
    shownValue = 0;

    if (pushUrl) {
      var url = location.pathname + '?repo=' + encodeURIComponent(input);
      history.replaceState(null, '', url);
    }

    var loader = t.kind === 'github' ? loadGitHub : loadGitLab;
    loader(t, setBusy).then(function (m) {
      m.query = input;
      render(m);
      $('dashboard').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }).catch(function (err) {
      console.error(err);
      explainFailure(err, t);
    });
  }

  $('repoForm').addEventListener('submit', function (ev) {
    ev.preventDefault();
    run($('repoInput').value, true);
  });

  document.querySelectorAll('.chip').forEach(function (b) {
    b.addEventListener('click', function () {
      $('repoInput').value = b.getAttribute('data-repo');
      run(b.getAttribute('data-repo'), true);
    });
  });

  /* offline paste mode */
  $('cmdBox').textContent = GIT_CMD;
  $('copyCmd').addEventListener('click', function () {
    var btn = $('copyCmd');
    navigator.clipboard.writeText(GIT_CMD).then(function () {
      btn.textContent = 'Copied';
      setTimeout(function () { btn.textContent = 'Copy command'; }, 1600);
    }).catch(function () { btn.textContent = 'Press Ctrl+C to copy'; });
  });
  $('pasteRun').addEventListener('click', function () {
    try {
      var m = parseGitLog($('pasteInput').value);
      history.replaceState(null, '', location.pathname);
      stopLive();
      session.input = null; session.target = null; session.baseline = null;
      shownValue = 0;
      render(m);
      $('dashboard').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) {
      setError('Could not read that git log.', [esc(e.message)]);
    }
  });

  /* deep link: ?repo=… */
  var qs = new URLSearchParams(location.search).get('repo');
  if (qs) { $('repoInput').value = qs; run(qs, false); }
})();
