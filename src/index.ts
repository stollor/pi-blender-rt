/**
 * pi-blender-rt — 让 pi 的模型直接驱动 Blender（dsh-blender-plugin 的 pi 移植版）
 *
 * 上游：https://github.com/sixtysevenlf/dsh-blender-plugin （BSD-3-Clause）
 * 本扩展把上游 DSH 宿主层的 15 个工具移植到 pi 的 ExtensionAPI：
 *   - 后端（runtime/server.mjs，127.0.0.1:9877）原样复用，只做 HTTP 适配；
 *   - Blender 侧依赖 "MCP for Blender" addon（127.0.0.1:9876），由后端 /launch 自动拉起并 Connect；
 *   - 保留上游的关键省 token 设计：帧去重（同画面不重复附图）、560px 默认、渐进披露（catalog）。
 *
 * 工具面（与上游同名同参）：
 *   blender_viewport（运维）· blender_rt_see / do / watch（感知）· blender_rt_loop（内环搜索）
 *   blender_rt_cmd / commands（addon 直连）· blender_rt_perf / opt（渲染性能/对象精简）
 *   blender_rt_headless / worker / job（无头/热会话/作业）· blender_rt_txn / preset（事务/配方）
 *   blender_rt_plan（契约层 · 28 families / 183 ops）
 *
 * 验收判据（与上游一致，不可妥协）：blender_viewport(op="doctor") 必须返回 kind=ok。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// 基础设施
// ---------------------------------------------------------------------------

const DEFAULT_PORT = 9877;
/** 本会话在写通道上的身份（租约 holder）；写请求自带 holder 时后端自动接管/续期 */
const HOLDER = "pi-ext-pid-" + String(process.pid);
const BACKEND_HINT =
  '后端不可用（127.0.0.1:PORT）。先 blender_viewport(op="start") 起后端；Blender 没跑再 op="launch" 一键拉起。';

/** 扩展所在目录（jiti 下 import.meta.url 可用；兜底 cwd） */
function extDir(): string {
  try {
    // jiti 的 ESM 路径下 import.meta.url 指向本文件
    const u = import.meta?.url;
    if (typeof u === "string" && u.startsWith("file:")) {
      return path.dirname(new URL(u).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
    }
  } catch {
    /* CJS 兜底走下面 */
  }
  try {
    const d = (globalThis as any).__dirname;
    if (typeof d === "string" && d) return d;
  } catch {
    /* ignore */
  }
  return process.cwd();
}

const HERE = extDir();

function safeReaddir(p: string): string[] {
  try {
    return fs.readdirSync(p);
  } catch {
    return [];
  }
}

/**
 * 找上游 runtime/server.mjs。查找顺序：
 *   1. 环境变量 PI_BLENDER_RT_RUNTIME（runtime 目录 / server.mjs 本体 / 仓库根皆可）
 *   2. <ext>/vendor/dsh-blender-plugin/runtime/server.mjs（scripts/install-runtime 装的）
 *   3. <ext>/vendor/node_modules/@dsh-external/dsh-blender-plugin/runtime/server.mjs
 */
function findServerMjs(): string | null {
  const roots: string[] = [];
  if (process.env.PI_BLENDER_RT_RUNTIME) roots.push(process.env.PI_BLENDER_RT_RUNTIME);
  roots.push(path.join(HERE, "vendor"));
  roots.push(path.join(HERE, "vendor", "node_modules", "@dsh-external", "dsh-blender-plugin"));
  for (const r of roots) {
    const cands = [
      r,
      path.join(r, "runtime"),
      path.join(r, "dsh-blender-plugin", "runtime"),
    ];
    for (const c of cands) {
      const s = c.endsWith("server.mjs") ? c : path.join(c, "server.mjs");
      if (fs.existsSync(s)) return s;
    }
  }
  return null;
}

/** runtime 缺失时自动引导：git clone 上游到 vendor/（一次性，之后走本地） */
async function bootstrapRuntime(): Promise<string | null> {
  const target = path.join(HERE, "vendor", "dsh-blender-plugin");
  if (process.env.PI_BLENDER_RT_NO_BOOTSTRAP) return null;
  await new Promise<void>((resolve) => {
    const g = spawn("git", ["clone", "--depth", "1", "https://github.com/sixtysevenlf/dsh-blender-plugin.git", target], {
      stdio: "ignore",
    });
    g.on("exit", () => resolve());
    g.on("error", () => resolve());
    setTimeout(resolve, 120000);
  });
  return findServerMjs();
}

/**
 * 探测 blender.exe。上游自动探测只覆盖 Program Files / Steam 等标准位置，
 * 这里补上 %LOCALAPPDATA%\Tools\blender 等非标准安装位（探测不到就交给上游配置）。
 */
function detectBlenderExe(): string | null {
  if (process.env.DSH_BLENDER_EXE) return process.env.DSH_BLENDER_EXE;
  const cands: string[] = [];
  if (process.platform === "win32") {
    const lad = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    cands.push(path.join(lad, "Tools", "blender", "blender.exe"));
    const pf = process.env.ProgramFiles || "C:\\Program Files";
    for (const d of safeReaddir(path.join(pf, "Blender Foundation"))) {
      cands.push(path.join(pf, "Blender Foundation", d, "blender.exe"));
    }
    cands.push("C:\\Program Files (x86)\\Steam\\steamapps\\common\\Blender\\blender.exe");
    cands.push("C:\\Steam\\steamapps\\common\\Blender\\blender.exe");
    cands.push("D:\\SteamLibrary\\steamapps\\common\\Blender\\blender.exe");
  } else if (process.platform === "darwin") {
    for (const base of ["/Applications", path.join(os.homedir(), "Applications")]) {
      for (const d of safeReaddir(base)) {
        if (/^Blender/i.test(d)) cands.push(path.join(base, d, "Contents", "MacOS", "Blender"));
      }
    }
  }
  for (const c of cands) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      /* ignore */
    }
  }
  return null;
}

function port(): number {
  const n = Number(process.env.PI_BLENDER_RT_PORT || process.env.DSH_BLENDER_HTTP_PORT || DEFAULT_PORT);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_PORT;
}

function base(): string {
  return "http://127.0.0.1:" + String(port());
}

let paused = false; // blender_viewport op=stop 之后尊重用户意图，不再自动拉起
let child: ReturnType<typeof spawn> | null = null;
let bootstrapping: Promise<string | null> | null = null;
let ensuring: Promise<boolean> | null = null; // 并发工具调用共用一次引导（防双 spawn / 双 clone）

async function probeHttp(url: string, timeoutMs = 900): Promise<boolean> {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    const r = await fetch(url, { signal: ac.signal });
    clearTimeout(t);
    return r.ok;
  } catch {
    return false;
  }
}

/** 解析后端响应：普通路由整段 JSON；流式路由（headless/worker/txn/preset）按行找最后一条非心跳 JSON */
function parseBackendBody(text: string): any {
  const t = String(text == null ? "" : text);
  try {
    const o = JSON.parse(t);
    if (o && typeof o === "object") return o;
  } catch {
    /* 流式响应 */
  }
  const lines = t
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  let last: any = null;
  let beats = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    let o: any = null;
    try {
      o = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (!o || typeof o !== "object") continue;
    if (o.heartbeat === true) continue;
    last = o;
    break;
  }
  for (const l of lines) {
    try {
      if (JSON.parse(l)?.heartbeat === true) beats++;
    } catch {
      /* 非 JSON 行 */
    }
  }
  if (last) {
    last.__heartbeats = beats;
    return last;
  }
  return { ok: false, raw: t.slice(-500), parseError: "no JSON line found" };
}

async function backendGet(p: string, timeoutMs = 20000): Promise<any> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(base() + p, { signal: ac.signal });
    const text = await r.text();
    const j = parseBackendBody(text);
    j.__status = r.status;
    return j;
  } finally {
    clearTimeout(t);
  }
}

/** 写操作统一入口：自动带 holder（租约门禁在后端按 holder 自动接管/续期），计时器活到 body 读完 */
async function backendPost(p: string, body: any, timeoutMs = 60000): Promise<any> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(base() + p, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...(body || {}), holder: HOLDER }),
      signal: ac.signal,
    });
    const text = await r.text();
    const j = parseBackendBody(text);
    j.__status = r.status;
    return j;
  } finally {
    clearTimeout(t);
  }
}

/** 工具入参容错：`{...}` 字符串也当对象用（模型两种形态都给得出来） */
function jsonPayload(v: any): any {
  if (v === undefined || v === null || v === "") return {};
  if (typeof v === "string") {
    try {
      const p = JSON.parse(v);
      return p && typeof p === "object" && !Array.isArray(p) ? p : {};
    } catch {
      return {};
    }
  }
  if (typeof v === "object" && !Array.isArray(v)) return { ...v };
  return {};
}

/** "--flag \"a b\" c" 切成 argv；数组直接透传 */
function splitArgs(s: any): string[] {
  if (Array.isArray(s)) return s.map((x) => String(x));
  const str = String(s == null ? "" : s);
  const out: string[] = [];
  let cur = "";
  let q: string | null = null;
  for (const ch of str) {
    if (q) {
      if (ch === q) q = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      q = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur) {
        out.push(cur);
        cur = "";
      }
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/** 409 leased → 给模型一句能照着做的话 */
function leasedText(r: any): string | undefined {
  if (!r || r.error !== "leased") return undefined;
  return (
    "写通道被别的会话占用（holder=" +
    String(r.holder) +
    "，剩余 " +
    Math.round(Number(r.expiresInMs || 0) / 1000) +
    "s）。要强抢：blender_viewport op=lease force=true"
  );
}

/** 后端进程管理：探活 → 缺 runtime 先引导 → spawn → 轮询 /health（并发调用共用同一次引导） */
async function ensureBackend(): Promise<boolean> {
  if (paused) return false;
  if (await probeHttp(base() + "/health")) return true;
  if (ensuring) return ensuring;
  ensuring = ensureBackendInner().finally(() => {
    ensuring = null;
  });
  return ensuring;
}

async function ensureBackendInner(): Promise<boolean> {
  let server = findServerMjs();
  if (!server) {
    if (!bootstrapping) bootstrapping = bootstrapRuntime();
    server = await bootstrapping;
    bootstrapping = null;
  }
  if (!server) return false;
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (!env.DSH_BLENDER_EXE) {
    const exe = detectBlenderExe();
    if (exe) env.DSH_BLENDER_EXE = exe;
  }
  try {
    child = spawn("node", [server], {
      env,
      stdio: "ignore",
      detached: true,
      cwd: path.dirname(path.dirname(server)),
    });
    child.unref?.();
  } catch {
    return false;
  }
  for (let i = 0; i < 50; i++) {
    if (await probeHttp(base() + "/health", 700)) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

// ---------------------------------------------------------------------------
// 帧获取 + 去重（上游的省 token 设计：同画面不重复附图）
// ---------------------------------------------------------------------------

async function fetchFrame(size: number, full = false, area = 0): Promise<{ png: Buffer; ms: number; hash: string }> {
  const t0 = Date.now();
  const url = base() + "/frame.png?" + (full ? "full=1&area=" + String(area) : "size=" + String(size));
  const r = await fetch(url);
  if (!r.ok) throw new Error("frame http " + String(r.status));
  const png = Buffer.from(await r.arrayBuffer());
  return { png, ms: Date.now() - t0, hash: createHash("md5").update(png).digest("hex").slice(0, 8) };
}

async function fetchView(spec: any, timeoutMs = 180000): Promise<{ png: Buffer; ms: number; meta: any; hash: string }> {
  const t0 = Date.now();
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(base() + "/view", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(spec || {}),
      signal: ac.signal,
    });
    if (!r.ok) {
      const text = await r.text();
      let j: any = null;
      try {
        j = JSON.parse(text);
      } catch {
        /* ignore */
      }
      throw new Error("view http " + String(r.status) + " · " + String((j && j.error) || text.slice(0, 300)));
    }
    let meta: any = null;
    try {
      const rawHdr = String(r.headers.get("x-dsh-view") || "null");
      const txt = rawHdr.indexOf("%7B") === 0 ? decodeURIComponent(rawHdr) : rawHdr;
      meta = JSON.parse(txt);
    } catch {
      meta = null;
    }
    const png = Buffer.from(await r.arrayBuffer());
    return { png, ms: Date.now() - t0, meta, hash: createHash("md5").update(png).digest("hex").slice(0, 8) };
  } finally {
    clearTimeout(t);
  }
}

const FRAME_CACHE = new Map<string, { hash: string; repeats: number }>();

function frameDedupe(key: string, hash: string, force = false): { dup: boolean; repeats: number } {
  const k = String(key || "default");
  const cur = FRAME_CACHE.get(k);
  if (!force && cur && cur.hash === hash && hash) {
    cur.repeats += 1;
    return { dup: true, repeats: cur.repeats };
  }
  FRAME_CACHE.set(k, { hash, repeats: 0 });
  if (FRAME_CACHE.size > 32) {
    const oldest = FRAME_CACHE.keys().next().value;
    if (oldest !== undefined && oldest !== k) FRAME_CACHE.delete(oldest);
  }
  return { dup: false, repeats: 0 };
}

function dedupeNote(repeats: number): string {
  return " · **与上一张完全相同**（第 " + String(repeats + 1) + " 次）⇒ 未重复附图；要重发传 force:true";
}

function imgBlock(png: Buffer): { type: "image"; data: string; mimeType: string } {
  return { type: "image", data: png.toString("base64"), mimeType: "image/png" };
}

function textResult(text: string, extra?: Record<string, any>) {
  return { content: [{ type: "text" as const, text }], details: { tool: "pi-blender-rt", ...(extra || {}) } };
}

function imgResult(text: string, pngs: Buffer[], extra?: Record<string, any>) {
  return {
    content: [
      { type: "text" as const, text },
      ...pngs.map(imgBlock),
    ],
    details: { tool: "pi-blender-rt", ...(extra || {}) },
  };
}

function numTriple(v: any): number[] | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (Array.isArray(v)) return v.map((x) => Number(x));
  return String(v)
    .split(/[,\s]+/)
    .filter(Boolean)
    .map((x) => Number(x));
}

function clip(s: any, n = 6000): string {
  const t = typeof s === "string" ? s : JSON.stringify(s, null, 1);
  return t.length > n ? t.slice(0, n) + "\n…[已截断，共 " + String(t.length) + " 字符]" : t;
}

function newRunId(): string {
  return "run-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

/** JSON Schema 小工具（不引 typebox 依赖；typebox 的 schema 本体就是 JSON Schema） */
const S = {
  str: (description: string) => ({ type: "string", description }),
  num: (description: string) => ({ type: "number", description }),
  int: (description: string) => ({ type: "integer", description }),
  bool: (description: string) => ({ type: "boolean", description }),
  json: (description: string) => ({ type: "object", additionalProperties: true, description }),
  obj: (properties: Record<string, any>, required: string[] = []) => ({
    type: "object",
    properties,
    ...(required.length ? { required } : {}),
  }),
};

const PARSE_HELP = "参数细节见 blender_rt_plan(op=\"catalog\", args={tool:\"...\"})。";

// ---------------------------------------------------------------------------
// 扩展主体
// ---------------------------------------------------------------------------

export default function piBlenderRt(pi: ExtensionAPI) {
  const P = port();

  /** 统一前置：确保后端在；返回错误文本或 null */
  async function ready(): Promise<string | null> {
    if (await ensureBackend()) return null;
    return BACKEND_HELP(P, paused);
  }

  // ------------------------- 运维 -------------------------
  pi.registerTool({
    name: "blender_viewport",
    label: "Blender 通道运维",
    description:
      "实时通道后端（127.0.0.1:" +
      String(P) +
      "）运维入口：**status**（健康/计数/版本）、**doctor**（真跑一次 bpy 往返的三级体检，**验收判据：必须 kind=ok**）、" +
      "**start / stop / restart**（后端进程）、**who / lease / release**（写租约；被别人持有时写路由 409，只读 op 豁免）、" +
      "**launch**（一键拉起 GUI Blender 并自动 Connect addon：boot 脚本 → spawn → 轮询 addon 端口，幂等，无需人工点击）。" +
      "装好/修好之后跑 doctor，非 ok 按提示修。",
    parameters: S.obj({
      op: S.str("status | doctor | who | lease | release | start | stop | restart | launch"),
      holder: S.str("lease/release 的持有者名（默认本扩展进程 pid 标识）"),
      ttl_ms: S.int("lease 有效期毫秒，默认 600000；写操作自动续期"),
      force: S.bool("lease 时抢占别人的租约（默认 false）"),
      wait_ms: S.int("【launch】等 addon 端口打开的上限，默认 90000"),
      file: S.str("【launch】启动时打开的 .blend"),
      exe: S.str("【launch】显式指定 blender 可执行文件"),
      addon_module: S.str("【launch】要 enable 的 addon 模块名（逗号分隔）；默认自动扫名字带 mcp 的模块"),
      addon_file: S.str("【launch】按文件 import 的 addon .py 绝对路径（Blender 5.x extension 布局兜底）"),
      dry_run: S.bool("【launch】true = 只回报将执行的命令"),
    }),
    async execute(_id, args: any) {
      const op = String((args && args.op) || "status");
      if (op === "start") {
        paused = false;
        if (await probeHttp(base() + "/health", 800)) return textResult("后端已在运行：" + base() + "/");
        const ok = await ensureBackend();
        return textResult(
          ok ? "后端已启动：" + base() + "/" : "启动失败：15s 内 /health 不通。检查 node ≥ 20 与 runtime（scripts/install-runtime 装上游 runtime）",
        );
      }
      if (op === "stop") {
        paused = true;
        const notes: string[] = [];
        if (child) {
          try {
            (child as any).kill();
          } catch {
            /* ignore */
          }
          child = null;
          notes.push("child 已杀");
        }
        try {
          const who = await backendGet("/health", 1500);
          if (who && who.backend && who.backend.pid) {
            process.kill(Number(who.backend.pid));
            notes.push("后端 pid=" + String(who.backend.pid) + " 已杀");
          }
        } catch {
          /* 没起或已退出 */
        }
        return textResult(notes.length ? "已停止后端：" + notes.join(" · ") + "（op=start 恢复）" : "没有在跑的后端");
      }
      if (op === "restart") {
        paused = false;
        try {
          const who = await backendGet("/health", 1500);
          if (who && who.backend && who.backend.pid) process.kill(Number(who.backend.pid));
        } catch {
          /* ignore */
        }
        await new Promise((r) => setTimeout(r, 500));
        const ok = await ensureBackend();
        return textResult(ok ? "后端已重启：" + base() + "/" : "重启失败：/health 不通");
      }
      // who/lease/release/launch/doctor/status 都要后端在场：冷启动先自举（否则首个调用必挂 Unable to connect）
      if (op === "who" || op === "lease" || op === "release" || op === "launch" || op === "doctor" || op === "status") {
        const notUp = await ready();
        if (notUp) return textResult(notUp);
      }
      if (op === "who" || op === "lease" || op === "release") {
        try {
          if (op === "who") {
            const w = await backendGet("/who", 15000);
            const lz = (w && w.lease) || {};
            const m = (w && w.metrics) || {};
            return textResult(
              [
                "租约：" +
                  (lz.active
                    ? "持有者 " + String(lz.holder) + "（剩余 " + Math.round(Number(lz.expiresInMs || 0) / 1000) + "s）"
                    : "空闲（谁都能写）"),
                "本会话 holder：" + HOLDER + (lz.active && lz.holder === HOLDER ? "（就是本会话）" : ""),
                "通道：calls=" + String(m.calls || 0) + " errors=" + String(m.errors || 0) + " timeouts=" + String(m.timeouts || 0),
                "统计：" + JSON.stringify((w && w.stats) || {}),
              ].join("\n"),
            );
          }
          const body: any = { holder: String((args && args.holder) || HOLDER) };
          if (args && args.ttl_ms) body.ttlMs = Number(args.ttl_ms);
          if (op === "lease" && args && args.force) body.force = true;
          const r = await backendPost(op === "lease" ? "/lease" : "/release", body, 20000);
          if (r && r.error === "leased") {
            return textResult(
              "租约被占用：holder=" + String(r.holder) + "，剩余 " + Math.round(Number(r.expiresInMs || 0) / 1000) + "s\n" + String(r.hint || ""),
            );
          }
          return textResult((op === "lease" ? "LEASE " : "RELEASE ") + JSON.stringify(r));
        } catch (e: any) {
          return textResult(op + " 失败：" + String(e?.message || e) + "（后端没起？blender_viewport op=start）");
        }
      }
      if (op === "launch") {
        try {
          const body: any = {};
          if (args && args.wait_ms) body.waitMs = Number(args.wait_ms);
          if (args && args.file) body.file = String(args.file);
          if (args && args.exe) body.exe = String(args.exe);
          else {
            const exe = detectBlenderExe();
            if (exe) body.exe = exe;
          }
          if (args && args.addon_module) body.addonModule = String(args.addon_module);
          if (args && args.addon_file) body.addonFile = String(args.addon_file);
          if (args && args.dry_run) body.dryRun = true;
          const r = await backendPost("/launch", body, Math.max(30000, Number((args && args.wait_ms) || 90000) + 30000));
          const lines: string[] = [];
          lines.push(
            (r && r.ok ? "LAUNCH ok" : "LAUNCH 未成功") +
              (r && r.already ? " · 已在监听（幂等）" : "") +
              (r && r.launched ? " · 已 spawn pid=" + String(r.pid) : "") +
              " · addon 端口 " + String((r && r.addonPort) || "-") +
              " · 等待 " + String((r && r.waitedMs) || 0) + "ms",
          );
          if (r && r.exe) lines.push("blender：" + String(r.exe));
          if (r && r.error) lines.push("错误：" + String(r.error));
          if (r && r.hint) lines.push("提示：" + String(r.hint));
          if (r && Array.isArray(r.steps)) for (const s of r.steps) lines.push("· " + String(s));
          const b = r && r.boot;
          if (b) {
            lines.push(
              "boot 结论：loaded_by=" + String(b.loaded_by || "-") + " · server_running=" + String(b.server_running) + " · enabled=" + JSON.stringify(b.enabled || []),
            );
            if (Array.isArray(b.errors) && b.errors.length) lines.push("boot 错误：" + b.errors.slice(0, 4).join(" | "));
          }
          const doc = r && r.doctor;
          if (doc && doc.addon) lines.push("启动后体检：" + String(doc.addon.summary || JSON.stringify(doc.addon)).slice(0, 400));
          return textResult(lines.join("\n"));
        } catch (e: any) {
          return textResult("launch 失败：" + String(e?.message || e) + "（后端没起？先 blender_viewport op=start）");
        }
      }
      // status / doctor
      try {
        if (op === "doctor") {
          const d = await backendGet("/doctor", 60000);
          const diag = (d && d.diagnosis) || null;
          const lines: string[] = [];
          lines.push("诊断：" + String((d && d.kind) || (diag && diag.kind) || (d && d.ok ? "ok" : "unknown")));
          lines.push("宿主：pi-blender-rt（pi 扩展）@ " + HERE);
          if (diag && diag.summary) lines.push("结论：" + diag.summary);
          if (diag && diag.fix) lines.push("修法：" + diag.fix);
          if (d && d.addon) lines.push("addon：" + JSON.stringify(d.addon));
          const led = (d && d.ledger) || null;
          if (led && led.workDir) lines.push("工作目录：" + String(led.workDir.wsl || led.workDir.win || "?") + (led.workDir.writable ? "（可写）" : "（⚠ 不可写）"));
          const m = (d && d.metrics) || {};
          lines.push("指标：calls=" + String(m.calls || 0) + " errors=" + String(m.errors || 0) + " timeouts=" + String(m.timeouts || 0) + " views=" + String(m.views || 0));
          return textResult(lines.join("\n"), { kind: d && d.kind });
        }
        const s = await backendGet("/status", 15000);
        return textResult(clip(s, 3000));
      } catch (e: any) {
        return textResult("体检失败：" + String(e?.message || e) + "（后端可能没起：blender_viewport op=start）");
      }
    },
  });

  // ------------------------- 感知 -------------------------
  pi.registerTool({
    name: "blender_rt_see",
    label: "看视口",
    description:
      "【看视口】约 55–160 ms 出一帧：改一步看一眼就用它。给 from/look_at（可配 lens / ortho / view_size / shading / overlays / view_mode）走**自定义视角**：" +
      "自建矩阵离屏绘制，不建相机、不动用户视口、不动物体。full=true + area=N 走整窗口截图（看 Blender UI 时用）。" +
      "回执带 coverage_estimate 与 frame_looks_empty 自诊断（近空帧会建议机位）；**同画面默认不重复附图**（省视觉 token），要重发传 force=true。" +
      PARSE_HELP,
    parameters: S.obj({
      max_size: S.int("最长边像素，默认 560（420 更快，900 更清晰）"),
      full: S.bool("整窗口/区域截图；默认 false = 3D 视口离屏帧"),
      area: S.int("full=true 时的区域序号，默认 0"),
      from: S.str('【自定义视角】相机位置 "x,y,z"（世界坐标）'),
      look_at: S.str('【自定义视角】看向的点 "x,y,z"'),
      lens: S.num("【自定义视角】焦距 mm，默认 50"),
      ortho: S.bool("【自定义视角】正交投影（配合 ortho_scale）"),
      ortho_scale: S.num("【自定义视角】正交尺度，默认 10"),
      view_size: S.str('【自定义视角】分辨率 "宽x高"，如 "1280x720"；默认按 max_size 出 16:9'),
      shading: S.str("【自定义视角】临时切换着色 WIREFRAME/SOLID/MATERIAL/RENDERED（出图后还原）"),
      overlays: S.bool("【自定义视角】临时开关覆盖物，出图后还原"),
      view_mode: S.str("【自定义视角】viewport（默认）/ render（临时相机 + Workbench 快渲）"),
      diagnostics: S.bool("强制跑诊断三项（coverage/scene_bbox/objects_in_frame）；默认近空帧才补跑"),
      force: S.bool("与上一帧 hash 相同时也强制重发图片"),
    }),
    async execute(_id, args: any) {
      const err = await ready();
      if (err) return textResult(err);
      const size = Math.max(120, Math.min(1600, Number((args && args.max_size) || 560)));
      const full = !!(args && args.full);
      const area = Number((args && args.area) || 0);
      const frm = numTriple(args && args.from);
      const look = numTriple(args && args.look_at);
      try {
        if (frm || look) {
          const spec: any = {
            from: frm || [7, -7, 5],
            look_at: look || [0, 0, 1],
            lens: args?.lens === undefined ? undefined : Number(args.lens),
            ortho: args?.ortho === undefined ? undefined : !!args.ortho,
            ortho_scale: args?.ortho_scale === undefined ? undefined : Number(args.ortho_scale),
            shading: args?.shading || undefined,
            overlays: args?.overlays === undefined ? undefined : !!args.overlays,
            mode: args?.view_mode || undefined,
          };
          const vs = String((args && args.view_size) || "");
          const mm = vs.match(/^(\d+)\s*[x×]\s*(\d+)$/);
          if (mm) {
            spec.width = Number(mm[1]);
            spec.height = Number(mm[2]);
          } else {
            spec.width = Math.round((size * 16) / 9);
            spec.height = size;
          }
          if (args && args.diagnostics !== undefined) spec.diagnostics = !!args.diagnostics;
          const fv = await fetchView(spec);
          const dkey =
            "view:" +
            JSON.stringify([spec.width, spec.height, spec.from, spec.look_at, spec.lens ?? null, !!spec.ortho, spec.ortho_scale ?? null, spec.shading || null, spec.overlays ?? null, spec.mode || null]);
          const dd = frameDedupe(dkey, fv.hash, !!(args && args.force));
          const mt = fv.meta || {};
          let text =
            "自定义视角 " +
            String(mt.mode || spec.mode || "viewport") +
            " · " +
            spec.width +
            "x" +
            spec.height +
            " · " +
            fv.ms +
            "ms · hash " +
            fv.hash +
            (mt.coverage_estimate == null ? "" : " · 覆盖 " + (Number(mt.coverage_estimate) * 100).toFixed(2) + "%") +
            " · 场景与用户视口均未改动";
          if (mt.warning && mt.warning.code === "frame_looks_empty") {
            text +=
              "\n⚠ frame_looks_empty：" +
              String(mt.warning.why || "画面里几乎只剩底色") +
              (mt.warning.suggest ? "\n  建议照这组再出一次：from=" + JSON.stringify(mt.warning.suggest.from) + " look_at=" + JSON.stringify(mt.warning.suggest.look_at) : "");
          }
          if (dd.dup) return textResult(text + dedupeNote(dd.repeats));
          return imgResult(text, [fv.png]);
        }
        const f = await fetchFrame(size, full, area);
        const dd = frameDedupe(full ? "area:" + area : "viewport:" + size, f.hash, !!(args && args.force));
        const text = (full ? "区域截图 · " : "视口帧 " + size + "px · ") + f.ms + "ms · hash " + f.hash;
        if (dd.dup) return textResult(text + dedupeNote(dd.repeats));
        return imgResult(text, [f.png]);
      } catch (e: any) {
        return textResult("SEE 失败：" + String(e?.message || e));
      }
    },
  });

  pi.registerTool({
    name: "blender_rt_do",
    label: "执行 Blender Python",
    description:
      "实时驱动 Blender：在 Blender 主线程执行一段 Python（或跑 .py 文件），可选立刻回一帧视口（整步约 105ms）。" +
      "持久内核：K.x=1 这次写、下次调用还能读到（sys.modules['dsh_rt_kernel']）；预置 bpy/math/mathutils/Vector。" +
      "**异常也会回传 partial stdout / stderr / traceback**。返回的 ms 是主线程占用，>1s 的重活请改走 blender_rt_headless / blender_rt_worker。",
    parameters: S.obj({
      code: S.str("Python 代码（与 file 二选一）"),
      file: S.str("要执行的 .py 文件路径（长脚本用这个）"),
      see: S.bool("是否同时回一帧视口（默认 true）"),
      max_size: S.int("回帧最长边像素，默认 560"),
      force: S.bool("回帧与上一帧 hash 相同时也强制重发"),
    }),
    async execute(_id, args: any) {
      const err = await ready();
      if (err) return textResult(err);
      const code = String((args && args.code) || "");
      const file = args && args.file ? String(args.file) : null;
      if (!code && !file) return textResult("需要 code 或 file 之一");
      const body: any = { code };
      if (file) body.file = file;
      const r = await backendPost("/act", body, 180000);
      const lt = leasedText(r);
      if (lt) return textResult(lt);
      const parts: string[] = [];
      parts.push(r?.ok ? "ACT ok · " + String(r.ms) + "ms" : "ACT 失败 · " + String(r?.error || r?.raw || "unknown"));
      if (r && Number(r.mainThreadMs) > 1000) parts.push("⚠️ 占用主线程约 " + String(r.mainThreadMs) + "ms —— 重活改走 headless/worker");
      if (r?.stderr && String(r.stderr).trim()) parts.push("stderr: " + String(r.stderr).trim().slice(0, 1200));
      if (r?.traceback) parts.push("--- traceback ---\n" + String(r.traceback).slice(0, 2000));
      if (r?.stdout) parts.push("stdout: " + String(r.stdout).trim().slice(0, 3000));
      const see = !(args && args.see === false);
      if (!see) return textResult(parts.join("\n"));
      try {
        const size = Math.max(120, Math.min(1600, Number((args && args.max_size) || 560)));
        const f = await fetchFrame(size);
        const dd = frameDedupe("do-see:" + size, f.hash, !!(args && args.force));
        if (dd.dup) {
          parts.push("SEE " + size + "px · " + f.ms + "ms · hash " + f.hash + dedupeNote(dd.repeats));
          return textResult(parts.join("\n"));
        }
        parts.push("SEE " + size + "px · " + f.ms + "ms · hash " + f.hash);
        return imgResult(parts.join("\n"), [f.png]);
      } catch (e: any) {
        parts.push("SEE 失败: " + String(e?.message || e));
        return textResult(parts.join("\n"));
      }
    },
  });

  pi.registerTool({
    name: "blender_rt_watch",
    label: "时间窗观察",
    description:
      "实时观察一段时间窗：可选先跑一段 Python（起 timers / 播放动画 / 让物体动起来），然后在 seconds 秒内按 fps 采样视口帧，返回均匀抽取的最多 6 帧 + 逐帧 hash（hash 相同=画面没变）。判断「它到底动没动、动得对不对」用它。fps 低一点 —— 每帧占主线程 ~55ms。",
    parameters: S.obj({
      code: S.str("可选：观察前先执行的 Python"),
      seconds: S.num("观察时长，默认 2 秒（0.2-20）"),
      fps: S.num("采样率，默认 4（0.5-8）"),
      max_size: S.int("帧最长边像素，默认 420"),
    }),
    async execute(_id, args: any) {
      const err = await ready();
      if (err) return textResult(err);
      const seconds = Math.max(0.2, Math.min(20, Number((args && args.seconds) || 2)));
      const fps = Math.max(0.5, Math.min(8, Number((args && args.fps) || 4)));
      const size = Math.max(120, Math.min(1600, Number((args && args.max_size) || 420)));
      const parts: string[] = [];
      if (args && args.code) {
        const r = await backendPost("/act", { code: String(args.code) }, 180000);
        parts.push(r?.ok ? "ACT ok · " + String(r.ms) + "ms" : "ACT 失败 · " + String(r?.error || ""));
      }
      const total = Math.max(1, Math.min(32, Math.round(seconds * fps)));
      const interval = (seconds * 1000) / total;
      const shots: any[] = [];
      const t0 = Date.now();
      for (let i = 0; i < total; i++) {
        try {
          const f = await fetchFrame(size);
          shots.push({ t: Date.now() - t0, ms: f.ms, hash: f.hash, png: f.png });
        } catch {
          shots.push({ t: Date.now() - t0, ms: -1, hash: "ERR", png: null });
        }
        const wait = (i + 1) * interval - (Date.now() - t0);
        if (wait > 1) await new Promise((r) => setTimeout(r, wait));
      }
      const hashes = shots.map((s) => s.hash);
      const distinct = new Set(hashes).size;
      const avgMs = Math.round(shots.reduce((a, s) => a + Math.max(0, s.ms), 0) / Math.max(1, shots.length));
      parts.push("WATCH " + seconds + "s @" + fps + "fps → " + shots.length + " 帧 · 平均 " + avgMs + "ms/帧 · 不同画面 " + distinct + "/" + hashes.length);
      parts.push("timeline: " + shots.map((s, i) => i + "@" + s.t + "ms:" + s.hash).join(" "));
      const picks: any[] = [];
      if (shots.length <= 6) {
        for (const s of shots) if (s.png) picks.push(s);
      } else {
        for (let k = 0; k < 6; k++) {
          const idx = Math.round((k * (shots.length - 1)) / 5);
          if (shots[idx]?.png) picks.push(shots[idx]);
        }
      }
      parts.push("附帧：" + picks.length + " 张（均匀抽取）");
      return imgResult(parts.join("\n"), picks.map((p) => p.png));
    },
  });

  // ------------------------- addon 直连 -------------------------
  pi.registerTool({
    name: "blender_rt_cmd",
    label: "调 addon 命令",
    description:
      "直连调用 Blender addon 的任意命令（34 个名字：19 常驻 + 15 集成门控），含 MCP 层不暴露的 get_world_state_snapshot / drain_human_activity / get_addon_info 等。" +
      "参数必须匹配 addon 真实签名：get_scene_info 无参、get_object_info 用 name（不是 object_name）。先用 blender_rt_commands 看清单与可用性。",
    parameters: S.obj(
      {
        name: S.str("addon 命令名，如 get_world_state_snapshot、search_polyhaven_assets"),
        params: S.json("参数对象（可选），如 {\"asset_type\":\"hdris\"}"),
        timeout_ms: S.int("超时毫秒，默认 120000（下载/生成类可调大）"),
      },
      ["name"],
    ),
    async execute(_id, args: any) {
      const err = await ready();
      if (err) return textResult(err);
      const name = String((args && args.name) || "");
      if (!name) return textResult("blender_rt_cmd 需要 name 参数");
      const r = await backendPost("/cmd", { name, params: jsonPayload(args?.params), timeoutMs: Number(args?.timeout_ms || 120000) }, 300000);
      const lt = leasedText(r);
      if (lt) return textResult(lt);
      if (!r || r.ok !== true) return textResult("CMD " + name + " 失败 · " + String(r?.error || r?.raw || "unknown"));
      const payload = JSON.stringify(r.result);
      return textResult("CMD " + name + " ok · " + String(r.ms) + "ms · " + payload.length + " chars\n" + clip(payload, 3000));
    },
  });

  pi.registerTool({
    name: "blender_rt_commands",
    label: "列 addon 命令",
    description: "列出直连通道当前可用的 addon 命令（19 常驻 + 15 集成门控）与 5 个集成的真实状态（PolyHaven / Sketchfab / Poly Pizza / Hyper3D / Hunyuan3D）。调 blender_rt_cmd 之前先用它。",
    parameters: S.obj({}),
    async execute() {
      const err = await ready();
      if (err) return textResult(err);
      const r = await backendGet("/commands", 120000);
      if (!r || r.ok !== true) return textResult("COMMANDS 失败 · " + String(r?.error || r?.raw || "unknown"));
      const lines: string[] = [];
      lines.push("场景 " + String(r.scene) + (r.file ? " · 文件 " + String(r.file) : " · 未保存文件"));
      lines.push("可用命令 " + String(r.total) + " 条；被集成开关挡住 " + String((r.disabled || []).length) + " 条");
      lines.push("集成：" + Object.keys(r.integrations || {}).map((k) => k + "=" + (r.integrations[k].enabled ? "on" : "off")).join(" · "));
      if ((r.disabled || []).length) lines.push("被挡住：" + r.disabled.join(", "));
      lines.push("可用：" + (r.available || []).join(", "));
      return textResult(lines.join("\n"));
    },
  });

  // ------------------------- 内环搜索 -------------------------
  pi.registerTool({
    name: "blender_rt_loop",
    label: "内环迭代搜索",
    description:
      "【内环迭代】在 Blender 主线程跑几百到几千次迭代（bpy.app.timers，主线程安全，迭代/时间双上限 + 急停）：模型只写目标与验收，机器去搜，**零模型轮次**。" +
      "**何时用（量化）**：要在参数空间搜 ≥20 次、且每次都要出图或量测；只搜 ≤5 次 → 用 rt_do 自己循环。" +
      "spec={setup, step, measure, iterations, budget_ms, interval, measure_every, minimize, top_k, group_key}；measure 必须设 ns['score']。" +
      "预置 bpy/K/math/random/numpy/i/frac/penalize/anneal/record。**内环只优化你写的 score：收敛后必须换另一条计算通路复核 + rt_see 视觉确认**（防 Goodhart）。" +
      "op=start **必须**给 iterations 或 budget_ms（安全阀）。",
    parameters: S.obj(
      {
        op: S.str("start | status | stop | board | export | help | bench"),
        spec: S.json("op=start 的规格 {setup, step, measure, iterations, budget_ms, interval, measure_every, minimize, top_k, group_key}"),
        history: S.int("op=status 返回的指标尾迹长度，默认 8"),
        board: S.int("op=status 同时返回前 N 个候选（默认 0）"),
        limit: S.int("op=board 的候选条数，默认 10"),
        groups: S.bool("op=board 是否包含分组候选（默认 true）"),
        path: S.str("op=export 写出脚本的路径；省略=只回文本"),
        top: S.int("op=export 的变体数量"),
        include_variants: S.bool("op=export 是否把候选表一起导出"),
        note: S.str("op=export 的备注"),
        iterations: S.int("op=bench 的迭代次数"),
      },
      ["op"],
    ),
    async execute(_id, args: any) {
      const err = await ready();
      if (err) return textResult(err);
      const op = String((args && args.op) || "status");
      const payload = {
        op,
        spec: jsonPayload(args?.spec),
        history: args?.history || 8,
        board: args?.board || 0,
        limit: args?.limit || 10,
        groups: !(args && args.groups === false),
        path: args?.path,
        top: args?.top || 1,
        include_variants: !!(args && args.include_variants),
        note: args?.note || "",
        iterations: args?.iterations || 5000,
      };
      const r = await backendPost("/loop", payload, 300000);
      const lt = leasedText(r);
      if (lt) return textResult(lt);
      if (!r || r.ok !== true) return textResult("LOOP " + op + " 失败 · " + String(r?.error || r?.raw || "unknown"));
      return textResult("LOOP " + op + " " + clip(r.result, 6000));
    },
  });

  // ------------------------- 渲染性能 / 对象精简 -------------------------
  pi.registerTool({
    name: "blender_rt_perf",
    label: "渲染性能剖析",
    description:
      "【渲染性能】Cycles 瓶颈诊断与优化预设。op=analyze 差分实测「每轮 CPU 同步 / 每采样 GPU 成本」（占主线程十几秒）；op=apply 应用预设（persistent_data / 按 GPU 自动选降噪器 / denoising_use_gpu / auto_tile off / 采样上限）；op=revert 还原；op=status 看当前设置；op=help 契约。" +
      "实测参考：2318 对象场景每轮 CPU 同步 ≈4.2s，persistent_data 让重复渲染 14.6s → 0.79s。",
    parameters: S.obj(
      {
        op: S.str("status | analyze | apply | revert | help"),
        args: S.json('analyze{pct=25,low=1,high=4}；apply{samples=1024,persistent=true,denoiser="OPTIX",denoise_gpu=true,auto_tile=false}'),
      },
      ["op"],
    ),
    async execute(_id, args: any) {
      const err = await ready();
      if (err) return textResult(err);
      const op = String((args && args.op) || "status");
      const pargs = jsonPayload(args?.args);
      // 无参时必须给 undefined（给 {} 会让 python 侧多收一个位置参数）
      const r = await backendPost("/perf", { op, args: Object.keys(pargs).length ? pargs : undefined }, 600000);
      const lt = leasedText(r);
      if (lt) return textResult(lt);
      if (!r || r.ok !== true) return textResult("PERF " + op + " 失败 · " + String(r?.error || r?.raw || "unknown"));
      return textResult("PERF " + op + " " + clip(r.result, 6000));
    },
  });

  pi.registerTool({
    name: "blender_rt_opt",
    label: "对象安全合并",
    description:
      "【对象精简】降 Cycles 每轮场景同步成本（实测 ≈1.4ms/对象）。op=analyze 列出可安全合并的分组与预计节省；op=join 执行合并（**默认 dry_run=true 只报告**；dry_run=false 才真合并，强烈建议同时给 save_before 先存回退点）。" +
      "合并规则：同集合/同材质/同父级/无修改器/无动画/无形态键/无自定义属性/无实例/非库链接。合并后几何零损失（面数顶点数不变）。",
    parameters: S.obj(
      {
        op: S.str("analyze | join | help"),
        args: S.json('join{dry_run=true, save_before="D:/.../xxx_before_join.blend"}'),
      },
      ["op"],
    ),
    async execute(_id, args: any) {
      const err = await ready();
      if (err) return textResult(err);
      const op = String((args && args.op) || "analyze");
      const oargs = jsonPayload(args?.args);
      const r = await backendPost("/opt", { op: op === "join" ? "opt_join" : "opt_analyze", args: Object.keys(oargs).length ? oargs : undefined }, 600000);
      const lt = leasedText(r);
      if (lt) return textResult(lt);
      if (!r || r.ok !== true) return textResult("OPT " + op + " 失败 · " + String(r?.error || r?.raw || "unknown"));
      return textResult("OPT " + op + " " + clip(r.result, 6000));
    },
  });

  // ------------------------- 无头 / 热会话 / 作业 -------------------------
  pi.registerTool({
    name: "blender_rt_headless",
    label: "无头 Blender",
    description:
      "【无头 Blender · 第一路径】独立进程跑脚本（blender -b）：不占 GUI 通道、不动你在看的场景。批量几何 / 校验 / 渲染都先走这里；" +
      '"看一眼"用 rt_do/rt_see。脚本里 print("HEADLESS " + json.dumps(obj)) 回传（**必须单行 JSON**）。' +
      "默认 --factory-startup + EEVEE 前导（engine=cycles/keep/none 可改）。**>100s 或长渲染直接 as_job=true**（用 rt_job op=wait/collect 收；超时≠失败）。" +
      "预载 runtime 模块用 preload（如 \"audit,qc_render\"）→ K.dsh_*_api。" +
      PARSE_HELP,
    parameters: S.obj({
      script: S.str("Python 源码（已注入持久内核 K + bpy/math/mathutils/Vector）"),
      script_file: S.str("直接跑一个 .py 文件；比 script= 省事"),
      file: S.str("要打开的 .blend（回执带 inputFile{size,mtime,md5}）；传 .py 自动当脚本"),
      outdir: S.str("产物目录；跑完列出新文件"),
      as_job: S.bool("true = 立刻后台化成作业（预期 >100s 推荐直接用）"),
      wait_s: S.num("as_job 之后最多再等几秒，到点回 jobId"),
      timeout_ms: S.int("子进程上限，默认 180000，上限 1800000"),
      engine: S.str("eevee（默认）| cycles | keep | none（纯 numpy/图像任务用 none 省 1-1.5s）"),
      preload: S.str('预载 runtime 模块（逗号分隔，如 "audit,qc,qc_render"）→ K.dsh_*_api'),
      shots: S.json("多视角一体化出图 [{name, from, look_at, lens, res, samples}]"),
      out_json: S.str("结构化结果落盘路径（>4KB 自动落 results/）"),
      env: S.json('子进程环境变量 {KEY:"VALUE"}'),
      args: S.str("追加到 -- 之后的命令行参数（脚本里读 sys.argv / K.args）"),
      workdir: S.str("脚本内 chdir + sys.path 首位"),
      factory_startup: S.bool("默认 true；false = 用用户启动文件与偏好"),
      use_user_config: S.bool("透传 BLENDER_USER_CONFIG/SCRIPTS 给无头进程（默认 false）"),
      bootstrap: S.bool("默认 true = 注入持久内核 K"),
      gpu: S.str("仅 cycles：auto | true（必须有 GPU 否则 ok=false）| false"),
      include_noise: S.bool("产物清单是否含 __pycache__/*.blend1 等噪音（默认 false）"),
    }),
    async execute(_id, args: any) {
      const err = await ready();
      if (err) return textResult(err);
      const runId = newRunId();
      const asJob = !!(args && args.as_job);
      const waitS = args?.wait_s !== undefined && args?.wait_s !== null && args?.wait_s !== "" ? Number(args.wait_s) : null;
      const body: any = {
        script: String(args?.script || ""),
        file: args?.file || undefined,
        outdir: args?.outdir || undefined,
        timeoutMs: args?.timeout_ms ? Number(args.timeout_ms) : undefined,
        factoryStartup: !(args && args.factory_startup === false),
        bootstrap: !(args && args.bootstrap === false),
        preload: args?.preload || undefined,
        gpu: args?.gpu || undefined,
        engine: args?.engine || undefined,
        useUserConfig: !!(args && args.use_user_config),
        includeNoise: !!(args && args.include_noise),
        workdir: args?.workdir || undefined,
        scriptFile: args?.script_file || undefined,
        env: args?.env && typeof args.env === "object" ? args.env : undefined,
        outJson: args?.out_json || undefined,
        shots: args?.shots || undefined,
        runId,
      };
      if (args && args.args) body.args = splitArgs(args.args);
      const serverBudget = 60000 + Number(body.timeoutMs || 180000);

      if (asJob) {
        // 直接后台化：op=start → 可选再等 wait_s
        const startBody = { ...body, op: "start", timeoutMs: body.timeoutMs || 3600000 };
        const r = await backendPost("/job", startBody, 60000);
        const lt = leasedText(r);
        if (lt) return textResult(lt);
        const j = r?.job || {};
        const id = String(j.id || runId);
        if (waitS && waitS > 0) {
          const w = await backendPost("/job", { op: "wait", id }, Math.min(600000, waitS * 1000) + 30000);
          const jw = w?.job || {};
          if (jw.status && jw.status !== "running") return textResult("JOB " + id + " 终态：" + clip(jw, 8000));
          return textResult("JOB " + id + " 仍在跑（wait 窗口 " + waitS + "s 到点，**不是失败**）。用 blender_rt_job op=wait id=" + id + " 继续等，或 op=collect 看进展");
        }
        return textResult("已后台化 job=" + id + "（pid " + String(j.pid || "?") + "）。用 blender_rt_job op=wait id=" + id + " 阻塞等结果，op=collect 看进展");
      }

      let res: any = null;
      try {
        res = await backendPost("/headless", body, Math.min(serverBudget, 102000));
      } catch (e: any) {
        // 客户端等待窗口到点 —— 服务端子进程仍在跑，按 runId 收
        return textResult(
          "客户端等待窗口到点（**不是失败**，服务端继续跑）。用 blender_rt_job(op=\"collect/wait\", id=\"" + runId + "\") 收结果。错误：" + String(e?.message || e),
        );
      }
      const lt = leasedText(res);
      if (lt) return textResult(lt);
      if (!res || res.error) return textResult("HEADLESS 失败 · " + String(res?.error || res?.raw || "unknown") + (res?.hint ? "\n" + String(res.hint) : ""));
      const bodyRes = res?.result && typeof res.result === "object" ? res.result : null;
      if (!bodyRes) return textResult("HEADLESS 结果缺字段 · HTTP " + String(res.__status) + "\n" + clip(res, 3000));
      const notes = Number(res.__heartbeats || 0) > 0 ? "\n（流式回执：" + String(res.__heartbeats) + " 条心跳）" : "";
      return textResult("HEADLESS ok · " + clip(bodyRes, 8000) + notes);
    },
  });

  pi.registerTool({
    name: "blender_rt_plan",
    label: "契约层/规划/验收",
    description:
      "【判定 / 验收 / 导出 / 造型】28 个 family · 183 个 op 都在这一个工具里。**不确定用哪个就先问目录：op=\"catalog\"**（本地直出，不占 Blender 往返；含「什么时候用 / 别用 / 最小骨架」）；" +
      "单族展开 op=\"catalog\", args={family:\"audit\"}；算子细节用各 family 的 <family>_help。" +
      "常用：audit_scene|audit_mesh（体检）· audit_gate（出厂门）· audit_interference（干涉）· qc_render_views（多视角对照）· qc_compare（IoU）· " +
      "sculpt_scan→setup→apply · fix_repair · uv_* · print_report（薄壁+悬垂）· sweep_* · deliver_export|verify · motion_*（机构/URDF）· " +
      "generator_save|run（程序即形状）· material_build|apply|bake · render_state|wait · gui_frame|gui_shading。" +
      "契约层（假设/区间/三态判定 supported/refuted/**unresolved**/destructive_guard/证据账本）是判定核心：两假设同样符合证据时判 unresolved 并给下一步探测，**永不瞎选**。" +
      "写 op 过写租约，只读 op（catalog/audit_*/qc_*…）豁免。op 名拼错回 did_you_mean。",
    parameters: S.obj(
      {
        op: S.str("契约 op 或 plan_<op>（op=help 出速查；op=catalog 出全目录）"),
        args: S.json('op 的参数对象，例如 {"cid":"joint","err":184,"tolerance":220,"identifiable":["dy"]}'),
        path: S.str("op=report 时的输出路径（Markdown）；省略则只回文本"),
      },
      ["op"],
    ),
    async execute(_id, argsIn: any) {
      const err = await ready();
      if (err) return textResult(err);
      const op = String((argsIn && argsIn.op) || "status");
      const payload = jsonPayload(argsIn?.args);
      if (!Object.keys(payload).length && argsIn && typeof argsIn.args === "string" && argsIn.args.trim() && argsIn.args.trim() !== "{}") {
        return textResult("PLAN " + op + " 失败 · args 不是合法 JSON 对象：" + String(argsIn.args).slice(0, 200));
      }
      if (op === "report" && argsIn?.path) payload.path = String(argsIn.path);
      const r = await backendPost("/plan", { op, args: payload }, 300000);
      const lt = leasedText(r);
      if (lt) return textResult(lt);
      if (!r || r.ok !== true) return textResult("PLAN " + op + " 失败 · " + String(r?.error || r?.raw || "unknown"));
      const res = r.result;
      const txt = typeof res === "string" ? res : JSON.stringify(res, null, 1);
      return textResult(
        "PLAN " + op + " ok · " + txt.length + " chars\n" +
          (txt.length > 12000 ? txt.slice(0, 12000) + "\n…[已截断，共 " + txt.length + " 字符；全量见后端 results/ 或 headless(outJson=…) 落盘]" : txt),
      );
    },
  });

  pi.registerTool({
    name: "blender_rt_worker",
    label: "热无头会话",
    description:
      "【热无头会话】常驻 blender -b 进程：start / exec（复用**同一个 Blender 会话与持久内核 K**）/ status / stop / restart / list。" +
      "**何时用（量化）**：同一脚本要跑 ≥3 次，或单次 >10s 且要反复迭代 —— 冷启动 1.1–1.5s + EEVEE 着色器编译最多 ~16s，worker 只付一次。" +
      "反之（一次性 / 要 GUI 上下文 / 要并行）继续用 headless。串行、无窗口：依赖 GUI 的 bpy.ops 可能失败。改了用户模块记得 purge_prefix。",
    parameters: S.obj(
      {
        op: S.str("start | exec | status | stop | restart | list"),
        name: S.str("实例名（默认 default）"),
        code: S.str("op=exec 的 Python 源码（预置 K/bpy/math/mathutils/Vector）"),
        timeout_ms: S.int("op=exec 的响应超时，默认 120000"),
        gpu: S.str("op=start 的 GPU 语义（仅 cycles）：auto / true / false"),
        engine: S.str("op=start 的渲染引擎：eevee（默认）/ cycles / keep"),
        purge_prefix: S.str("op=exec 前清掉的模块前缀（逗号分隔）"),
      },
      ["op"],
    ),
    async execute(_id, args: any) {
      const err = await ready();
      if (err) return textResult(err);
      const op = String((args && args.op) || "status");
      const body: any = { op };
      if (args && args.code !== undefined) body.code = String(args.code);
      if (args && args.timeout_ms) body.timeoutMs = Number(args.timeout_ms);
      if (args && args.gpu) body.gpu = String(args.gpu);
      if (args && args.engine) body.engine = String(args.engine);
      if (args && args.purge_prefix) body.purgePrefix = String(args.purge_prefix);
      if (args && args.name) body.name = String(args.name);
      const budget = 60000 + Number(body.timeoutMs || 120000);
      const r = await backendPost("/worker", body, budget);
      const lt = leasedText(r);
      if (lt) return textResult(lt);
      if (!r || r.ok !== true) {
        const rr = r?.result || {};
        const bits = ["WORKER " + op + " 失败 · " + String(r?.error || rr.error || "unknown")];
        if (rr.traceback) bits.push("--- traceback ---\n" + String(rr.traceback).slice(0, 2000));
        if (rr.stderr && String(rr.stderr).trim()) bits.push("stderr: " + String(rr.stderr).trim().slice(0, 1200));
        if (rr.stdout && String(rr.stdout).trim()) bits.push("stdout: " + String(rr.stdout).trim().slice(0, 800));
        return textResult(bits.join("\n"));
      }
      return textResult("WORKER " + op + " ok · " + clip(r.result, 6000));
    },
  });

  pi.registerTool({
    name: "blender_rt_job",
    label: "作业层",
    description:
      "【作业层】长活后台化：op=start 立刻返回 jobId（不占客户端连接、不会被工具超时掐断）；status / collect / **wait** / kill / list。" +
      "**wait 一次拿到结构化结果（默认 120s/次，上限 600s）—— 别连发 status**。" +
      "与 headless 分工：预期 <100s 用 headless 直接拿结果；更长 → headless as_job=true 或本工具 op=start。" +
      "run 与 job **同一 id 空间**：headless 的 run-… 也能用本工具收；日志落 <outdir>/jobs/<id>/。**客户端超时 ≠ 任务失败**，按 id 回收。",
    parameters: S.obj(
      {
        op: S.str("start | status | collect | wait | kill | list"),
        id: S.str("status/collect/wait/kill 的 id（job-… 或 headless 的 run-…）"),
        script: S.str("Python 源码（与 headless 同一套前导与结果契约）"),
        script_file: S.str("直接跑 .py 文件"),
        args: S.str("命令行参数（空格分隔或数组）"),
        env: S.json("额外环境变量 {KEY:\"VALUE\"}"),
        file: S.str("要打开的 .blend"),
        outdir: S.str("产物目录；日志在其 jobs/<id>/ 下"),
        timeout_ms: S.int("作业上限，默认 3600000；wait 时是本次等待上限（默认 120000，上限 600000）"),
        engine: S.str("eevee（默认）/ cycles / keep"),
        preload: S.str("预载 runtime 模块（逗号分隔）→ K.dsh_*_api"),
        factory_startup: S.bool("默认 true"),
        bootstrap: S.bool("默认 true = 注入持久内核 K"),
        workdir: S.str("脚本内 chdir + sys.path 首位"),
        include_noise: S.bool("产物清单是否含噪音文件（默认 false）"),
        out_json: S.str("结构化结果落盘路径"),
        tail: S.int("collect/wait 的 stdout/stderr 尾部字符数（默认 4000）"),
      },
      ["op"],
    ),
    async execute(_id, args: any) {
      const err = await ready();
      if (err) return textResult(err);
      const op = String((args && args.op) || "list");
      const body: any = { op };
      if (args && args.id) body.id = String(args.id);
      if (args && args.script !== undefined) body.script = String(args.script);
      if (args && args.script_file) body.scriptFile = String(args.script_file);
      if (args && args.args) body.args = splitArgs(args.args);
      if (args && args.env && typeof args.env === "object") body.env = args.env;
      if (args && args.file) body.file = String(args.file);
      if (args && args.outdir) body.outdir = String(args.outdir);
      if (args && args.engine) body.engine = String(args.engine);
      if (args && args.preload) body.preload = String(args.preload);
      if (args && args.workdir) body.workdir = String(args.workdir);
      if (args && args.out_json) body.outJson = String(args.out_json);
      if (args && args.include_noise !== undefined) body.includeNoise = !!args.include_noise;
      if (args && args.factory_startup !== undefined) body.factoryStartup = !!args.factory_startup;
      if (args && args.bootstrap !== undefined) body.bootstrap = !!args.bootstrap;
      if (args && args.tail) body.tail = Number(args.tail);
      if (args && args.timeout_ms) body.timeoutMs = Number(args.timeout_ms);
      const budget = op === "wait" ? Math.min(600000, Number(args?.timeout_ms) || 120000) + 30000 : 60000;
      const r = await backendPost("/job", body, budget);
      const lt = leasedText(r);
      if (lt) return textResult(lt);
      if (!r || r.ok !== true) return textResult("JOB " + op + " 失败 · " + String(r?.error || r?.raw || "unknown"));
      return textResult("JOB " + op + " " + clip(r, 8000));
    },
  });

  pi.registerTool({
    name: "blender_rt_txn",
    label: "事务/回滚",
    description:
      "【事务 / 回滚】两级快照：**文件级** snapshot/restore（整场景回退；写 .blend 副本，不改当前 filepath；300 对象实测约 97MB / 0.8s）+ **对象级** mark/revert（transform / 材质槽 / 可见性 / 修改器开关，毫秒级）。" +
      "⚠ 边界：对象级**不含拓扑/UV/顶点级改动** —— Boolean、合并、删面之后回不去（revert 会跳过并报告），那种回滚用文件级 snapshot/restore（restore 丢当前未保存状态）。破坏性操作前先 snapshot。",
    parameters: S.obj(
      {
        op: S.str("snapshot | restore | list | prune | mark | revert | marks | drop | help"),
        label: S.str("快照 / mark 的名字（snapshot 省略则用时间戳）"),
        objects: S.str("mark 时限定对象（逗号分隔；省略 = 全场景）"),
        keep: S.int("prune 只保留最近 N 个快照，默认 5"),
        note: S.str("snapshot 备注"),
      },
      ["op"],
    ),
    async execute(_id, args: any) {
      const err = await ready();
      if (err) return textResult(err);
      const op = String((args && args.op) || "list");
      const a: any = {};
      if (args && args.label) a.label = String(args.label);
      if (args && args.note) a.note = String(args.note);
      if (args && args.keep) a.keep = Number(args.keep);
      if (args && args.objects) a.objects = String(args.objects).split(",").map((s) => s.trim()).filter(Boolean);
      const r = await backendPost("/txn", { op, args: a }, 300000);
      const lt = leasedText(r);
      if (lt) return textResult(lt);
      if (!r || r.ok !== true) return textResult("TXN " + op + " 失败 · " + String(r?.error || r?.raw || "unknown"));
      return textResult("TXN " + op + " ok · " + clip(r.result, 6000));
    },
  });

  pi.registerTool({
    name: "blender_rt_preset",
    label: "参数配方库",
    description:
      "【配方库】把「参数组合」变成可保存、可套用、可分发的资产：save / list / get / apply / delete / export / import / help。" +
      'data 用点路径表达：材质节点 {"inputs.Base Color": [1,0,0,1]}、对象属性 {"location": [0,0,1]}、场景设置 {"render.resolution_x": 640}。' +
      "apply 的 targets 用 MAT:材质名 / OBJ:对象名 / SCENE（逗号分隔）；不给 targets 只预览。export/import 走单个 JSON bundle。",
    parameters: S.obj(
      {
        op: S.str("save | list | get | apply | delete | export | import | help"),
        name: S.str("配方名（save / get / apply / delete）"),
        kind: S.str("分类（list 可按 kind 过滤），如 material / object / scene"),
        tags: S.str("标签（逗号分隔）"),
        note: S.str("备注（save）"),
        data: S.str('点路径 JSON 字符串（save），如 {"inputs.Roughness": 0.4}'),
        targets: S.str("apply 目标（逗号分隔）：MAT:材质名 / OBJ:对象名 / SCENE"),
        path: S.str("export 输出路径 / import 输入路径"),
        names: S.str("export 选定的配方名（逗号分隔；省略=全部）"),
        overwrite: S.bool("save/import 是否覆盖同名（默认 true）"),
      },
      ["op"],
    ),
    async execute(_id, args: any) {
      const err = await ready();
      if (err) return textResult(err);
      const op = String((args && args.op) || "list");
      const a: any = {};
      if (args && args.name) a.name = String(args.name);
      if (args && args.kind) a.kind = String(args.kind);
      if (args && args.note) a.note = String(args.note);
      if (args && args.path) a.path = String(args.path);
      if (args && args.tags) a.tags = String(args.tags).split(",").map((x) => x.trim()).filter(Boolean);
      if (args && args.names) a.names = String(args.names).split(",").map((x) => x.trim()).filter(Boolean);
      if (args && args.targets) a.targets = String(args.targets).split(",").map((x) => x.trim()).filter(Boolean);
      if (args && args.data) {
        try {
          a.data = JSON.parse(String(args.data));
        } catch (e: any) {
          return textResult("data 不是合法 JSON: " + String(e?.message || e).slice(0, 120));
        }
      }
      if (args && args.overwrite === false) a.overwrite = false;
      const r = await backendPost("/preset", { op, args: a }, 300000);
      const lt = leasedText(r);
      if (lt) return textResult(lt);
      if (!r || r.ok !== true) return textResult("PRESET " + op + " 失败 · " + String(r?.error || r?.raw || "unknown"));
      return textResult("PRESET " + op + " ok · " + clip(r.result, 6000));
    },
  });

  // ------------------------- 便利命令 -------------------------
  pi.registerCommand("blender", {
    description: "Blender 通道快捷操作：/blender doctor|status|see|launch|stop",
    handler: async (args, ctx) => {
      const sub = String(args || "doctor").trim();
      try {
        if (sub === "see") {
          const f = await fetchFrame(560);
          const ui = ctx.ui as any;
          if (typeof ui.showImage === "function") await ui.showImage(f.png.toString("base64"));
          ctx.ui.notify("视口帧 " + f.ms + "ms · hash " + f.hash + (typeof ui.showImage === "function" ? "" : "（TUI 不支持内联出图，用 blender_rt_see 工具看）"), "info");
          return;
        }
        if (sub === "launch") {
          const body: any = {};
          const exe = detectBlenderExe();
          if (exe) body.exe = exe;
          const r = await backendPost("/launch", body, 120000);
          ctx.ui.notify(r?.ok ? "LAUNCH ok（addon 端口 " + String(r.addonPort) + "）" : "LAUNCH 未成功：" + String(r?.error || "?"), r?.ok ? "info" : "error");
          return;
        }
        if (sub === "stop") {
          paused = true;
          try {
            const who = await backendGet("/health", 1500);
            if (who?.backend?.pid) process.kill(Number(who.backend.pid));
          } catch {
            /* ignore */
          }
          ctx.ui.notify("后端已停止（blender_viewport op=start 恢复）", "info");
          return;
        }
        const path = sub === "status" ? "/status" : "/doctor";
        const d = await backendGet(path, 60000);
        ctx.ui.notify(path + " → " + String(d?.kind || d?.ok || "?"), "info");
      } catch (e: any) {
        ctx.ui.notify("/blender " + sub + " 失败：" + String(e?.message || e), "error");
      }
    },
  });
}

/** 后端不可用时的统一指引 */
function BACKEND_HELP(p: number, isPaused: boolean): string {
  if (isPaused) return "后端已被手动停止（blender_viewport op=stop）。要恢复：blender_viewport op=start";
  return (
    "后端不可用（127.0.0.1:" +
    String(p) +
    "）。排查：① blender_viewport op=start 起后端；② 起不来 = 缺上游 runtime → 运行 scripts/install-runtime（或设 PI_BLENDER_RT_RUNTIME 指向 dsh-blender-plugin 仓库）；③ node ≥ 20。"
  );
}
