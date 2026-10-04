# pi-blender-rt

> 让 **pi** 的模型直接驱动 **Blender** —— 15 个实时工具：看视口 · 改场景 · 时间窗观察 · 内环搜索 · 无头卸载 · 事务回滚 · 契约层验收。
>
> 本仓库是 [sixtysevenlf/dsh-blender-plugin](https://github.com/sixtysevenlf/dsh-blender-plugin)（DSH 宿主）的 **pi 扩展移植**：上游 runtime 原样复用，本仓库只做 pi 的 ExtensionAPI 适配层。

## 它解决什么

AI 建模的四个根本短板：**看不清、改了不知道结果、无法验证对错、无法撤销**。

- **看得清**：`blender_rt_see` 一帧 55–160 ms；任意角度渲染（不建相机、不动用户视口）；空帧自诊断会直接建议机位。
- **改了立刻验**：`blender_rt_do` 一次调用 = 跑 Python + 回帧（约 105 ms）。
- **验证有判据**：`blender_rt_plan` 契约层（28 families / 183 ops）：干涉体积（mm³ + 95% CI）、装配间隙 gate、IoU 对照、三态裁决 `supported / refuted / unresolved`——两假设同样符合证据时判 `unresolved` 并给下一步探测，**永不瞎选**。
- **敢动手**：事务回滚（`blender_rt_txn`）、破坏性操作守卫、写租约（多会话不互踩）、dry_run 默认开。
- **省 token**：内环搜索 `blender_rt_loop` 在 Blender 里跑几千次迭代（**零模型轮次**）；同画面帧去重不重复附图；工具描述三级渐进披露（工具 → catalog 族 → `_help` 算子）。

## 架构

```
pi 模型 ── 15 tools ──▶ 本扩展（index.ts，HTTP 适配）
                            │ 127.0.0.1:9877（后端 runtime/server.mjs，来自 vendor/dsh-blender-plugin）
                            ▼
                    "MCP for Blender" addon ◀── TCP 9876 ──▶ Blender 4.x/5.x GUI
                                                              （/launch 一键拉起并自动 Connect）
```

DSH 只是上游的宿主壳；真正干活的后端 `runtime/server.mjs` 只依赖 Node 内置模块，可脱离 DSH 独立运行 —— 这正是本移植可行的原因。

## 前置条件

1. **Blender 4.x / 5.x**（GUI 模式；无头工具才用 `-b`）
2. **`MCP for Blender` addon**（不随本仓库分发）装进 Blender 的 `scripts/addons/`（如 `blender_mcp.py`，ahujasid/blender-mcp 血统，v1.6/v1.7 均可）
3. **Node.js ≥ 20**、**git**（首次引导 clone 上游 runtime 用）
4. pi（本扩展按 `ExtensionAPI` 编写）

## 安装

```bash
pi install git:github.com/stollor/pi-blender-rt      # 装进 pi 的包目录
```

首次调用任意工具时会自动 `git clone` 上游 runtime 到包内 `extensions/vendor/`（也可手动：`scripts/install-runtime.ps1` / `.sh`）。上游 runtime 也可以用环境变量 `PI_BLENDER_RT_RUNTIME` 指向已有的 dsh-blender-plugin 仓库来复用。

### 验收（唯一判据，不可妥协）

```
blender_viewport(op="doctor")   # 必须返回 kind=ok
blender_rt_see(max_size=560)    # 必须回一帧图（而不是报错文本）
```

`doctor` 非 `ok` 就是**没装好**，按返回的三级诊断修（见下表）。

### 首次使用三步

```
blender_viewport(op="launch")                        # 一键拉起 GUI Blender 并自动 Connect addon（幂等）
blender_viewport(op="doctor")                        # 体检：kind=ok 才算通
blender_rt_see(from="9,-9,6", look_at="0,0,1")       # 换个角度看看（不动物体、不动用户视口）
```

## 15 个工具

| 工具 | 干什么 | 典型延迟 |
|---|---|---|
| `blender_viewport` | 通道运维：status / doctor / who / lease / release / start / stop / restart / **launch** | 健康 70–100 ms |
| `blender_rt_see` | 看视口；任意角度渲染；整窗截图；同画面去重 | 50–280 ms |
| `blender_rt_do` | 跑 Python（或 .py），可选立刻回帧；持久内核 `K` | ≈105 ms |
| `blender_rt_watch` | 时间窗采样：判断「动没动、对不对」 | ≤6 帧/次 |
| `blender_rt_loop` | **内环搜索**：几千次迭代、零模型轮次 | 160 ticks/s |
| `blender_rt_cmd` / `blender_rt_commands` | addon 命令直连（34 个）/ 清单 | 25–55 ms |
| `blender_rt_perf` | 渲染性能剖析 + 预设（实测 14.6s → 0.79s） | analyze 10–20 s |
| `blender_rt_opt` | 对象安全合并（几何零损失；dry_run 默认开） | ≈1.4 ms/对象 |
| `blender_rt_headless` | 无头 `blender -b`（重活第一路径） | 冷启动 0.9–1.2 s |
| `blender_rt_plan` | 契约层 / 规划器 / 验收 / 交付（28 families · 183 ops） | BVH 0.17 ms/对 |
| `blender_rt_worker` | 热无头会话（复用同一 Blender + 内核 `K`） | 冷启动只付一次 |
| `blender_rt_txn` | 事务回滚：文件级 snapshot / 对象级 mark→revert | 300 对象 824 ms |
| `blender_rt_preset` | 参数配方库（保存 / 套用 / 导出） | — |
| `blender_rt_job` | 长活后台化（超时 ≠ 失败，按 id 回收） | — |

**不知道用哪个 op？** `blender_rt_plan(op="catalog")` —— 本地直出、不占 Blender 往返，每个族都写明「什么时候用 / 别用 / 最小骨架」。

## 与上游的差异

- 宿主从 DSH 换成 pi：工具 schema 直接用 JSON Schema（不引 schemastery/typebox 依赖）。
- 后端看护从「15s 定时器」改成**惰性自愈**：每次工具调用前探活，后端不在就自动拉起（`op=stop` 后尊重用户意图不拉起）。
- headless 的「超时转 job」语义保留：客户端等待窗口到点返回 `run-…` 句柄，用 `blender_rt_job` 收结果。
- 帧去重、560px 默认、渐进披露等省 token 设计全部保留。
- 完整的人话回执格式化做了简化（结构化 JSON 回执直接给全，超长截断并注明）。

## 仓库布局

```
pi-blender-rt/
├── src/index.ts          # 唯一事实源（TypeScript）
├── extensions/index.js   # 生成物（交付入口，已提交，`npm run build` 重新生成）
├── scripts/build.mjs     # src/index.ts → extensions/index.js（Node 内置类型剥离）
├── scripts/install-runtime.*  # 手动 vendor 上游 runtime（可选，首次调用也会自动引导）
└── extensions/vendor/    # 自动引导 clone 的上游 dsh-blender-plugin（gitignore）
```

**为什么交付 `.js` 而不是 `.ts`**：pi 的包加载管线转译 TS 时会触发 Bun(JSC) 的确定性崩溃
（`panic: index out of bounds`；同一文件用 `pi --extension` 直载完全正常，属上游 bug，已在
README 记录以便复现）。交付 `stripTypeScriptTypes` 生成的 `.js` 绕开该转译路径；工具行为与上游一致。

## 首次调用的小提示

- 首次调用会引导 clone 上游 + 启动后端，比平时慢几秒（后续调用毫秒级）。
- 模型并行发多个工具调用时，首个调用可能在后端就绪前撞上一次连接失败 —— 重试一次即可（引导已做并发去重）。

## 配置（环境变量）

| 变量 | 含义 | 默认 |
|---|---|---|
| `PI_BLENDER_RT_PORT` | 后端端口 | 9877 |
| `PI_BLENDER_RT_RUNTIME` | 上游 runtime 位置（目录 / server.mjs 皆可） | `vendor/dsh-blender-plugin` |
| `PI_BLENDER_RT_NO_BOOTSTRAP` | 置 1 关闭自动 clone 上游 | 未设 |
| `DSH_BLENDER_EXE` | blender 可执行文件 | 自动探测（含 `%LOCALAPPDATA%\Tools\blender` 等非标准位） |
| `DSH_BLENDER_ADDON_HOST/PORT` | addon 端口 | 127.0.0.1:9876 |

## 排障（三级诊断）

| 症状 | 处置 |
|---|---|
| 后端不可用 | `blender_viewport(op="start")`；仍不行 = 缺 runtime → `scripts/install-runtime` |
| `blender-unreachable` | `blender_viewport(op="launch")`（一键拉起 + 自动 Connect） |
| `main-thread-busy` | 等它空下来，或改走 `blender_rt_headless` |
| 写操作 409 `leased` | 别的会话持有写租约 → `blender_viewport(op="who")`；确要抢 → `op=lease force=true` |
| 图没回来 / 帧空白 | 同画面去重了（传 `force=true` 重发）；空帧会自带建议机位 |
| 长任务没结果 | **不是失败** —— `blender_rt_job(op="collect"/"wait", id="run-…")` 回收 |

## 安全

- 后端只绑 `127.0.0.1`，**不要**公网暴露。
- `blender_rt_do` 的 `execute_code` 是在 Blender 进程里跑任意 Python 的逃生门，只在可信环境使用。

## License 与致谢

- 本扩展（pi 适配层）：MIT。
- 上游运行时 [dsh-blender-plugin](https://github.com/sixtysevenlf/dsh-blender-plugin)：BSD-3-Clause，由 `scripts/install-runtime` 自动 clone，不随本仓库分发。
- Blender 侧 addon `MCP for Blender`（[ahujasid/blender-mcp](https://github.com/ahujasid/blender-mcp) 血统）：不随本仓库分发，请自行获取并遵守其许可证。
