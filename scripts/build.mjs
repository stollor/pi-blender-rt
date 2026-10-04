/**
 * 构建脚本：把 src/index.ts 剥离类型生成 extensions/index.js。
 *
 * 为什么包里交付 .js 而不是 .ts：pi 的**包加载管线**转译 TS 时会触发 Bun(JSC) 的确定性崩溃
 * （panic: index out of bounds，同一文件经 `pi --extension` 直载却完全正常）。
 * 交付生成的 .js 绕开该转译路径；src/index.ts 仍是唯一事实源，改完跑 `npm run build`。
 */
import { stripTypeScriptTypes } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const SRC = path.join(ROOT, "src", "index.ts");
const OUT_DIR = path.join(ROOT, "extensions");
const OUT = path.join(OUT_DIR, "index.js");

const src = fs.readFileSync(SRC, "utf8");
const js = stripTypeScriptTypes(src, { mode: "strip" });
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT, js);
console.log("built: " + path.relative(ROOT, OUT) + " (" + js.length + " bytes)");
