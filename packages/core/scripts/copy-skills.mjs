import { cp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");
const src = join(pkgRoot, "src", "skills", "builtin");
const dst = join(pkgRoot, "dist", "skills", "builtin");

await rm(dst, { recursive: true, force: true });
await cp(src, dst, { recursive: true });
