<script lang="ts">
  import { open } from "@tauri-apps/plugin-dialog";
  import { readFile } from "@tauri-apps/plugin-fs";
  import { defaultDir, loadPortraits, renderCover, savePortrait, type Portrait } from "./lib/portraits";

  let dir = $state("");
  let portraits = $state<Portrait[]>([]);
  let status = $state("");
  let error = $state("");

  async function load(next?: string) {
    error = "";
    try {
      dir = next ?? (await defaultDir());
      portraits = await loadPortraits(dir);
      status = `${portraits.length} Kacheln`;
    } catch (e) {
      error = `Ordner nicht lesbar: ${e}`;
    }
  }

  async function pickFolder() {
    const picked = await open({ directory: true, defaultPath: dir || undefined });
    if (typeof picked === "string") await load(picked);
  }

  async function replace(p: Portrait) {
    const picked = await open({
      filters: [{ name: "Bilder", extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp", "avif"] }],
    });
    if (typeof picked !== "string") return;

    error = "";
    status = "Schreibe…";
    try {
      const img = await createImageBitmap(new Blob([await readFile(picked)]));
      await savePortrait(dir, p, renderCover(img));
      img.close();
      URL.revokeObjectURL(p.url);
      await load(dir);
      status = `${p.id} ersetzt`;
    } catch (e) {
      error = `Schreiben fehlgeschlagen: ${e}`;
    }
  }

  load();
</script>

<div class="bar">
  <button onclick={pickFolder}>Ordner wählen</button>
  <span class="path">{dir}</span>
  <span class="path">{status}</span>
  {#if error}<span class="warn">{error}</span>{/if}
</div>

<div class="viewport">
  <div class="grid">
    {#each portraits as p (p.id)}
      <button class="tile" onclick={() => replace(p)} title={p.id}>
        <img src={p.url} alt={p.id} />
      </button>
    {/each}
  </div>
</div>
