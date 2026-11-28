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
npm run build      # pkg 打包为单文件 dist/reminder-server.exe（node16-win-x64）
```

## 架构与关键文件
| 文件 | 职责 | 改动注意 |
|------|------|----------|
| `server.js` | 后端：HTTP 服务 + node-cron 调度 + node-notifier 通知 + 本地 JSON 持久化 | 只认知 `cronExpr` 字符串并调度；数据/API 契约见下 |
| `public/index.html` | 提醒配置主页面（原生 HTML/CSS/JS，单文件） | **必须保持单文件**，见「核心约定」 |
| `public/config.html` | 全局设置页（静音/时长/补提醒/端口/自启），与主页面在当前标签页内互跳 | 同样是单文件前端，路由见 `server.js` |
| `产品设计原型文档.md` | 完整产品设计 + 分优先级路线图（P0~P3） | 权威规格来源 |
| `package.json` | 依赖、scripts、pkg 打包配置（assets 含 public 与 notifu.exe） | Win7 打包用 node16 目标 |
| `test-init.js` | 一次性写入 3 条测试提醒 | 会覆盖 `data/reminders.json` |
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
路线图规划新增字段（未实现）：`lastFiredTimestamp`、`lastCatchupTimestamp`（关机补提醒用）。

### 4. API 契约
- `GET  /api/config` → 返回全局配置 + `runtime`（实际监听端口、是否打包 exe、注册表自启状态）
- `POST /api/config` → 合并写入并归一化（数值夹范围、字符串转布尔）；端口热切换、自启即时写注册表，失败自动回滚
- `GET  /api/reminders` → 返回提醒数组
- `POST /api/reminders` → 有 `id` 时编辑、无 `id` 时新增；含 `enabled` 时按需 start/stop 调度
- `DELETE /api/reminders/:id` → 删除并停止调度
- 数据写入形如原子化：先写 `.tmp` 再 rename（已有实现）

### 5. 图形化配置与 `cronExpr` 必须可互相转换
前端已把原来的 cron 文本输入替换为 6 维度图形化配置（秒/分/时/日/月/周），但**存储/调度仍以 `cronExpr` 字符串为准**。
- `buildExpr()`：表单状态 → 6 段 cron
- `parseExprToForm(expr)`：6 段 cron → 表单状态（编辑回填用）
- 改其中一方必须保证**双向 round-trip 一致**（模板/反解析用例见 `index.html` 内 `TEMPLATES` 与 `parseDim`）。

### 6. 零重型依赖原则
前端零框架、不引入 cron-parser 等库（「最近 5 次触发预览」用自写的 `nextCronDate()` 纯 JS 实现）。新增依赖需评估体积与 Win7 兼容性。

### 7. Windows 7 兼容约束
- 打包目标 `node16-win-x64`（Node 16 是最后原生支持 Win7 的版本）。
- 不使用 Win8+ 专属 API；通知走 `node-notifier` 的 vendor notifu.exe。
- 数据默认放程序同级目录，避免 UAC 虚拟重定向。

## 当前实现状态（对照路线图）
- ✅ P0 核心：服务常驻、秒级调度、原生通知、JSON 持久化、增删改查、pkg 打包。
- ✅ v2.0 图形化定时配置（本次已完成）：6 维度下拉、日期/星期互斥、5 模板、最近 5 次触发预览。
- ✅ v3.0 全局设置页：静音、气泡时长、补提醒开关与回溯时长、端口热切换、开机自启，全部字段后端真实读取并生效（`test-config.js` / `npm run test:config` 覆盖 42 项断言）。
- ⏳ 待办（详见 `产品设计原型文档.md` 第六~十节）：系统托盘驻留、历史记录、提示音、「稍后提醒」。