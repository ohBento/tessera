# Render harness

Renders the same layer constellations down both paths and diffs them pixel by
pixel:

- **`lib/render.ts` (`drawTile`)** — the ground truth. It renders the data model
  and produces the exported BMP.
- **`lib/fabricBuild.ts`** — the Fabric objects the editor canvas is built from.

If the two disagree, Fabric is wrong: the editor would be showing something the
export will not reproduce.

```bash
npm run harness   # then open http://localhost:1421/harness.html
```

The page prints an "off pixels" percentage per case and leaves the raw pixels on
`window.__harness` / `window.__pixels`, so a case can be measured from the
console instead of judged from a screenshot.

Anything under ~0.2% is antialiasing noise. Text cases sit slightly higher
because Fabric lays text out itself rather than calling `fillText`.

## Why it exists

The app is Tauri-only, so it cannot simply be opened in a browser and the
render code could not be exercised outside the packaged build — bugs were
diagnosed from screenshots, which turned into guesswork. `lib/project.ts` is the
only Tauri dependency in the render chain (`assetUrl`, `loadAsset`,
`loadOriginal`); `vite.harness.config.ts` swaps it for `mockProject.ts` and
everything else runs untouched. The alias lives in its own Vite config so it can
never reach the production build.

Test images are generated and deliberately asymmetric — a mirrored or rotated
result has to score as wrong, which a symmetric image would hide.
