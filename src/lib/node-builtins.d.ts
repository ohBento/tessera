/* The node surface the migration dry run needs, and nothing else.
 *
 * @types/node instead of this would be the usual answer, and it is the wrong
 * one here: it declares node's globals over the whole project, and this app
 * typechecks as a browser. The best-known casualty is setTimeout, which starts
 * returning NodeJS.Timeout where the DOM says number — a browser file breaks
 * because a test file wanted to read a manifest off the disk.
 *
 * Ten lines with an exact surface cannot do that. Widen it when a second
 * node-side test needs something, rather than reaching for the package. */
declare module "node:fs" {
  export function existsSync(path: string): boolean;
  export function readFileSync(path: string, encoding: "utf8"): string;
  export function readdirSync(path: string): string[];
}

declare module "node:os" {
  export function homedir(): string;
}

declare module "node:path" {
  export function join(...parts: string[]): string;
}

declare const process: { env: Record<string, string | undefined> };
