// In-app update check against GitHub Releases. Fetches the latest release of GITHUB_REPO, compares
// its tag with the running build, and reports the installer download URL when a newer one exists.
// While the repo is private the GitHub API returns 404/403 for anonymous requests, so the check
// simply reports "no update" — it starts working automatically once the repo (or its releases) go
// public. Best-effort throughout: a network failure never surfaces an error to the user.

import { CUPCAT_VERSION, GITHUB_API, GITHUB_REPO } from "./config";
import { fetchManifest, planUpdate, type UpdatePlan } from "./delta";

/** What updating in place would cost, when it is possible at all. Null means the full installer is
 * the only route — an unpackaged or read-only install, a release with no manifest, or simply being
 * offline. The download button never goes away, so null is never a dead end. */
export interface DeltaInfo {
  files: number;
  bytes: number;
  /** What the same update weighs as a full installer, which is the comparison worth showing. */
  fullBytes: number;
}

export interface UpdateInfo {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  downloadUrl: string | null; // the -setup.exe asset when present, else the release page
  releaseUrl: string | null;
  notes: string | null;
  delta: DeltaInfo | null;
}

const NO_UPDATE: UpdateInfo = { current: CUPCAT_VERSION, latest: null, updateAvailable: false, downloadUrl: null, releaseUrl: null, notes: null, delta: null };

/** The plan behind the most recent check, so installing does not have to work it out again. */
let plan: UpdatePlan | null = null;

/** The plan for the version the last check found, if updating in place is possible. */
export function pendingPlan(): UpdatePlan | null {
  return plan;
}

/** Parse "v1.7.2" / "1.7.2" → [1,7,2]; non-numeric parts become 0. */
function parseVersion(v: string): number[] {
  return v.replace(/^v/i, "").split(".").map((p) => Number.parseInt(p, 10) || 0);
}

/** Is `a` strictly newer than `b`? Compares numeric components left to right. */
function isNewer(a: string, b: string): boolean {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da > db;
  }
  return false;
}

interface GitHubRelease {
  tag_name?: string;
  name?: string;
  html_url?: string;
  body?: string;
  draft?: boolean;
  prerelease?: boolean;
  assets?: { name?: string; browser_download_url?: string }[];
}

/** Check GitHub for a newer release. Never throws — returns NO_UPDATE on any problem. */
export async function checkForUpdate(): Promise<UpdateInfo> {
  try {
    const res = await fetch(`${GITHUB_API}/repos/${GITHUB_REPO}/releases/latest`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "CupCat-Updater" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return NO_UPDATE; // 404/403 while private, etc.
    const rel = (await res.json()) as GitHubRelease;
    const tag = rel.tag_name?.trim();
    if (!tag || rel.draft) return NO_UPDATE;

    const setup = rel.assets?.find((a) => /setup\.exe$/i.test(a.name ?? "") && a.browser_download_url);
    const downloadUrl = setup?.browser_download_url ?? rel.html_url ?? null;

    // The version comes from the manifest, not from the tag.
    //
    // A release is a container of files, and a small fix does not need one of its own: replacing the
    // manifest and the two changed binaries inside the release that is already there publishes it to
    // everyone running CupCat, while the page — and the installer on it — stay put. Reading the tag
    // instead would make that invisible, because the tag is exactly what does not change. Releases
    // are then for the updates that deserve a page, not for every fix.
    //
    // Falls back to the tag for releases published before manifests existed.
    const manifest = await fetchManifest(tag);
    const latest = (manifest?.version ?? tag).replace(/^v/i, "");
    const updateAvailable = isNewer(latest, CUPCAT_VERSION);

    // Work out whether this one can be installed in place, downloading only what differs. Best-effort
    // like the rest of the check: if it cannot be worked out, the installer link stands on its own.
    plan = null;
    if (updateAvailable && manifest) {
      try {
        const p = await planUpdate(manifest, tag);
        if (p && p.files.length > 0) plan = p;
      } catch {
        /* fall back to the full installer */
      }
    }

    return {
      current: CUPCAT_VERSION,
      latest,
      updateAvailable,
      downloadUrl: updateAvailable ? downloadUrl : null,
      releaseUrl: rel.html_url ?? null,
      notes: updateAvailable ? (rel.body?.slice(0, 600) ?? null) : null,
      delta: plan ? { files: plan.files.length, bytes: plan.bytes, fullBytes: plan.fullBytes } : null,
    };
  } catch {
    return NO_UPDATE;
  }
}
