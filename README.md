# Win7 轻量化定时提醒器

专为 Windows 7 系统打造的**零重型依赖**定时提醒工具：后台静默运行，通过本地网页图形化配置定时规则，到点用系统右下方原生气泡提醒你。

## 功能特性

- 后台 Node.js 服务常驻运行
- **全图形化定时配置**：秒 / 分 / 时 / 日 / 月 / 周 六个维度图形化选择，无需手写 cron 表达式
- **接下来 5 次触发时间**实时预览：随配置变化即时计算，按「今天 / 明天 / 后天 / 日期」友好展示
- 预览与后台调度使用同一套 node-cron 语义，支持区间、步长、列表与英文月/周名
- 原生系统右下角气泡通知
- **独立全局设置页**（http://localhost:28765/config）：静音、气泡时长、补提醒开关与回溯时长、端口热切换、开机自启、**启动时最小化到托盘**
- **系统托盘驻留**：打包 exe 启动后隐藏控制台，只在通知区保留图标；双击打开提醒配置，右键可打开设置或退出（可在全局设置页关闭）
- 数据全量本地 JSON 持久化（原子写入，断电不损坏）
- 支持秒级精度 cron 调度

## 快速开始

```bash
npm install
npm start
```

启动后在浏览器访问 <http://localhost:28765> 配置提醒，<http://localhost:28765/config> 为全局设置页（主页面「全局设置」按钮与设置页「提醒配置」按钮在当前标签页内互跳）。

## 生成测试数据（可选）

```bash
node test-init.js
```

会写入 3 条测试提醒（会覆盖当前提醒数据）。

## 校验全局配置是否真的在后端生效

```bash
npm run test:config
```

脚本会在临时目录起独立实例（随机端口、数据与正式环境隔离），逐项验证静音、气泡时长、补提醒开关、回溯时长、端口热切换、开机自启、托盘助手启停与生命周期是否真实生效，结束后自动清理。

只验证打包产物时改用 `npm run test:config:exe`，同一套 72 项检查直接跑在 `dist/reminder-server.exe` 上。

前端触发时间预览单独校验：

```bash
npm run test:preview
```

从 `public/index.html` 提取 `CronPreview` 计算块，在 Node 中验证 37 项 cron 用例（含区间、步长、英文月/周名、闰年、无触发组合等）。

## 打包为单文件 exe

```bash
npm run build
```

产物输出到 `dist/reminder-server.exe`（基于 Node 16、原生兼容 Windows 7）。打包后的 exe 默认启动即最小化到系统托盘并隐藏控制台，可在全局设置页关闭该行为。

## 项目结构

```
server.js            后端服务（调度 + 通知 + 持久化 + API + 托盘管理）
assets/tray.ps1      托盘助手（Win7 自带 PowerShell 2.0 + NotifyIcon）
public/index.html    提醒配置主页面（单文件前端，含触发时间预览引擎）
public/config.html   全局设置页（单文件前端）
public/cron-editor.js/.css  6 维度图形化 Cron 编辑器
产品设计原型文档.md   完整产品设计与路线图
AGENTS.md            AI / 开发者项目上下文说明
package.json         依赖与打包配置
```

## 文档

- 完整产品设计与分优先级路线图（P0~P3）：[产品设计原型文档.md](./产品设计原型文档.md)
- 项目上下文与开发约定：[AGENTS.md](./AGENTS.md)