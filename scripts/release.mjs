import { execSync } from "node:child_process";
import { cpSync, mkdirSync } from "node:fs";

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
console.log("release/Tessera.exe");
