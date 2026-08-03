import { execSync } from "node:child_process";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";

/* Windows locks a running executable, so a release built while Tessera is open
 * fails at link or copy time with an unhelpful EIO. Close it first. */
try {
  execSync("taskkill /IM Tessera.exe /F", { stdio: "ignore" });
  console.log("closed the running Tessera");
} catch {
  // not running, which is the normal case
}

execSync("npm run tauri build", { stdio: "inherit" });

mkdirSync("release", { recursive: true });
cpSync("src-tauri/target/release/tessera.exe", "release/Tessera.exe");

/* Explorer's "Date created" is not trustworthy here: overwriting a file of
 * the same name in the same folder triggers NTFS tunnelling, which silently
 * keeps the ORIGINAL creation timestamp from the very first build — deleting
 * first does not defeat it either, since tunnelling still applies within its
 * cache window. A plain text file with the real build time sidesteps the
 * whole quirk. */
writeFileSync("release/BUILD.txt", `built ${new Date().toISOString()}\n`);

console.log("release/Tessera.exe");
