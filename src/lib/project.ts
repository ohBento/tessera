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

/** The same moment, spelled so a filename can hold it.
 *
 *  Windows refuses `:` in a name, and a stamp to the second has two of them —
 *  so both places that set a damaged file aside were building a path the OS
 *  rejects, and the rename threw. Which is worse than it sounds: the recovery
 *  is deliberately not wrapped in a catch, so the folder then does not open at
 *  all, this time and every time after, and the only way out is renaming a
 *  file by hand in Explorer. Snapshots have always been named through
 *  `snapshotKey`, which strips these — this is the same rule, said where the
 *  other two callers can reach it. */
export const fileStamp = () => localStamp(19).replace(/:/g, "_");

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
): Promise<{
  manifest: Manifest;
  lost: string[];
  snapshot: string;
  broken: string;
  /** The file's own version when it was older than this build's, and the name
   *  of the copy kept of it. Empty when nothing was migrated. */
  migrated: { from: number; backup: string } | null;
}> {
  let m = emptyManifest();
  let broken = "";
  let migrated: { from: number; backup: string } | null = null;
  let text = "";
  try {
    text = await readTextFile(await manifestPath(dir));
  } catch {
    // No project here yet. The ordinary first open, and the only case that
    // should silently produce an empty document.
  }
  if (text) {
    try {
      const raw = JSON.parse(text) as { version?: unknown };
      const from = typeof raw.version === "number" ? raw.version : 0;
      m = migrate(raw);
      /* A copy of the file exactly as it was, before this build gets a chance
       * to write over it.
       *
       * Migration happens on open and the first edit saves the new shape, so
       * without this the old document is gone one keystroke after a version
       * that misreads it. Undo is no help — it lives in memory and starts
       * empty — and neither are snapshots, which re-run the same migration
       * when they are read. One file copy is the whole insurance.
       *
       * Written once per version: the name carries the version it holds, and
       * a document that has already been migrated never comes through here
       * again. */
      if (from > 0 && from < m.version) {
        const name = `manifest.v${from}.bak.json`;
        const to = await join(await projectDir(dir), name);
        if (!(await exists(to))) await writeTextFile(to, text);
        migrated = { from, backup: name };
      }
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
      broken = `manifest.unreadable ${fileStamp()}.json`;
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
      { manifest: m, prints: (await loadFingerprints(dir)).prints },
    );
  }
  // Characters get created and deleted between sessions; the folder wins.
  return { manifest: pruneToFolder(m, ids), lost, snapshot, broken, migrated };
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
 * Every file is hashed on open. The hashing itself is cheap and measured: 70ms
 * for forty-four tile-sized buffers, about 90 MB. The reading was the cost —
 * see hashTiles, which starts the reads together for the same reason buildGrid
 * does. Confirmed in the packaged app on a real folder: the difference is
 * plain at forty-four tiles, which is the size this tool was built against and
 * not some future wall nobody has.
 *
 * ponytail: the lever left is not hashing files that cannot have changed, and
 * nothing yet says it is needed. readDir in Tauri 2 carries no size or mtime,
 * so it means a new stat path, its permission and its mock — worth it only if
 * a folder several times this size starts to drag. --- */

export type Print = { original: string; written?: string };
export type Fingerprints = Record<string, Print>;

const printsPath = async (dir: string) => join(await projectDir(dir), "fingerprints.json");

/** The hashes, and the name a damaged file was set aside under.
 *
 *  `broken` is "" for the ordinary case, which includes there being no file
 *  yet. It is not the same as an empty answer: see below for what an empty one
 *  costs when it is wrong. */
export async function loadFingerprints(
  dir: string,
): Promise<{ prints: Fingerprints; broken: string }> {
  let text = "";
  try {
    text = await readTextFile(await printsPath(dir));
  } catch {
    // No file yet — a first open, and the only case that may quietly answer
    // with nothing.
    return { prints: {}, broken: "" };
  }
  /* Same guard loadManifest carries: nothing to parse is not the same as
   * something that will not parse, and only the second one is worth setting
   * aside. With the atomic write above, a zero-byte file can no longer be our
   * own doing. */
  if (!text) return { prints: {}, broken: "" };
  try {
    return { prints: JSON.parse(text), broken: "" };
  } catch {
    /* A file that is there but will not parse used to share the catch above,
     * and answering "{}" to that question is the most expensive silence in this
     * app. Empty prints make `classify` call every id fresh, openFolder writes
     * those hashes straight back as the originals, and the question "did the
     * game put a different character behind this slot" can never be asked
     * again — so the stranger keeps the previous character's vault copy, and
     * their own pristine portrait is never captured. Set aside instead, and
     * said out loud, because what the user loses is a warning they will never
     * see missing. */
    const broken = `fingerprints.unreadable ${fileStamp()}.json`;
    await rename(await printsPath(dir), await join(await projectDir(dir), broken));
    return { prints: {}, broken };
  }
}

/** Temp file then rename, exactly as saveManifest does and for the same reason:
 *  a write that stops halfway must not leave half a file in the real path. This
 *  one was writing straight over the target while its neighbour twenty lines up
 *  carried a comment explaining why that is not safe. */
export async function saveFingerprints(dir: string, prints: Fingerprints) {
  await mkdir(await projectDir(dir), { recursive: true });
  const path = await printsPath(dir);
  await writeTextFile(`${path}.tmp`, JSON.stringify(prints));
  await rename(`${path}.tmp`, path);
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

/** Hashes every tile in the folder, keyed by id.
 *
 *  Started together rather than one after the next, for the reason buildGrid
 *  gives about the same files: a read is a two-megabyte trip across the IPC
 *  boundary, and awaiting them in turn makes the open cost forty-four of those
 *  in a row. The comment in openFolder says this step "takes seconds" — the
 *  hashing is not what it is spending them on. Measured over forty-four
 *  tile-sized buffers: SHA-256 costs 70ms in total, and hashing them all at
 *  once rather than in turn saves 6ms of that. What is left is the reading.
 *
 *  Filled in id order once they are all in, and the second half of that
 *  sentence is not decoration either: `classify` walks this map with
 *  Object.entries, and what it produces becomes the "new characters" and
 *  "changed" lists the user works down one at a time. Written as each read
 *  finished, those lists would come out in whatever order the disk answered
 *  in — a different order on every open, for the same folder. */
export async function hashTiles(dir: string, ids: string[]): Promise<Record<string, string>> {
  const hashed = await Promise.all(
    ids.map(async (id) => {
      try {
        return await hashBytes(await readFile(await tilePath(dir, id)));
      } catch {
        // Unreadable right now — the game may be mid-write. Saying nothing is
        // better than reporting a character as replaced because of a race.
        return undefined;
      }
    }),
  );
  const out: Record<string, string> = {};
  ids.forEach((id, i) => {
    const hash = hashed[i];
    if (hash !== undefined) out[id] = hash;
  });
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
/** The newest state waiting to be written, one entry per folder. */
const queued = new Map<string, Manifest>();
/** Set while a write is actually touching the disk.
 *
 *  The queue slot is emptied the moment a turn picks it up, which is before
 *  the four awaits that do the writing — so `savePending` answered "nothing
 *  pending" for the whole of the slow part, which is exactly the window the
 *  guard exists to cover. In the common case of a single edit and an
 *  immediate close it was never true at all. */
let writingNow = false;

/** Whether a manifest write is queued or in flight. Closing the window with
 *  one of either drops the last edit on the floor — the model has it, the disk
 *  never gets it. */
export const savePending = () => queued.size > 0 || writingNow;

export function saveManifest(dir: string, m: Manifest): Promise<void> {
  /* Newer state supersedes older: a burst of edits — a slider being dragged —
   * asks for one save per event, and writing every intermediate stage of a
   * document that is about to change again is work nobody reads. The last one
   * contains all of them, so an earlier caller's promise resolving on a later
   * write is not a compromise. */
  /* One slot per folder. Superseding is only true within one document: a save
     for folder A waiting its turn when a save for B arrives was dropped
     outright, its promise resolving as though it had been written. There is
     one folder open at a time today, so this is insurance rather than a
     symptom — but it is the mechanism that exists to stop a write going
     missing, and it went missing in exactly the case it is for. */
  queued.set(dir, m);
  writing = writing
    .catch(() => {})
    .then(async () => {
      const [entry] = queued;
      // Already covered by a later call that ran ahead of this turn.
      if (!entry) return;
      const next = { dir: entry[0], m: entry[1] };
      queued.delete(next.dir);
      writingNow = true;
      try {
        const path = await manifestPath(next.dir);
        await mkdir(await projectDir(next.dir), { recursive: true });
        await writeTextFile(`${path}.tmp`, JSON.stringify(next.m, null, 2));
        await rename(`${path}.tmp`, path);
      } finally {
        writingNow = false;
      }
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
 *  cannot: they resolve against a block an image element never gives them,
 *  which is why "100%" counts as no size at all here. */
const absolute = (v: string | undefined) => !!v && v.trim() !== "" && !v.trim().endsWith("%");

/** Writes a viewBox-only SVG's size onto its root tag, or null if there is
 *  nothing to fix.
 *
 *  An image element needs an intrinsic size, and a raster file carries one in its
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
  /* The dot in the *name*, not the last dot anywhere in the path.
     `lastIndexOf` answers -1 when there is none, and `slice(-1)` is the last
     character rather than "", so the `|| ".png"` fallback was dead: a file
     called `klasse` was stored as `<hash>e`. Worse when only a directory
     carried the dot — `C:\my.icons\klasse` gave `.icons\klasse`, a path
     separator inside the asset name, and the write landed in a folder that
     does not exist. */
  const name = sourcePath.slice(
    Math.max(sourcePath.lastIndexOf("/"), sourcePath.lastIndexOf("\\")) + 1,
  );
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot).toLowerCase() : ".png";
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
export const snapshotKey = (name: string) =>
  /* Letters and digits of any language, plus space, dash, underscore and dot.
     `\w` without the u flag is ASCII only, so every umlaut became an
     underscore — "Vor dem Löschen" was filed and then *shown* as
     "Vor dem L_schen", because the list reads the name back off the filename.
     The app quietly renamed what the user typed, in the language the user
     types in.
     What still goes: the characters Windows refuses in a name, `~` because it
     separates the project id from the name in that filename, and anything
     else outside this set. */
  name.replace(/[^\p{L}\p{N} \-._]/gu, "_");

const sanitise = snapshotKey;

const snapshotFile = async (dir: string, ref: SnapshotRef) =>
  join(
    await snapshotDir(dir),
    ref.projectId ? `${ref.projectId}~${sanitise(ref.name)}.json` : `${sanitise(ref.name)}.json`,
  );

export async function listSnapshots(dir: string): Promise<SnapshotRef[]> {
  const snaps = await snapshotDir(dir);
  try {
    return (await readDir(snaps))
      .filter((e) => e.isFile && e.name.endsWith(".json"))
      .map((e) => {
        const stem = e.name.replace(/\.json$/, "");
        const cut = stem.indexOf("~");
        return cut < 0
          ? { name: stem, projectId: "" }
          : { name: stem.slice(cut + 1), projectId: stem.slice(0, cut) };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (e) {
    /* Same split as vaultedIds, and the same reason. No snapshots folder means
     * none have been taken. A folder that is there and will not open means the
     * restore list is a lie — and it lies in the direction of "there is nothing
     * to go back to", at exactly the moment the folder is already misbehaving
     * and a restore point is what someone is looking for. */
    if (await exists(snaps)) throw e;
    return [];
  }
}

export type Snapshot = { manifest: Manifest; prints: Fingerprints };

export async function writeSnapshot(dir: string, ref: SnapshotRef, snap: Snapshot) {
  await mkdir(await snapshotDir(dir), { recursive: true });
  /* Temp file then rename, the way the manifest and the fingerprints are
     written, and for a sharper reason: a snapshot is what the app offers as the
     way back from the two actions that cannot be undone, and this was the one
     write here that truncated its target first. A power cut during the one
     "Before write" takes on every save to the game left a half file that
     `listSnapshots` still offers and `readSnapshot` throws on — and unlike a
     damaged manifest there is no path that sets a damaged snapshot aside. */
  const path = await snapshotFile(dir, ref);
  await writeTextFile(`${path}.tmp`, JSON.stringify(snap, null, 2));
  await rename(`${path}.tmp`, path);
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
  const vault = await vaultDir(dir);
  try {
    return (await readDir(vault))
      .filter((e) => e.isFile && e.name.toLowerCase().endsWith(".bmp"))
      .map((e) => e.name.replace(/\.bmp$/i, ""));
  } catch (e) {
    /* No vault yet is the ordinary answer and really is an empty one — nothing
     * has been written to the game from this folder.
     *
     * A vault that is there and will not open is not. Answering [] to that says
     * "none of these portraits can be put back" about files that are sitting
     * right there, at the one moment a user is most likely to be asking:
     * something has gone wrong with the folder. Someone told that could go
     * looking for a rougher way to get their originals back. */
    if (await exists(vault)) throw e;
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
export async function pruneVault(dir: string, ids: string[]): Promise<number> {
  const keep = new Set(ids);
  const held = await vaultedIds(dir);
  const gone = held.filter((id) => !keep.has(id));
  /* A folder listing that lost most of the vault at once is not evidence that
     most of the characters are gone. It is what a fresh install looks like
     before anyone has logged in, what a half-synced Documents folder looks
     like, and what an antivirus holding the directory looks like — and acting
     on it deletes the only copy of what the game shipped, on open, unattended,
     with no undo anywhere near it. A stale copy is one tile showing a wrong
     original; this was forty of them, permanently.

     ponytail: half is a threshold, not a proof. It costs one comparison and
     catches both the empty listing and the "three files did not sync" case; if
     it ever refuses a real cleanup, the answer is to ask rather than to widen
     it — the count comes back so the caller can say so. */
  if (gone.length > held.length / 2) return gone.length;
  for (const id of gone) await remove(await vaultPath(dir, id));
  return 0;
}
