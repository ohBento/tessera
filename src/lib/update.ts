import { getVersion, isDesktop } from "./platform";

const REPO = "ohBento/tessera";

export const releasePage = `https://github.com/${REPO}/releases/latest`;

/** Numeric field-by-field compare. Missing fields count as 0, so 1.2 < 1.2.1. */
export function isNewer(candidate: string, current: string): boolean {
  const parse = (v: string) => v.replace(/^v/, "").split(/[.\-+]/).map(Number);
  const a = parse(candidate);
  const b = parse(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}

/** Returns the newer tag, or "" for up to date, no releases yet, or no network.
 *  Reaches GitHub directly — the API sends CORS headers, so no plugin and no
 *  server of our own is involved. */
export async function latestRelease(): Promise<string> {
  /* Only from the shipped application. A browser build has no version to
     compare — getVersion answers "0.0.0-browser", which every tag beats — so
     without this the dev server and every mounted test would report an update
     and reach across the network to do it. A suite that asks GitHub is a suite
     that fails on a train. */
  if (!isDesktop) return "";
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`);
    if (!res.ok) return "";
    const tag = String(((await res.json()) as { tag_name?: string }).tag_name ?? "");
    return tag && isNewer(tag, await getVersion()) ? tag : "";
  } catch {
    return "";
  }
}
