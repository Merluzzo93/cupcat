// Has anything CupCat depends on moved?
//
//   bun run tools/upstream/check.ts            → report what changed since the last check
//   bun run tools/upstream/check.ts --save     → and record where things stand now
//   bun run tools/upstream/check.ts --all      → list every source, not only what moved
//
// Two questions, kept apart on purpose:
//   1. What does upstream say is current?  (GitHub releases/tags)
//   2. What do we actually SHIP?            (the binary in sidecars/, asked directly)
// The gap between those two is the thing worth knowing, and the second question is the one people
// skip — a version somebody wrote in a README is not evidence of what is inside the installer.
//
// State lives in tools/upstream/state.json and is committed, so "what changed" is a git diff and a
// check that finds nothing new prints nothing new.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { SOURCES, type Source } from "./sources";

const repoRoot = resolve(import.meta.dir, "..", "..");
const sidecars = join(repoRoot, "apps", "desktop", "src-tauri", "sidecars");
const statePath = join(import.meta.dir, "state.json");
const reportPath = join(import.meta.dir, "UPSTREAM.md");

const save = process.argv.includes("--save");
const showAll = process.argv.includes("--all");

interface Known {
  latest: string | null;
  shipped: string | null;
  checked: string;
}
type State = Record<string, Known>;

const state: State = existsSync(statePath) ? (JSON.parse(readFileSync(statePath, "utf8")) as State) : {};

/** GitHub's idea of "newest", preferring a release and falling back to a tag. */
async function upstreamVersion(s: Source): Promise<string | null> {
  if (!s.repo) return null;
  const headers: Record<string, string> = { accept: "application/vnd.github+json", "user-agent": "CupCat-Upstream" };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const get = async (path: string) => {
    try {
      const r = await fetch(`https://api.github.com/repos/${s.repo}${path}`, { headers, signal: AbortSignal.timeout(15_000) });
      return r.ok ? await r.json() : null;
    } catch {
      return null;
    }
  };
  if (!s.useTags) {
    const rel = (await get("/releases/latest")) as { tag_name?: string; published_at?: string } | null;
    // A rolling release keeps one tag forever, so the tag can never tell you anything moved. Its
    // publish date can.
    if (s.datedRelease && rel?.published_at) return rel.published_at.slice(0, 10);
    if (rel?.tag_name) return rel.tag_name;
  }
  const tags = (await get("/tags?per_page=1")) as { name?: string }[] | null;
  if (tags?.[0]?.name) return tags[0].name;
  // Plenty of active projects never tag anything. For those the newest commit is the only signal
  // there is, and reporting "unreachable" for a repo that is simply untagged would be a lie.
  const commits = (await get("/commits?per_page=1")) as { sha?: string; commit?: { committer?: { date?: string } } }[] | null;
  const c = commits?.[0];
  if (c?.sha) return `${c.commit?.committer?.date?.slice(0, 10) ?? "commit"} @${c.sha.slice(0, 7)}`;
  return null;
}

/** What we actually ship, asked of the binary itself. */
function shippedVersion(s: Source): string | null {
  if (!s.probe) return null;
  const bin = join(sidecars, ...s.probe.bin.split("/"));
  if (!existsSync(bin)) return null;
  try {
    const r = Bun.spawnSync([bin, ...s.probe.args]);
    const out = r.stdout.toString() + r.stderr.toString();
    return s.probe.extract.exec(out)?.[1] ?? null;
  } catch {
    return null;
  }
}

const today = new Date().toISOString().slice(0, 10);
const rows: { s: Source; latest: string | null; shipped: string | null; moved: boolean; wasLatest: string | null }[] = [];

for (const s of SOURCES) {
  const latest = await upstreamVersion(s);
  const shipped = shippedVersion(s);
  const prev = state[s.id];
  const moved = !!latest && !!prev?.latest && latest !== prev.latest;
  rows.push({ s, latest, shipped, moved, wasLatest: prev?.latest ?? null });
  // A failed lookup must not erase what we knew. GitHub allows 60 anonymous requests an hour, so a
  // run that trips the limit would otherwise wipe the baseline and report everything as new next
  // time — noise that trains you to ignore the report, which is worse than no report.
  if (save) state[s.id] = { latest: latest ?? prev?.latest ?? null, shipped: shipped ?? prev?.shipped ?? null, checked: latest ? today : (prev?.checked ?? today) };
}

const unreachable = rows.filter((r) => r.s.repo && !r.latest);
const movedRows = rows.filter((r) => r.moved);
const firstSeen = rows.filter((r) => r.latest && !r.wasLatest);

// ── report ────────────────────────────────────────────────────────────────────────────────
const lines: string[] = [];
lines.push(`# Upstream — checked ${today}`, "");

if (movedRows.length === 0 && firstSeen.length === 0) {
  lines.push("Nothing CupCat watches has moved since the last check.", "");
} else {
  if (movedRows.length) {
    lines.push("## Moved since the last check", "");
    for (const r of movedRows) {
      lines.push(`### ${r.s.id} — \`${r.wasLatest}\` → \`${r.latest}\``);
      lines.push(`*${r.s.role}*`);
      lines.push(`**Why it matters:** ${r.s.watchFor}`);
      if (r.shipped) lines.push(`CupCat ships \`${r.shipped}\`.`);
      lines.push(`https://github.com/${r.s.repo}/releases`, "");
    }
  }
  if (firstSeen.length) {
    lines.push("## Seen for the first time", "");
    for (const r of firstSeen) lines.push(`- **${r.s.id}** \`${r.latest}\` — ${r.s.role}`);
    lines.push("");
  }
}

if (showAll || movedRows.length || firstSeen.length) {
  lines.push("## Everything watched", "");
  lines.push("| source | kind | upstream | CupCat ships |", "|---|---|---|---|");
  for (const r of rows) {
    lines.push(`| ${r.s.id} | ${r.s.kind} | ${r.latest ?? "—"} | ${r.shipped ?? "—"} |`);
  }
  lines.push("");
}

if (unreachable.length) {
  lines.push("## Could not be reached", "");
  lines.push(
    "Unauthenticated GitHub allows 60 requests an hour; set GITHUB_TOKEN to raise that. A source here is not a source that has not moved.",
    "",
  );
  for (const r of unreachable) lines.push(`- ${r.s.id} (${r.s.repo})`);
  lines.push("");
}

const report = lines.join("\n");
writeFileSync(reportPath, report);
if (save) writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");

console.log(report);
console.log(`written to ${reportPath}${save ? " · state recorded" : " · run with --save to record this as the new baseline"}`);
// Exit 1 when something moved, so a scheduled run can tell "news" from "quiet" without parsing.
process.exit(movedRows.length ? 1 : 0);
