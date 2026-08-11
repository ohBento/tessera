/* The actions that ask before they act.
 *
 * Every one of these is a destructive or outward-reaching command with a
 * dialog in front of it — the wording of that dialog *is* the feature, which
 * is why the comments here are longer than the code. They live beside the
 * editor rather than inside a component because nothing about them is visual:
 * a menu item, a button and a keyboard shortcut all want the same question
 * asked the same way.
 *
 * The editor is a singleton module, so these take no state — only what the
 * caller could not know, like which snapshot was clicked. */
import { ask } from "./platform";
import {
  app,
  deleteLayoutDoc,
  deleteProject,
  layoutTiles,
  openProject,
  projects,
  replaceAllCharacters,
  restorableCount,
  restoreProject,
  restoreSnapshot,
  removeSnapshot,
  saveToGame,
  strippableCount,
  stripSelectedTiles,
} from "./editor.svelte";

/** A yes/no the user actually answered.
 *
 *  A dialog that cannot open must not read as "no". It did: the confirmation
 *  was awaited inside a condition, so a rejected ask aborted the action with
 *  no dialog, no error and no change — a button that did nothing. Cancelling
 *  is still the safe answer when it fails, but now it says so. */
export async function confirmed(message: string, title: string) {
  try {
    return await ask(message, { title, kind: "warning" });
  } catch (e) {
    app.error = `Could not ask for confirmation: ${e}`;
    return false;
  }
}

/** Deleting a Layout takes its stamps and live captions off every tile with
 *  it — a layout and its layers on the wall do not survive each other. One
 *  undo step brings the lot back, but it is still a wall-wide change, which
 *  is worth saying out loud first. */
export async function removeLayout(id: string, name: string) {
  const used = layoutTiles(id);
  /* Asked either way. An unstamped Layout is not a cheap thing — it is a
     design somebody built and has not put on a wall yet — and it was one
     click from gone while a stamped one got a dialog. */
  const message = used
    ? // One unit. This used to name stamps and tiles separately, and the two
      // numbers were equal by construction — see tilesWearing.
      `"${name}" is on ${used} tile(s). Deleting it removes those stamps too.`
    : `Delete the layout "${name}"? It is not on any tile yet.`;
  if (!(await confirmed(message, "Delete layout?"))) return;
  await deleteLayoutDoc(id);
}

/** Puts the game's own portraits back over this project's tiles.
 *
 *  Asks first even though nothing in the document changes: it is the one
 *  action here that reaches into the game folder without being reversible by
 *  Ctrl+Z, and the way back is a second deliberate press of Write to game. */
export async function resetProject() {
  const p = openProject();
  if (!p) return;
  if (
    !(await confirmed(
      `Put the game's original portraits back for ${restorableCount()} tile(s) of "${p.name}"? ` +
        `Your layers and arrangement stay — press Write to game to put them back on.`,
      "Reset in game?",
    ))
  )
    return;
  await restoreProject();
}

/** The button that reaches out of the app and overwrites the game's own
 *  files. It asked nothing, while "Reset in game" beside it — fully
 *  reversible by pressing this one — asked every time. The question belongs
 *  on the side that leaves the folder changed. */
export async function writeToGame() {
  const p = openProject();
  if (!p) return;
  if (
    !(await confirmed(
      `Write ${p.order.length} tile(s) of "${p.name}" over the game's portrait files? ` +
        `The originals are kept, and "Reset in game" puts them back.`,
      "Write to game?",
    ))
  )
    return;
  await saveToGame();
}

/** The whole list answered at once, and the one answer with a step Ctrl+Z
 *  cannot take back: a new character means the game's original for that slot
 *  is a stranger's face, so the vault copy is deleted. After this there is no
 *  "Reset in game" for those tiles, and the question does not come round
 *  again — the entry leaves the list either way. */
export async function allNewCharacters() {
  const n = app.changedTiles.length;
  if (
    !(await confirmed(
      `Treat all ${n} portrait(s) as new characters? Their layers and wording go, ` +
        `they return to Unsorted, and the vaulted originals are deleted — ` +
        `"Reset in game" cannot bring those back.`,
      "All new characters?",
    ))
  )
    return;
  await replaceAllCharacters();
}

/** Undressing a wall is the bluntest thing on this menu: layers, hand-typed
 *  wording and per-tile pictures, on as many tiles as are picked. Deleting one
 *  Layout asks first; taking everything off forty-four portraits did not.
 *  Ctrl+Z holds it for the session, which is why one question is enough. */
export async function clearLayers() {
  const n = strippableCount();
  if (
    !(await confirmed(
      `Take everything off ${n} tile(s)? Layers, the wording typed on them and ` +
        `the pictures chosen per tile all go. Ctrl+Z brings them back.`,
      n > 1 ? "Clear all layers?" : "Clear the layers?",
    ))
  )
    return;
  await stripSelectedTiles();
}

/** Restoring replaces more than the arrangement, and the tooltip said only
 *  what it does *not* touch. A project snapshot puts back the whole project
 *  record — its name, its drawers, its wall picture — so a rename and a
 *  folder made after the snapshot were gone with one unasked click. Ctrl+Z
 *  does take it back, which is why one question is enough. */
export async function putBack(snap: { name: string; projectId: string }) {
  const what = snap.projectId
    ? `this wall's name, arrangement, folders, wall picture and the layers on its tiles`
    : `every project, layout and tile in the document`;
  if (
    !(await confirmed(
      `Put "${snap.name}" back? That replaces ${what} with the state it had when ` +
        `the snapshot was taken. Ctrl+Z undoes it; the game folder is not touched.`,
      "Restore snapshot?",
    ))
  )
    return;
  await restoreSnapshot(snap);
}

/** A snapshot is the only thing in this sidebar that Ctrl+Z cannot bring
 *  back, and its × sits beside the ↺ that restores it. Worth one question. */
export async function dropSnapshot(snap: { name: string; projectId: string }) {
  if (
    !(await confirmed(
      `Delete the snapshot "${snap.name}"? There is no undo for this one.`,
      "Delete snapshot?",
    ))
  )
    return;
  await removeSnapshot(snap);
}

/** Two questions, on purpose. The first is the safety net on the delete
 *  itself; the second decides what the tiles take with them to Unsorted —
 *  keep their artwork, or arrive bare. Native ask() only knows yes/no, so the
 *  three-way choice is two dialogs in a row. */
export async function removeProject(id: string, name: string) {
  const p = projects().find((x) => x.id === id);
  if (!p) return;
  const owned = p.order.length + p.shelf.length;
  if (
    !(await confirmed(
      `Delete "${name}"? Its ${owned} tile(s) go back to Unsorted; ` +
        `the arrangement is what you lose` +
        /* The tiles survive, the project record does not — and its drawers
           and its wall-wide picture live in that record. The dialog counted
           only the tiles, so both went unmentioned. */
        (p.folders.length ? `, along with ${p.folders.length} folder(s)` : "") +
        (p.gridLayers.length ? ` and the picture across the wall` : "") +
        `.`,
      "Delete project?",
    ))
  )
    return;
  const dressed = [...p.order, ...p.shelf].filter(
    (t) => app.manifest.tiles[t]?.layers.length,
  ).length;
  const strip =
    !!dressed &&
    (await confirmed(
      `Also remove all layers from its ${dressed} tile(s)? ` + `"No" keeps the artwork on them.`,
      "Remove layers too?",
    ));
  await deleteProject(id, strip);
}
