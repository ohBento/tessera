import { cpSync, mkdirSync } from "node:fs";

mkdirSync("release", { recursive: true });
cpSync("src-tauri/target/release/tessera.exe", "release/Tessera.exe");
console.log("release/Tessera.exe");
