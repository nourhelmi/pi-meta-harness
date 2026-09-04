import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
const root = new URL("../src/", import.meta.url);
function files(path) { return readdirSync(path).flatMap((name) => { const target = join(path, name); return statSync(target).isDirectory() ? files(target) : [target]; }); }
for (const file of files(root.pathname)) {
  const source = readFileSync(file, "utf8");
  if (/from\s+["']@bb\//.test(source) || /from\s+["'][^"']*(?:workflows|advisor|harness)[^"']*["']/.test(source)) throw new Error(`prohibited import in ${file}`);
}
console.log("public SDK only");
