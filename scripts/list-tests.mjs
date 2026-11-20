/**
 * Print the test files for `node --test`.
 *
 * The suite is a flat directory of standalone `.mjs` files, each one a small
 * executable spec with its own assertions. Listing them here (instead of
 * hard-coding the list in package.json) means a new spec is picked up by
 * existing tooling and can never be silently left out of CI.
 */
import { readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const dir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "test");
const files = readdirSync(dir)
 .filter((name) => name.endsWith(".mjs"))
 .sort();
process.stdout.write(files.map((name) => "test/" + name).join(" "));
