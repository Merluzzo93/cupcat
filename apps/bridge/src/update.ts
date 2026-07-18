// In-app update check against GitHub Releases. Fetches the latest release of GITHUB_REPO, compares
// its tag with the running build, and reports the installer download URL when a newer one exists.
// While the repo is private the GitHub API returns 404/403 for anonymous requests, so the check
// simply reports "no update" — it starts working automatically once the repo (or its releases) go
// public. Best-effort throughout: a network failure never surfaces an error to the user.

import { CUPCAT_VERSION, GITHUB_REPO } from "./config";

export interface UpdateInfo {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  downloadUrl: string | null; // the -setup.exe asset when present, else the release page
  releaseUrl: string | null;
  notes: string | null;
}

const NO_UPDATE: UpdateInfo = { current: CUPCAT_VERSION, latest: null, updateAvailable: false, downloadUrl: null, releaseUrl: null, notes: null };

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
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "CupCat-Updater" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return NO_UPDATE; // 404/403 while private, etc.
    const rel = (await res.json()) as GitHubRelease;
    const tag = rel.tag_name?.trim();
    if (!tag || rel.draft) return NO_UPDATE;

    const setup = rel.assets?.find((a) => /setup\.exe$/i.test(a.name ?? "") && a.browser_download_url);
    const downloadUrl = setup?.browser_download_url ?? rel.html_url ?? null;
    const updateAvailable = isNewer(tag, CUPCAT_VERSION);
    return {
      current: CUPCAT_VERSION,
      latest: tag.replace(/^v/i, ""),
      updateAvailable,
      downloadUrl: updateAvailable ? downloadUrl : null,
      releaseUrl: rel.html_url ?? null,
      notes: updateAvailable ? (rel.body?.slice(0, 600) ?? null) : null,
    };
  } catch {
    return NO_UPDATE;
  }
}
