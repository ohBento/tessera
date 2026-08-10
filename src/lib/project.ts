/* Every host call goes through platform.ts, which picks the Tauri plugins in
 * the app and an in-memory filesystem in a plain browser — that is what lets
 * the whole UI run and be tested without a native shell. */
import {
  copyFile,
  documentDir,
  exists,
  join,
  mkdir,
  readDir,
  readFile,
  readTextFile,
  remove,
  rename,
  writeFile,
  writeTextFile,
} from "./platform";

import { droppedWork, emptyManifest, migrate, pruneToFolder, type Manifest } from "./model";
import type { SceneDeps } from "./scene";

export async function defaultDir() {
  return join(await documentDir(), "Black Desert", "FaceTexture");
}

/** Everything Tessera owns lives beside the folder it edits, never inside it. */
const projectDir = (dir: string) => join(dir, "..", "FaceTexture.tessera");
const manifestPath = async (dir: string) => join(await projectDir(dir), "manifest.json");
const assetsDir = async (dir: string) => join(await projectDir(dir), "assets");
const vaultDir = async (dir: string) => join(await projectDir(dir), "vault");

export async function listTiles(dir: string) {
  const entries = await readDir(dir);
  return entries
    .filter((e) => e.isFile && e.name.toLowerCase().endsWith(".bmp"))
    .map((e) => e.name.replace(/\.bmp$/i, ""))
    .sort();
}

export const tilePath = (dir: string, id: string) => join(dir, `${id}.bmp`);

/** "YYYY-MM-DD hh:mm", or with seconds at 19 — on the clock in the room.
 *
 *  A snapshot is named after the moment it was taken, and `toISOString` names
 *  it in UTC: a wall put aside at six in the evening in Berlin was filed as
 *  four, and the two most recent snapshots read as older than they were. The
 *  offset is subtracted before formatting rather than the parts assembled by
 *  hand, which keeps the padding and the leap rules with the Date. */
export function localStamp(len: 16 | 19 = 16) {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, len)
    .replace("T", " ");
}

/** The document lined up with the folder, plus what that cost.
 *
 *  `lost` are the ids the folder no longer has that still carried work, and
 *  `snapshot` is the name the un-pruned document was put aside under — empty
 *  when nothing was lost, which is every ordinary open. The snapshot is written
 *  here rather than by the caller because this is the only place that holds the
 *  document as it was before the folder's verdict is applied, and a caller that
 *  forgets it turns the prune back into the silent deletion it used to be.
 *
 *  Putting the portraits back into the folder and reopening makes the snapshot
 *  restorable: restoreSnapshot prunes to the folder too, so the work comes back
 *  with the ids it belongs to.
 *
 *  `broken` is the name an unreadable manifest was moved aside under — see
 *  below for why that is not the same as having no manifest at all. */
export async function loadManifest(
  dir: string,
  ids: string[],
): Promise<{ manifest: Manifest; lost: string[]; snapshot: string; broken: string }> {
  let m = emptyManifest();
  let broken = "";
  let text = "";
  try {
    text = await readTextFile(await manifestPath(dir));
  } catch {
    // No project here yet. The ordinary first open, and the only case that
    // should silently produce an empty document.
  }
  if (text) {
    try {
      m = migrate(JSON.parse(text));
    } catch {
      /* A file that is there but will not parse used to share the catch above,
       * so a damaged document was indistinguishable from a first run: the app
       * opened empty and the first edit wrote over the only copy. Moved aside
       * instead — the fresh start then cannot eat it, and what is left is a
       * file a text editor can still be pointed at.
       *
       * Seconds in the name for the same reason the folder-cleanup snapshot
       * carries them: two opens inside a minute are a double-click apart.
       *
       * Not caught: if the move fails the folder does not open, and that is
       * the right way round. Starting clean over a manifest we could neither
       * read nor set aside is the one outcome this whole path exists to
       * prevent. */
      broken = `manifest.unreadable ${localStamp(19)}.json`;
      await rename(await manifestPath(dir), await join(await projectDir(dir), broken));
    }
  }
  const lost = droppedWork(m, ids);
  let snapshot = "";
  if (lost.length) {
    // Seconds in the name, unlike the one before a write to the game: two opens
    // inside the same minute are a double-click away, and the second one would
    // otherwise overwrite the first — which holds strictly more work.
    snapshot = `Before folder cleanup ${localStamp(19)}`;
    await writeSnapshot(
      dir,
      { name: snapshot, projectId: "" },
      { manifest: m, prints: await loadFingerprints(dir) },
    );
  }
  // Characters get created and deleted between sessions; the folder wins.
  return { manifest: pruneToFolder(m, ids), lost, snapshot, broken };
}

/* --- Knowing when the game changed a file under us.
 *
 * BDO keeps a character's numeric id when a slot is deleted and refilled, so
 * the id says nothing about whether the face behind it is still the same
 * person. The only signal is the bytes. Two hashes per tile answer it: what the
 * game shipped, and what Tessera last wrote — a file matching neither is one
 * the game rewrote, and only the user can say whether that was a restyle or a
 * stranger.
 *
 * Kept beside applied.json rather than in the manifest, for the same reason:
 * undo must never rewrite what is true about the disk.
 *
 * ponytail: every file is hashed on open — 44 portraits is about 90 MB and
 * milliseconds. readDir in Tauri 2 carries no size or mtime, so skipping
 * unchanged files would mean a new stat path, its permission and its mock. Add
 * that when a real folder proves slow. --- */

export type Print = { original: string; written?: string };
export type Fingerprints = Record<string, Print>;

const printsPath = async (dir: string) => join(await projectDir(dir), "fingerprints.json");

export async function loadFingerprints(dir: string): Promise<Fingerprints> {
  try {
    return JSON.parse(await readTextFile(await printsPath(dir)));
  } catch {
    return {};
  }
}

export async function saveFingerprints(dir: string, prints: Fingerprints) {
  await mkdir(await projectDir(dir), { recursive: true });
  await writeTextFile(await printsPath(dir), JSON.stringify(prints));
}

/** Sorts the folder's ids into the ones we have never seen and the ones whose
 *  bytes moved under us. Pure, so the rule can be tested without a disk.
 *
 *  `fresh` is not a problem to solve — it is a first run, or a character
 *  created since the last one, and all it needs is to be visible. `changed` is
 *  the question: same id, different face, and answering it wrong either throws
 *  away a restyled character's design or dresses a stranger in it. */
export function classify(
  prints: Fingerprints,
  hashes: Record<string, string>,
): { fresh: string[]; changed: string[] } {
  const fresh: string[] = [];
  const changed: string[] = [];
  for (const [id, hash] of Object.entries(hashes)) {
    const seen = prints[id];
    if (!seen) fresh.push(id);
    else if (hash !== seen.original && hash !== seen.written) changed.push(id);
  }
  return { fresh, changed };
}

/** Hashes every tile in the folder, keyed by id. */
export async function hashTiles(dir: string, ids: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const id of ids) {
    try {
      out[id] = await hashBytes(await readFile(await tilePath(dir, id)));
    } catch {
      // Unreadable right now — the game may be mid-write. Saying nothing is
      // better than reporting a character as replaced because of a race.
    }
  }
  return out;
}

/** Serialises manifest writes.
 *
 *  The write is two steps — a temp file, then a rename over the real one — so
 *  two of them in flight at once interleave: the second write replaces the
 *  temp file the first is about to rename, and one rename then finds nothing
 *  there. That is reachable from ordinary use: dragging a multi-selection
 *  fires one save per member in the same tick. Here it surfaced as a failed
 *  save; against a real disk, through Tauri's IPC, it is a lost write.
 *
 *  A queue rather than a lock, because a dropped save is worse than a late
 *  one: every caller still gets its turn, in order. */
let writing: Promise<void> = Promise.resolve();
let queuedWrite: { dir: string; m: Manifest } | null = null;

/** Whether a manifest write is still waiting its turn. Closing the window with
 *  one queued drops the last edit on the floor — the model has it, the disk
 *  never gets it — and the queue is what makes that window exist at all. */
export const savePending = () => queuedWrite !== null;

export function saveManifest(dir: string, m: Manifest): Promise<void> {
  /* Newer state supersedes older: a burst of edits — a slider being dragged —
   * asks for one save per event, and writing every intermediate stage of a
   * document that is about to change again is work nobody reads. The last one
   * contains all of them, so an earlier caller's promise resolving on a later
   * write is not a compromise. */
  queuedWrite = { dir, m };
  writing = writing
    .catch(() => {})
    .then(async () => {
      const next = queuedWrite;
      // Already covered by a later call that ran ahead of this turn.
      if (!next) return;
      queuedWrite = null;
      const path = await manifestPath(next.dir);
      await mkdir(await projectDir(next.dir), { recursive: true });
      await writeTextFile(`${path}.tmp`, JSON.stringify(next.m, null, 2));
      await rename(`${path}.tmp`, path);
    });
  return writing;
}

export async function hashBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest).slice(0, 8))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Writes bytes into assets/ under their content hash, unless a file with that
 *  name is already there — shared by importAsset (bytes read from a picked
 *  file) and saveGeneratedAsset (bytes rendered in memory), so the hashing and
 *  write-once rule live in exactly one place. */
async function storeAsset(dir: string, bytes: Uint8Array, ext: string): Promise<string> {
  const name = `${await hashBytes(bytes)}${ext}`;
  const assets = await assetsDir(dir);
  await mkdir(assets, { recursive: true });
  const target = await join(assets, name);
  if (!(await exists(target))) await writeFile(target, bytes);
  return name;
}

/** Reads one attribute off an opening tag, either quoting style. */
const attrOf = (tag: string, name: string) =>
  // Whitespace before the name rather than \b: `\bwidth` also matches the tail
  // of `stroke-width`, which is an ordinary thing to find on a root tag.
  tag.match(new RegExp(`\\s${name}\\s*=\\s*("[^"]*"|'[^']*')`, "i"))?.[1].slice(1, -1);

/** A length the browser can measure without a containing block. Percentages
 *  cannot: they resolve against a block an `<img>` never gives them, which is
 *  why "100%" counts as no size at all here. */
const absolute = (v: string | undefined) => !!v && v.trim() !== "" && !v.trim().endsWith("%");

/** Writes a viewBox-only SVG's size onto its root tag, or null if there is
 *  nothing to fix.
 *
 *  An `<img>` needs an intrinsic size, and a raster file carries one in its
 *  header. An SVG is a description: without absolute width/height on the root
 *  there is nothing to measure, so the browser falls back to the CSS default
 *  object size for replaced elements — 300×150, the same historical 2:1 a bare
 *  `<canvas>` gets. Fabric then takes those numbers as the picture's size, and
 *  a class icon lands in the Layout at a made-up scale (and, with no viewBox to
 *  keep the ratio, a made-up shape).
 *
 *  The viewBox already says what the file means. Copying it onto the tag is the
 *  whole fix, and doing it here means every later reader — Fabric, the sidebar
 *  thumbnail, any export — sees a picture that knows its own size. Files that
 *  already carry one are left alone; a file with neither has nothing to derive
 *  and keeps the browser's guess. */
export function svgWithSize(text: string): string | null {
  const tag = text.match(/<svg\b[^>]*>/i)?.[0];
  if (!tag) return null;
  if (absolute(attrOf(tag, "width")) && absolute(attrOf(tag, "height"))) return null;

  const box = attrOf(tag, "viewBox")?.trim().split(/[\s,]+/).map(Number);
  if (!box || box.length !== 4 || !(box[2] > 0) || !(box[3] > 0)) return null;

  // Replaced, not appended: a "100%" left in place would sit beside the new
  // value, and the first one wins.
  const bare = tag.replace(/\s+(width|height)\s*=\s*("[^"]*"|'[^']*')/gi, "");
  // A function replacer, so a `$&` sitting inside the tag's own attributes
  // cannot be read back as a substitution pattern.
  return text.replace(tag, () => `<svg width="${box[2]}" height="${box[3]}"${bare.slice(4)}`);
}

/** Copies a picked image into assets/ under its content hash and returns the name.
 *
 *  An SVG may be rewritten on the way in — see svgWithSize. The hash is taken
 *  after that, which is the point of hashing the bytes that get stored: the
 *  same icon imported twice still lands on one file. */
export async function importAsset(dir: string, sourcePath: string): Promise<string> {
  const ext = sourcePath.slice(sourcePath.lastIndexOf(".")).toLowerCase() || ".png";
  let bytes = await readFile(sourcePath);
  if (ext === ".svg") {
    const sized = svgWithSize(new TextDecoder().decode(bytes));
    if (sized) bytes = new TextEncoder().encode(sized);
  }
  return storeAsset(dir, bytes, ext);
}

/** Same content-addressed scheme as importAsset, for bytes that were rendered
 *  in memory (a Layout's stamp) rather than read from a picked file. */
export const saveGeneratedAsset = (dir: string, bytes: Uint8Array) => storeAsset(dir, bytes, ".png");

/** SVG needs its type spelled out or the blob will not decode at all. */
const mime = (name: string) => (name.toLowerCase().endsWith(".svg") ? "image/svg+xml" : "");

const assetBlob = async (dir: string, name: string) =>
  new Blob([await readFile(await join(await assetsDir(dir), name))], { type: mime(name) });

/** Drops a failed load from its cache before rethrowing.
 *
 *  These caches hold promises, not values, so a rejected one stays cached and
 *  every later read of that name fails again — a single unlucky read turns
 *  into a permanent one, and since the render chain awaits these, the canvas
 *  stops rebuilding for the rest of the session. Forgetting the failure makes
 *  the next attempt a real attempt. */
function forgetOnFailure<T>(cache: Map<string, Promise<T>>, key: string, p: Promise<T>) {
  const guarded = p.catch((e) => {
    cache.delete(key);
    throw e;
  });
  cache.set(key, guarded);
  return guarded;
}

const bitmaps = new Map<string, Promise<ImageBitmap>>();

export function loadAsset(dir: string, name: string): Promise<ImageBitmap> {
  return (
    bitmaps.get(name) ??
    forgetOnFailure(bitmaps, name, (async () => createImageBitmap(await assetBlob(dir, name)))())
  );
}

const originals = new Map<string, Promise<ImageBitmap>>();

/** The tile as the game shipped it: the vault copy once one exists, otherwise
 *  the file still sitting untouched in the game folder. Cacheable because both
 *  are immutable — saving vaults the pristine file *before* overwriting it, so
 *  the bytes behind a given id never change. */
export function loadOriginal(dir: string, id: string): Promise<ImageBitmap> {
  return (
    originals.get(id) ??
    forgetOnFailure(
      originals,
      id,
      (async () => {
        const path = (await exists(await vaultPath(dir, id)))
          ? await vaultPath(dir, id)
          : await tilePath(dir, id);
        return createImageBitmap(new Blob([await readFile(path)], { type: "image/bmp" }));
      })(),
    )
  );
}

/** Forgets one tile's cached original.
 *
 *  loadOriginal caches on the promise that the bytes behind an id never change:
 *  the vault copy is immutable and the game folder's file is only read when
 *  there is no vault copy. Deciding a slot holds a different character breaks
 *  exactly that promise — the vault copy is thrown away and the file underneath
 *  is somebody else's — so the cache has to be told. */
export const forgetOriginal = (id: string) => originals.delete(id);

/** Forgets every cached original.
 *
 *  For re-reading the folder, where the promise loadOriginal caches on — that
 *  the bytes behind an id never change — is exactly what the user is telling us
 *  is no longer true. Without this, re-opening a folder whose files were
 *  replaced from outside redrew the wall from the pixels of the session before
 *  it, and only restarting the app showed what was actually on disk. */
export const forgetAllOriginals = () => originals.clear();

const urls = new Map<string, Promise<string>>();

/** For showing an asset in an image element, e.g. while placing the mosaic. */
export function assetUrl(dir: string, name: string): Promise<string> {
  return (
    urls.get(name) ??
    forgetOnFailure(urls, name, (async () => URL.createObjectURL(await assetBlob(dir, name)))())
  );
}

/** The live app's pixel sources, in the shape scene.ts asks for. */
export const tauriDeps = (dir: string): SceneDeps => ({
  original: (id) => loadOriginal(dir, id),
  asset: (name) => assetUrl(dir, name),
});

/** Copies an untouched original into the vault. Never overwrites what is already there. */
export async function vaultOriginal(dir: string, id: string) {
  const vault = await vaultDir(dir);
  await mkdir(vault, { recursive: true });
  const backup = await join(vault, `${id}.bmp`);
  if (!(await exists(backup))) await copyFile(await tilePath(dir, id), backup);
}

const vaultPath = async (dir: string, id: string) => join(await vaultDir(dir), `${id}.bmp`);

/** Throws away a tile's vault copy.
 *
 *  Only for the case where the id turned out to be a different character. The
 *  vault is how the editor defines "the original" — loadOriginal reads it in
 *  preference to the game's own file — so a stale copy does not merely sit
 *  there: it keeps serving the old face on a slot that now belongs to someone
 *  else. Seen on a real folder, where thirty-five blanked portraits still
 *  showed their previous characters. */
export async function dropVaultCopy(dir: string, id: string) {
  const backup = await vaultPath(dir, id);
  if (await exists(backup)) await remove(backup);
}

/** Puts the game's own portraits back for a list of tiles, and says how many
 *  it actually replaced.
 *
 *  The vault is the record of what BDO shipped: a copy is made in the instant
 *  before Tessera first overwrites a file, so an id with no vault copy was
 *  never written to and has nothing to undo. That is why this counts what it
 *  found rather than what it was asked for — "0 restored" on a project that was
 *  never written is the honest answer, not a failure.
 *
 *  Deliberately touches nothing but the game folder. The manifest keeps every
 *  layer and every arrangement, so this is "show the originals in game again",
 *  not "throw the work away" — and pressing Write to game puts it all back. */
export async function restoreTiles(dir: string, ids: string[]): Promise<number> {
  let n = 0;
  for (const id of ids) {
    if (!(await exists(await vaultPath(dir, id)))) continue;
    await copyFile(await vaultPath(dir, id), await tilePath(dir, id));
    n++;
  }
  return n;
}

/* A snapshot is the document and nothing else: the manifest plus the
 * fingerprints beside it.
 *
 * Not the folder. Measured on a real one: assets/ is 87 MB and vault/ 84, and
 * neither ever changes — an asset is content-hashed and never deleted, a vault
 * copy is written once per tile in the instant before Tessera first overwrites
 * it. The only bytes that can go wrong are the 20 KB in here, so a snapshot
 * costs 20 KB and restoring one finds every asset it names still on disk.
 *
 * Fingerprints travel with it because they answer "is this file still the
 * character I know", and a manifest put back beside somebody else's answers to
 * that question would start asking about changes it had already settled. */
const snapshotDir = async (dir: string) => join(await projectDir(dir), "snapshots");

/** Which snapshot: the name it is shown under, and the project it belongs to.
 *
 *  `projectId` is "" for one taken with no wall open — the whole document put
 *  aside, which is what every snapshot used to be. */
export type SnapshotRef = { name: string; projectId: string };

/* The project id rides in the filename rather than inside the file, so listing
 * stays one readDir instead of opening every snapshot to ask who it belongs to.
 * `~` is safe as the separator because the name is sanitised to word
 * characters, spaces, dashes and dots — a name can never contain one, so the
 * split is unambiguous. A file with no separator is a document-wide snapshot,
 * which is exactly what the ones written before projects had their own are. */
/** What two snapshot names have to differ in to be different files.
 *
 *  Exported because the caller has to compare by it, not by what was typed:
 *  "a/b" and "a_b" are two names and one file, so a rename that only checked
 *  the typed text walked straight over the other snapshot — measured, and with
 *  no undo behind it. Anything that picks or accepts a name asks this. */
export const snapshotKey = (name: string) => name.replace(/[^\w \-.]/g, "_");

const sanitise = snapshotKey;

const snapshotFile = async (dir: string, ref: SnapshotRef) =>
  join(
    await snapshotDir(dir),
    ref.projectId ? `${ref.projectId}~${sanitise(ref.name)}.json` : `${sanitise(ref.name)}.json`,
  );

export async function listSnapshots(dir: string): Promise<SnapshotRef[]> {
  try {
    return (await readDir(await snapshotDir(dir)))
      .filter((e) => e.isFile && e.name.endsWith(".json"))
      .map((e) => {
        const stem = e.name.replace(/\.json$/, "");
        const cut = stem.indexOf("~");
        return cut < 0
          ? { name: stem, projectId: "" }
          : { name: stem.slice(cut + 1), projectId: stem.slice(0, cut) };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

export type Snapshot = { manifest: Manifest; prints: Fingerprints };

export async function writeSnapshot(dir: string, ref: SnapshotRef, snap: Snapshot) {
  await mkdir(await snapshotDir(dir), { recursive: true });
  await writeTextFile(await snapshotFile(dir, ref), JSON.stringify(snap, null, 2));
}

/** Reads one back, migrating it the same way the manifest itself is.
 *
 *  A file with no `manifest` key is one written before fingerprints joined the
 *  snapshot — it *is* the manifest. Old snapshots are the whole point of having
 *  them, so the reader keeps taking both shapes rather than making them
 *  unreadable to save a branch. */
export async function readSnapshot(dir: string, ref: SnapshotRef): Promise<Snapshot> {
  const raw = JSON.parse(await readTextFile(await snapshotFile(dir, ref)));
  const bare = !raw || typeof raw !== "object" || !("manifest" in raw);
  return {
    manifest: migrate(bare ? raw : raw.manifest),
    prints: bare ? {} : ((raw.prints ?? {}) as Fingerprints),
  };
}

export async function deleteSnapshot(dir: string, ref: SnapshotRef) {
  await remove(await snapshotFile(dir, ref));
}

/** Which ids the vault holds a pristine copy of — the ids "Reset in game" can
 *  actually put back. Exported because the button has to be honest before it is
 *  pressed: it used to offer every tile of the project and then report "none of
 *  these were written" after the confirmation. */
export async function vaultedIds(dir: string): Promise<string[]> {
  try {
    return (await readDir(await vaultDir(dir)))
      .filter((e) => e.isFile && e.name.toLowerCase().endsWith(".bmp"))
      .map((e) => e.name.replace(/\.bmp$/i, ""));
  } catch {
    return [];
  }
}

/** Drops vault copies whose id is no longer in the game folder.
 *
 *  The vault is not a snapshot: each file is copied in the instant before
 *  Tessera first overwrites it, so a new character vaults itself. What it
 *  cannot see on its own is an id being *reused* — a character deleted and a
 *  new one taking the same number — where the stale copy would then be served
 *  as that tile's "original" forever. Same for the reset route: delete the folder,
 *  let the game regenerate, and the regenerated files are the new originals.
 *  Running this on open keeps the vault honest for one readDir per session. */
export async function pruneVault(dir: string, ids: string[]) {
  const keep = new Set(ids);
  for (const id of await vaultedIds(dir)) {
    if (!keep.has(id)) await remove(await vaultPath(dir, id));
  }
}
