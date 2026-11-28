# AGENTS.md — Win7 轻量定时提醒器 · 项目上下文

> 本文档是 AI 在每次会话开始时快速了解本项目的权威入口。
> 请优先信任本文件，只有在本文件过时或与代码冲突时才去扫描源码。
> 完整产品规格与路线图见同目录 `产品设计原型文档.md`。

## 一句话定位
专为 Windows 7 打造的零重型依赖、秒级精度的定时提醒工具：后台 Node.js 服务常驻，通过本地 Web 页面图形化配置定时规则，到点用系统原生气泡通知提醒。

## 快速上手
```bash
npm install        # 依赖：lodash、node-cron、node-notifier（devDependencies: pkg）
npm start          # 启动服务，配置页 http://localhost:28765
node test-init.js  # 可选：生成 3 条测试提醒数据
npm run test:config        # 源码模式跑全局配置/托盘生效性检查
npm run test:config:exe    # 同一套检查跑打包后的 exe
npm run test:preview       # 校验前端「接下来 5 次触发时间」计算
npm run build      # pkg 打包为单文件 dist/reminder-server.exe（node16-win-x64）
```

## 架构与关键文件
| 文件 | 职责 | 改动注意 |
|------|------|----------|
| `server.js` | 后端：HTTP 服务 + node-cron 调度 + node-notifier 通知 + 本地 JSON 持久化 + 托盘助手管理 | 只认知 `cronExpr` 字符串并调度；数据/API 契约见下 |
| `public/index.html` | 提醒配置主页面（原生 HTML/CSS/JS，单文件） | **必须保持单文件**，见「核心约定」 |
| `public/config.html` | 全局设置页（静音/时长/补提醒/端口/自启/托盘），与主页面在当前标签页内互跳 | 同样是单文件前端，路由见 `server.js` |
| `public/cron-editor.js/.css` | 6 维度图形化 Cron 编辑器（历史例外，不新拆文件） | 改表达式生成规则时要同步 `setValue` 回填与预览 |
| `assets/tray.ps1` | 托盘助手：PowerShell 2.0 + WinForms NotifyIcon，负责隐藏控制台、托盘菜单、退出 | 必须保持 PS2 兼容；经 pkg assets 打进 exe，运行时释放到临时目录 |
| `产品设计原型文档.md` | 完整产品设计 + 分优先级路线图（P0~P3） | 权威规格来源 |
| `package.json` | 依赖、scripts、pkg 打包配置（assets 含 public、assets 与 notifu.exe） | Win7 打包用 node16 目标 |
| `test-init.js` | 一次性写入 3 条测试提醒 | 会覆盖 `data/reminders.json` |
| `test-cron-preview.js` | 从 `index.html` 提取预览引擎并校验与 node-cron 一致 | 改预览算法/标记块时同步维护 |
| `data/*.json` | 运行时数据，已被 `.gitignore` 忽略 | 首次运行自动生成 |

## 核心约定（改动前必读）

### 1. 前端必须是单文件 `public/index.html`
`server.js` 显式服务 `GET /`、`GET /index.html`（主页面）和 `GET /config`、`GET /config.html`（全局设置页），并兜底服务 `public/` 下已存在的静态文件与 `node_modules/` 资源。
- 新增前端逻辑仍内联到对应页面，**不要**新建独立 .js/.css（`cron-editor.js/.css` 为历史例外）。
- 新增页面必须同步在 `server.js` 加路由（如 `/config`），否则访问会 404。

### 2. cron 表达式格式（6 段、含秒）
node-cron 使用 6 段：`秒 分 时 日 月 周`（周：0 或 7 = 周日，1=周一 … 6=周六）。
常用示例：
- `0 */30 * * * *` 每 30 分钟
- `0 0 * * * *` 每小时整点
- `0 0 9 * * *` 每天 09:00
- `0 0 18 * * 1-5` 工作日 18:00
- `0 30 9 * * 1` 每周一 09:30
- `*/30 * * * * *` 每 30 秒

### 3. 提醒数据结构（`data/reminders.json`，数组）
```json
[
  { "id": "rem_xxx", "name": "喝水提醒", "cronExpr": "0 */30 * * * *",
    "content": "该站起来喝杯水啦", "enabled": true }
]
```
说明：`id` 由后端 `_.uniqueId('rem_')` 生成；`enabled` 控制是否调度。
提醒还带 `lastFiredTimestamp`、`lastCatchupTimestamp`（关机补提醒基准，缺省/异常时由 `migrateReminderFields` 修复）与 `jumpUrl`（通知点击跳转地址）。

### 3.1 全局配置字段（`data/config.json`）
`muted`、`notificationDuration`（1-60 秒）、`maxCatchupHours`（1-168）、`webPort`（1024-65535）、`autoStart`、`enableCatchupCheck`、`startMinimizedToTray`（默认 `true`）。
新增字段必须同步：`DEFAULT_CONFIG` → `normalizeConfig` → `config.html` 表单/`LIMITS` → `test-config.js` 断言。

### 4. API 契约
- `GET  /api/config` → 返回全局配置 + `runtime`（实际监听端口、是否打包 exe、注册表自启状态、`traySupported/trayActive/trayPid/trayError`）
- `POST /api/config` → 合并写入并归一化（数值夹范围、字符串转布尔）；端口热切换、自启即时写注册表、托盘即时启停；端口切换失败自动回滚。响应里的 `applied` 含 `port / autoStart / tray` 三块，`applied.tray` 会带 `ok / changed / active / pid / restarted`
- `GET  /api/reminders` → 返回提醒数组
- `POST /api/reminders` → 有 `id` 时编辑、无 `id` 时新增；含 `enabled` 时按需 start/stop 调度
- `DELETE /api/reminders/:id` → 删除并停止调度
- 数据写入形如原子化：先写 `.tmp` 再 rename（已有实现）

### 5. 图形化配置与 `cronExpr` 必须可互相转换
前端使用 `public/cron-editor.js` 的 6 维度（秒/分/时/日/月/周）标签页编辑器，**存储/调度仍以 `cronExpr` 字符串为准**。
- `parsePart()`：面板状态 → 6 段 cron；`setValue() / setPart()`：cron → 面板回填（5 段表达式会自动补秒 0）
- 改编辑器时必须保证 round-trip 不丢语义；`*/n` 的实际含义由 node-cron 决定（保留能被 n 整除的值），不要按标准 cron 的“起点 + 步长”想当然
- 提醒列表/编辑回填只认 `cronExpr`，前端不做二次存储
- 图形编辑器无法无损表示的写法（英文月/周名、星期区间、带步长的区间等）会保留文本框并收起编辑器（`canEditorRepresent()` + `cronEditorWarning`），避免被归一化成错误规则；预览仍按原文计算

### 6. 零重型依赖原则
前端零框架、不引入 cron-parser 等库。「接下来 5 次触发时间」由 `index.html` 内自写的 `CronPreview` 纯 JS 实现（`CRON_PREVIEW_START/END` 标记块），支持 `*`、区间、步长、列表、英文月/周名，最多向后搜索 50 年；其语义必须与 node-cron 保持一致，由 `npm run test:preview` 校验。新增依赖需评估体积与 Win7 兼容性。

### 7. Windows 7 兼容约束
- 打包目标 `node16-win-x64`（Node 16 是最后原生支持 Win7 的版本）。
- 不使用 Win8+ 专属 API；通知走 `node-notifier` 的 vendor notifu.exe。
- 数据默认放程序同级目录，避免 UAC 虚拟重定向。

### 8. 托盘驻留实现（`assets/tray.ps1`）
- 托盘不是原生模块，而是 **PowerShell 2.0 + `System.Windows.Forms.NotifyIcon`** 助手进程（Win7 自带，零额外依赖）。
- pkg 快照里的 ps1 不能直接执行：`server.js` 启动时把它释放到 `%TEMP%\win7-tiny-reminder-tray\tray.ps1`（补 UTF-8 BOM，否则 PS2 按 ANSI 解析中文会报错），再 `spawn('powershell.exe', ['-File', ...])`。
- **禁止**给 spawn 加 `detached: true`，也不要用 `-WindowStyle Hidden`：实测 DETACHED_PROCESS 下 PowerShell 会直接退出而不执行脚本；`-WindowStyle Hidden` 会连源码模式的控制台一起藏掉。隐藏控制台由 ps1 内 `AttachConsole + ShowWindow(SW_HIDE)` 完成。
- 隐藏控制台只在 `process.pkg`（打包 exe）且控制台里只有「服务进程 + 托盘助手」时执行；从 cmd/终端启动（共享控制台）会自动跳过，避免把用户终端藏掉。
- 生命周期：配置开关即时启停；端口热切换会重启助手以更新菜单链接；助手每 1 秒检测主进程是否存活，主进程退出（含被强杀）后自行消失；正常停止通过独享的 `.stop` 标记文件，8 秒未退出才强杀（给恢复控制台留时间）。
- 关闭托盘时 `.stop` 里写 `show`，助手退出前会把之前隐藏的控制台重新显示（否则设置页关掉托盘后控制台会一直藏着）；其他停止场景写 `stop`。
- 托盘菜单：打开提醒配置（`/`）、全局设置（`/config`）、退出程序（结束服务进程）；双击图标打开提醒配置。
- 测试隔离：`REMINDER_TRAY_DISABLE=1` 时 `startTray` 直接返回 skipped；`test-config.js` 默认给所有临时实例加这个变量，只有托盘用例显式传 `0`。

## 当前实现状态（对照路线图）
- ✅ P0 核心：服务常驻、秒级调度、原生通知、JSON 持久化、增删改查、pkg 打包。
- ✅ v2.0 图形化定时配置：6 维度标签页编辑器（`*` / 区间 / 步长 / 多选），并实时显示「接下来 5 次触发时间」（37 项断言，`npm run test:preview`）。
- ✅ v3.0 全局设置页：静音、气泡时长、补提醒开关与回溯时长、端口热切换、开机自启，全部字段后端真实读取并生效。
- ✅ v3.1 启动时最小化到系统托盘：`startMinimizedToTray` 默认开启；配置页即时启停，打包 exe 启动后隐藏控制台、双击/右键菜单可用，端口切换自动更新链接，主进程退出后助手自行清理。源码与 exe 各覆盖 72 项断言（`npm run test:config` / `npm run test:config:exe`）。
- ⏳ 待办（详见 `产品设计原型文档.md` 第六~十节）：历史记录、提示音、「稍后提醒」、托盘图标随静音变灰（P2）等。