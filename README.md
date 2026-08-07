# Tessera

Portrait editor for Black Desert Online. Replaces the character-select portraits in
`Documents\Black Desert\FaceTexture` with your own — one at a time, or one image
spread across the whole grid as a mosaic.

## What it does

- **The grid is the canvas.** Every portrait in the folder is a tile on one zoomable
  wall; a tile is an export crop of it, not a separate editor.
- **Projects.** The folder belongs to the Windows user, not to a BDO account, so
  several accounts share one. A project is one wall; a tile belongs to at most one,
  and what nothing has claimed shows up under *Unsorted*.
- **Layouts.** A reusable design — pictures, captions, shapes, groups — stamped onto a
  tile as flat pixels. A layer marked *Editable in grid* stays out of the stamp and is
  copied onto the tile as a live layer instead, so a caption can name the character.
- **Masks.** Any layer can be clipped by any other: a shape by its outline, a picture
  by the pixels it has, a caption by its letters. Invertible.
- **Snapshots.** The whole document set aside under a name and walked back to later.
  One is taken automatically before every write to the game.

## Download

Grab `Tessera-portable.zip` or the installer from
[Releases](https://github.com/ohBento/tessera/releases/latest). Portable is a single
`Tessera.exe` — no install, no service, nothing in the registry.

## Target format

Verified against 60 real portrait files: 624 × 804, `BITMAPINFOHEADER`, 32 bpp
`BI_RGB`, bottom-up, alpha `0xFF` throughout. Tessera writes exactly what the game
itself writes.

## Where your data lives

Everything Tessera owns sits *beside* the game folder, in `FaceTexture.tessera`:
the manifest, imported assets, snapshots, and a vault holding the untouched original
of every portrait it has ever overwritten. Nothing ever overwrites the vault, and
*Restore portraits* copies it back into the game.

## Develop

```bash
npm install
npm run tauri dev
```

```bash
npm test
```

## Disclaimer

Not affiliated with, endorsed by, or connected to Pearl Abyss. "Black Desert Online"
is their trademark; it appears here only to describe what this tool works with. Use at
your own risk — it writes into your game's portrait folder.

## Licence

AGPL-3.0-only. See [LICENSE](LICENSE).
