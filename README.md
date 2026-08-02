# Tessera

Portrait editor for Black Desert Online. Replaces the character-select portraits in
`Documents\Black Desert\FaceTexture` with your own images — one at a time, or one
image spread across the whole grid as a mosaic.

Status: **M0, walking skeleton.** Reads the folder, shows the grid, replaces a single
tile, writes the BMP back. Everything else is still on the plan.

## Target format

Verified against 60 real portrait files: 624 × 804, `BITMAPINFOHEADER`, 32 bpp
`BI_RGB`, bottom-up, alpha `0xFF` throughout. Tessera writes exactly what the game
itself writes.

## Backups

Before a tile is overwritten for the first time, the untouched original is copied to
`Documents\Black Desert\FaceTexture.tessera-vault`. Nothing ever overwrites the vault.

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
