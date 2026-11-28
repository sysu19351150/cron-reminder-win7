const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec, execSync, spawn } = require('child_process');
const _ = require('lodash');
const cron = require('node-cron');
const notifierLib = require('node-notifier');
const os = require('os');

// 数据文件路径：打包成 exe 后 __dirname 指向只读快照，运行时数据统一放到 exe 同级目录
// REMINDER_DATA_DIR 仅用于自动化测试时把数据隔离到临时目录
const APP_DIR = process.pkg ? path.dirname(process.execPath) : __dirname;
const DATA_DIR = process.env.REMINDER_DATA_DIR
  ? path.resolve(process.env.REMINDER_DATA_DIR)
  : path.join(APP_DIR, 'data');
const DATA_PATH = path.join(DATA_DIR, 'reminders.json');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const ICON_PATH = path.join(APP_DIR, 'assets', 'icon.png');
const DEFAULT_PORT = 28765;

// 全局配置默认值：新增字段时同步补到这里
const DEFAULT_CONFIG = {
  muted: false,
  notificationDuration: 5,
  maxCatchupHours: 48,
  webPort: DEFAULT_PORT,
  autoStart: false,
  enableCatchupCheck: true,
  // 启动后最小化到系统托盘（打包 exe 时隐藏控制台窗口，只在通知区保留图标）
  startMinimizedToTray: true
};

// 数值型配置的取值范围，前端配置页与后端校验共用同一套口径
const CONFIG_LIMITS = {
  notificationDuration: { min: 1, max: 60 },
  maxCatchupHours: { min: 1, max: 168 },
  webPort: { min: 1024, max: 65535 }
};

// 图标文件存在时才传给通知器（Win7 的 notifu 对不存在的图标路径会报错）
function getIconOption() {
  return fs.existsSync(ICON_PATH) ? { icon: ICON_PATH } : {};
}

// Win7/更早系统走 notifu 气泡，Win8+ 走 SnoreToast
function isLegacyWindows() {
  if (process.platform !== 'win32') return false;
  const parts = String(os.release()).split('.').map(Number);
  const major = parts[0] || 0;
  const minor = parts[1] || 0;
  return major < 6 || (major === 6 && minor < 2);
}

// 打包成 exe 后，快照里的 notifu.exe 不能直接作为子进程执行，
// 启动时把内置的 notifu 释放到临时目录，再通过 customPath 指给 node-notifier
function createNotifier() {
  if (!process.pkg || process.platform !== 'win32') return notifierLib;
  try {
    const fileName = os.arch() === 'x64' ? 'notifu64.exe' : 'notifu.exe';
    const srcPath = path.join(__dirname, 'node_modules', 'node-notifier', 'vendor', 'notifu', fileName);
    const tempDir = path.join(os.tmpdir(), 'win7-tiny-reminder-notifier');
    const dstPath = path.join(tempDir, fileName);
    const buf = fs.readFileSync(srcPath);
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
    if (!fs.existsSync(dstPath) || fs.statSync(dstPath).size !== buf.length) {
      fs.writeFileSync(dstPath, buf);
    }
    console.log('通知组件已就绪:', dstPath);
    const balloon = new notifierLib.WindowsBalloon({ customPath: dstPath });
    balloon.usesBalloon = true;
    return balloon;
  } catch (e) {
    console.warn('提取 notifu 失败，回退默认通知器:', e.message);
    return notifierLib;
  }
}

const notifier = createNotifier();

// notifu 气泡必须 wait:true 等待进程退出，才能拿到“点击”结果；
// 打包后的 exe 统一走 Balloon，不能只按 Win7 判断，否则 Win8+ 上点击事件会丢
function applyNotifyWait(options) {
  if (notifier.usesBalloon || isLegacyWindows()) {
    const config = loadConfig();
    options.wait = true;
    options.time = (config.notificationDuration || 5) * 1000;
  } else {
    options.wait = false;
  }
  return options;
}

// 统一的“发通知”出口：静音开关在这里生效，同时负责点击跳转
function notifyUser(options, jumpUrl) {
  const config = loadConfig();
  if (config.muted) {
    console.log(`[静音] 已跳过通知: ${options.title} - ${options.message}`);
    return false;
  }
  applyNotifyWait(options);
  notifier.notify(options, (err, res) => {
    if ((res === 'activate' || res === 'click') && jumpUrl) {
      console.log('通知点击，执行跳转:', jumpUrl);
      openResource(jumpUrl);
    }
  });
  return true;
}

// 全局任务调度实例存储
const taskMap = new Map();

// 通用工具：用系统默认程序打开指定资源（网址/本地文件路径）
function openResource(target) {
  if (!target) return;
  try {
    let processedTarget = target;
    // 自动移除本地文件路径开头的 file:// 协议前缀
    if (processedTarget.startsWith('file://')) {
      processedTarget = processedTarget.slice(7);
      // Windows系统下file://后面可能有额外的斜杠，处理成标准路径格式
      if (process.platform === 'win32' && processedTarget.startsWith('/')) {
        processedTarget = processedTarget.slice(1);
      }
    }
    // 本地盘符路径统一成反斜杠（用户常填 C:/xxx，start 对正斜杠兼容性差）
    if (process.platform === 'win32' && /^[a-zA-Z]:\//.test(processedTarget)) {
      processedTarget = processedTarget.replace(/\//g, '\\');
    }
    // 自动判断是HTTP网址还是本地文件路径
    const isUrl = /^https?:\/\//i.test(processedTarget);
    let cmd;
    if (process.platform === 'win32') {
      // Windows系统下用start命令唤起默认程序，路径中的特殊字符通过转义处理
      cmd = isUrl ? `start "" "${processedTarget}"` : `start "" "${processedTarget}"`;
    } else if (process.platform === 'darwin') {
      cmd = `open "${processedTarget}"`;
    } else {
      cmd = `xdg-open "${processedTarget}"`;
    }
    exec(cmd, (err) => {
      if (err) console.warn('打开资源失败:', target, err.message);
    });
  } catch (e) {
    console.warn('处理跳转失败:', e.message);
  }
}

// 格式化时间为友好显示字符串
function formatTime(timestamp) {
  const d = new Date(timestamp);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// 解析6段cron表达式，返回各段配置
function parseCronExpr(expr) {
  const parts = expr.split(' ');
  if (parts.length !== 6) return null;
  return {
    second: parts[0],
    minute: parts[1],
    hour: parts[2],
    dayOfMonth: parts[3],
    month: parts[4],
    dayOfWeek: parts[5]
  };
}

// 检查某个时间点是否匹配给定的cron配置
function timeMatchesCron(date, cronConfig) {
  const s = date.getSeconds();
  const m = date.getMinutes();
  const h = date.getHours();
  const dom = date.getDate();
  const mon = date.getMonth() + 1;
  const dow = date.getDay(); // 0=周日

  const matchPart = (val, pattern) => {
    if (pattern === '*') return true;
    if (pattern.startsWith('*/')) {
      const step = parseInt(pattern.slice(2), 10);
      return val % step === 0;
    }
    if (pattern.includes(',')) return pattern.split(',').some(p => matchPart(val, p));
    if (pattern.includes('-')) {
      const [start, end] = pattern.split('-').map(Number);
      return val >= start && val <= end;
    }
    return parseInt(pattern, 10) === val;
  };

  return matchPart(s, cronConfig.second) &&
         matchPart(m, cronConfig.minute) &&
         matchPart(h, cronConfig.hour) &&
         matchPart(dom, cronConfig.dayOfMonth) &&
         matchPart(mon, cronConfig.month) &&
         matchPart(dow, cronConfig.dayOfWeek);
}

// 回溯查找 (fromTime, toTime) 区间内所有匹配 cron 的触发点
// 起点是开区间：fromTime 这一秒正是“上一次已经触发过”的时刻，再算进来就会重复补发
function findMissedTriggerPoints(cronExpr, fromTime, toTime) {
  const cronConfig = parseCronExpr(cronExpr);
  if (!cronConfig) return [];
  const points = [];
  // 按秒遍历，最大回溯窗口限制为7天避免性能问题
  const maxWindow = 7 * 24 * 3600 * 1000;
  const earliest = Math.max(fromTime + 1000, toTime - maxWindow);
  // 对齐到整秒，避免起点带毫秒导致逐秒步进错位
  let t = Math.ceil(earliest / 1000) * 1000;
  while (t < toTime) {
    if (timeMatchesCron(new Date(t), cronConfig)) points.push(t);
    t += 1000;
  }
  return points;
}

// 初始化数据目录和文件
function initDataStore() {
  const dataDir = path.dirname(DATA_PATH);
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(DATA_PATH)) fs.writeFileSync(DATA_PATH, JSON.stringify([], null, 2));
  // 初始化全局配置文件，默认开启补提醒功能
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
  }
}

// 原子化安全写入JSON文件
function saveReminders(reminders) {
  const tempPath = DATA_PATH + '.tmp';
  fs.writeFileSync(tempPath, JSON.stringify(reminders, null, 2));
  fs.renameSync(tempPath, DATA_PATH);
}

// 原子化安全写入配置文件
function saveConfig(config) {
  const tempPath = CONFIG_PATH + '.tmp';
  fs.writeFileSync(tempPath, JSON.stringify(config, null, 2));
  fs.renameSync(tempPath, CONFIG_PATH);
}

// 布尔值宽松解析：字符串 "false" 不能被当成 true
function toBool(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    return v === 'true' || v === '1' || v === 'yes' || v === 'on';
  }
  return false;
}

// 数字取值收敛：超出范围就夹到边界，非数字回落到默认值
function clampNumber(value, limits, defaultValue) {
  const n = Number(value);
  if (!isFinite(n)) return defaultValue;
  const rounded = Math.round(n);
  if (rounded < limits.min) return limits.min;
  if (rounded > limits.max) return limits.max;
  return rounded;
}

// 配置归一化：无论文件里是什么脏数据，读出/写入前都收敛成合法结构
function normalizeConfig(input, base) {
  const src = input && typeof input === 'object' ? input : {};
  const merged = Object.assign({}, base || DEFAULT_CONFIG);
  if ('muted' in src) merged.muted = toBool(src.muted);
  if ('enableCatchupCheck' in src) merged.enableCatchupCheck = toBool(src.enableCatchupCheck);
  if ('autoStart' in src) merged.autoStart = toBool(src.autoStart);
  if ('startMinimizedToTray' in src) merged.startMinimizedToTray = toBool(src.startMinimizedToTray);
  if ('notificationDuration' in src) {
    merged.notificationDuration = clampNumber(src.notificationDuration, CONFIG_LIMITS.notificationDuration, DEFAULT_CONFIG.notificationDuration);
  }
  if ('maxCatchupHours' in src) {
    merged.maxCatchupHours = clampNumber(src.maxCatchupHours, CONFIG_LIMITS.maxCatchupHours, DEFAULT_CONFIG.maxCatchupHours);
  }
  if ('webPort' in src) {
    merged.webPort = clampNumber(src.webPort, CONFIG_LIMITS.webPort, DEFAULT_CONFIG.webPort);
  }
  return merged;
}

// 读取全局配置，自动补全缺失字段
function loadConfig() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  } catch (e) {
    raw = {};
  }
  return normalizeConfig(raw, DEFAULT_CONFIG);
}

/* ---------------- 开机自启（写 HKCU Run 项） ---------------- */

const AUTOSTART_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const AUTOSTART_VALUE_NAME = 'Win7TinyReminder';

// 启动命令：打包后直接指向 exe；开发模式下带上 server.js
// 路径含空格时必须加引号，否则 Windows 无法解析
function buildAutostartCommand() {
  const exePath = process.execPath;
  const quote = p => (/\s/.test(p) ? `"${p}"` : p);
  if (process.pkg) return quote(exePath);
  return `${quote(exePath)} "${path.join(__dirname, 'server.js')}"`;
}

// 读取注册表里实际存的自启命令（未写入返回空串）
function readAutoStartValue() {
  if (process.platform !== 'win32') return '';
  try {
    const out = execSync(`reg query "${AUTOSTART_KEY}" /v ${AUTOSTART_VALUE_NAME}`, {
      stdio: ['ignore', 'pipe', 'ignore']
    }).toString();
    const line = out.split(/\r?\n/).find(l => l.indexOf(AUTOSTART_VALUE_NAME) !== -1);
    if (!line) return '';
    const parts = line.split('REG_SZ');
    return parts.length > 1 ? parts[1].trim() : '';
  } catch (e) {
    return '';
  }
}

// 查询注册表当前是否已写入自启项
function isAutoStartEnabled() {
  return readAutoStartValue() !== '';
}

/* reg.exe 的 /d 参数不接受内嵌引号，改为写临时 .reg 文件再 reg import，
   这样路径里的引号与反斜杠都能原样保留 */
function writeAutoStartValue(command) {
  const regPath = path.join(os.tmpdir(), 'win7-tiny-reminder-autostart.reg');
  const escaped = command.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const content = [
    'Windows Registry Editor Version 5.00',
    '',
    '[HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run]',
    `"${AUTOSTART_VALUE_NAME}"="${escaped}"`
  ].join('\r\n') + '\r\n';
  // reg import 只认 ANSI 或 UTF-16LE，用 UTF-16LE 保证中文路径也不乱码
  fs.writeFileSync(regPath, Buffer.from('\ufeff' + content, 'utf16le'));
  execSync(`reg import "${regPath}"`, { stdio: 'ignore' });
  fs.unlinkSync(regPath);
}

// 删除自启项：不存在时 reg 会返回错误，这里不用错误信息判断（不同系统语言提示不同），
// 统一以“删完后回读为空”作为成功标准
function removeAutoStartValue() {
  try {
    execSync(`reg delete "${AUTOSTART_KEY}" /v ${AUTOSTART_VALUE_NAME} /f`, { stdio: 'ignore' });
  } catch (e) {
    // 忽略：多半是本机本来就没有这一项
  }
}

// 应用自启开关：true 写注册表，false 删除
function applyAutoStart(enabled) {
  if (process.platform !== 'win32') {
    return { ok: false, reason: '当前系统不支持开机自启' };
  }
  if (process.env.REMINDER_NO_AUTOSTART === '1') {
    return { ok: true, skipped: true };
  }
  try {
    if (enabled) {
      const expected = buildAutostartCommand();
      writeAutoStartValue(expected);
      // 回读校验，避免注册表写进去了但值不对
      const actual = readAutoStartValue();
      if (actual !== expected) {
        return { ok: false, reason: '注册表回读值与预期不一致: ' + actual };
      }
    } else {
      // 本来就没写自启项时不必调用 reg delete（一次 reg 调用要花 1 秒以上，会拖慢启动）
      if (!isAutoStartEnabled()) return { ok: true, enabled: false };
      removeAutoStartValue();
      if (isAutoStartEnabled()) {
        return { ok: false, reason: '注册表自启项未能移除' };
      }
    }
    return { ok: true, enabled: isAutoStartEnabled() };
  } catch (e) {
    console.warn('设置开机自启失败:', e.message);
    return { ok: false, reason: e.message };
  }
}

/* ---------------- 系统托盘（启动时最小化到通知区） ---------------- */

// 托盘助手是一个独立的 PowerShell 进程：Win7 自带 PowerShell 2.0 和 .NET 3.5，
// 用 System.Windows.Forms.NotifyIcon 就能做出原生托盘图标，不需要引入原生模块。
// pkg 快照里的脚本不能直接执行，启动前释放到临时目录；脚本里的中文依赖 UTF-8 BOM，
// 否则 PowerShell 2.0 会按 ANSI 解析而报错。
const TRAY_TEMP_DIR = path.join(os.tmpdir(), 'win7-tiny-reminder-tray');
const TRAY_SCRIPT_SRC = path.join(__dirname, 'assets', 'tray.ps1');
const TRAY_SCRIPT_PATH = path.join(TRAY_TEMP_DIR, 'tray.ps1');

let trayProcess = null; // 当前托盘助手子进程
let trayPort = 0; // 托盘菜单当前指向的端口
let trayStopFile = ''; // 每个助手独享的停止标记，避免重启时新旧助手互相干扰
let lastTrayError = '';

function isTraySupported() {
  return process.platform === 'win32';
}

function isTrayActive() {
  return !!(trayProcess && trayProcess.pid);
}

// 释放托盘脚本到临时目录；内容没变就复用，避免每次启动都写盘
function prepareTrayScript() {
  if (!fs.existsSync(TRAY_TEMP_DIR)) fs.mkdirSync(TRAY_TEMP_DIR, { recursive: true });
  let content = fs.readFileSync(TRAY_SCRIPT_SRC);
  if (!(content.length >= 3 && content[0] === 0xEF && content[1] === 0xBB && content[2] === 0xBF)) {
    content = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), content]);
  }
  let needWrite = true;
  try {
    needWrite = !fs.readFileSync(TRAY_SCRIPT_PATH).equals(content);
  } catch (e) {
    needWrite = true;
  }
  if (needWrite) fs.writeFileSync(TRAY_SCRIPT_PATH, content);
  return TRAY_SCRIPT_PATH;
}

// 拉起托盘助手；返回 {ok, active, pid?, reason?}
function startTray(port) {
  if (!isTraySupported()) {
    return { ok: false, active: false, reason: '当前系统不支持系统托盘' };
  }
  if (process.env.REMINDER_TRAY_DISABLE === '1') {
    return { ok: true, active: false, skipped: true, reason: '当前进程已通过环境变量禁用托盘' };
  }
  if (isTrayActive()) {
    if (trayPort === port) return { ok: true, active: true, pid: trayProcess.pid, reused: true };
    stopTray();
  }
  try {
    const scriptPath = prepareTrayScript();
    // 停止标记按「服务进程 + 启动时刻」命名，重启助手时旧标记不会误伤新助手
    const stopFile = path.join(TRAY_TEMP_DIR, 'tray-' + process.pid + '-' + Date.now() + '.stop');
    try {
      if (fs.existsSync(stopFile)) fs.unlinkSync(stopFile); // 仅清理本程序自己的临时标记
    } catch (e) {
      // 忽略：标记文件不存在即可
    }
    // 只有打包 exe 才隐藏控制台；源码模式保留控制台方便看日志
    const hideConsole = process.pkg ? 1 : 0;
    // 注意：这里不能加 -WindowStyle Hidden，也不能用 detached:true。
    // Node 在 Windows 上用 DETACHED_PROCESS 启动时，PowerShell 会直接退出而不执行脚本；
    // 用 -WindowStyle Hidden 则会连同源码模式下的控制台一起藏掉，不利于看日志。
    const args = [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', scriptPath,
      '-ServerPid', String(process.pid),
      '-Port', String(port),
      '-ExePath', process.execPath,
      '-StopFile', stopFile,
      '-HideConsole', String(hideConsole)
    ];
    const child = spawn('powershell.exe', args, {
      windowsHide: true,
      stdio: 'ignore'
    });
    trayProcess = child;
    trayPort = port;
    trayStopFile = stopFile;
    lastTrayError = '';

    child.on('error', err => {
      lastTrayError = err.message;
      if (trayProcess === child) {
        trayProcess = null;
        trayPort = 0;
      }
      console.warn('托盘助手启动失败:', err.message);
    });
    child.on('exit', code => {
      if (trayProcess === child) {
        trayProcess = null;
        trayPort = 0;
      }
      if (code && code !== 0) console.warn('托盘助手已退出, code=' + code);
    });
    child.unref();

    console.log(`托盘图标已启动, pid=${child.pid}, 端口=${port}${hideConsole ? ', 将隐藏控制台' : ''}`);
    return { ok: true, active: true, pid: child.pid, hiddenConsole: !!hideConsole };
  } catch (e) {
    lastTrayError = e.message;
    trayProcess = null;
    trayPort = 0;
    trayStopFile = '';
    console.warn('托盘启动失败:', e.message);
    return { ok: false, active: false, reason: e.message };
  }
}

// 让托盘助手自己退出（写停止标记），避免直接杀进程留下幽灵图标；
// 8 秒内没退出再强制结束（给“恢复控制台”留足编译/显示时间）。
// showConsole=true 时顺带把隐藏的控制台重新显示出来
// （用户在设置页关掉托盘时用），避免控制台一直藏着、看起来像没有界面。
function stopTray(options) {
  const showConsole = !!(options && options.showConsole);
  const child = trayProcess;
  const stopFile = trayStopFile;
  trayProcess = null;
  trayPort = 0;
  trayStopFile = '';
  if (!child) return { ok: true, active: false };

  try {
    if (stopFile) fs.writeFileSync(stopFile, showConsole ? 'show' : 'stop');
  } catch (e) {
    // 忽略：退而求其次，靠下面的强制结束兜底
  }
  const forceTimer = setTimeout(() => {
    try { child.kill(); } catch (e) { /* 已自行退出 */ }
  }, 8000);
  if (forceTimer.unref) forceTimer.unref();
  return { ok: true, active: false };
}

// 进程退出时通知助手收掉图标（正常退出场景；被强杀时由助手自己检测主进程消失）
process.on('exit', () => {
  if (trayStopFile) {
    try { fs.writeFileSync(trayStopFile, 'stop'); } catch (e) { /* 忽略 */ }
  }
});

// 数据兼容：给旧数据补全缺失的lastFiredTimestamp、lastCatchupTimestamp和jumpUrl字段
function migrateReminderFields(reminder) {
  const now = Date.now();
  const maxValidTs = now + 365 * 24 * 3600 * 1000; // 最大允许时间戳为当前时间往后1年
  if (!reminder.lastFiredTimestamp || reminder.lastFiredTimestamp > maxValidTs) {
    reminder.lastFiredTimestamp = 0;
  }
  if (!reminder.lastCatchupTimestamp || reminder.lastCatchupTimestamp > maxValidTs) {
    reminder.lastCatchupTimestamp = 0;
  }
  if (typeof reminder.jumpUrl !== 'string') {
    reminder.jumpUrl = '';
  }
  return reminder;
}

// 执行补提醒通知
function fireCatchupNotification(reminder, triggerTime) {
  console.log(`补提醒触发: ${reminder.name} (原定时间: ${formatTime(triggerTime)})`);
  notifyUser({
    title: `📌 补提醒 - ${reminder.name}`,
    message: `原定 ${formatTime(triggerTime).split(' ')[1]} 触发\n${reminder.content}`,
    ...getIconOption()
  }, reminder.jumpUrl);
}

// 启动前执行回溯检查，处理所有错过的提醒
function runCatchupCheck() {
  const config = loadConfig();
  // 如果补提醒开关关闭，直接跳过整个回溯流程
  if (!config.enableCatchupCheck) {
    console.log('补提醒功能已关闭，跳过回溯检查');
    return JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8')).map(migrateReminderFields);
  }
  
  const reminders = JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8')).map(migrateReminderFields);
  const now = Date.now();
  const maxCatchupWindow = config.maxCatchupHours * 3600 * 1000;
  // 当前这一秒留给 cron 自己触发，补提醒只处理更早的时间点
  const scanEnd = Math.floor(now / 1000) * 1000;
  const windowStart = now - maxCatchupWindow;
  let hasChanges = false;

  reminders.forEach(reminder => {
    if (!reminder.enabled) return;

    // 回溯起点取上次实际触发和上次补提醒的较大值
    let anchor = Math.max(reminder.lastCatchupTimestamp || 0, reminder.lastFiredTimestamp || 0);

    // 没有可信基准（老数据缺字段、时间戳异常）：对齐到当前，不做回溯，避免一启动就补一堆旧提醒
    if (anchor <= 0 || anchor > now) {
      reminder.lastFiredTimestamp = now;
      reminder.lastCatchupTimestamp = now;
      hasChanges = true;
      return;
    }

    // 刚刚触发过，当前秒之后交给定时任务，没有可补的点
    if (anchor >= scanEnd) return;

    // 只回溯到最大回溯窗口：更早的点不补，但窗口内的点仍要补，不能整条跳过
    if (anchor < windowStart) anchor = windowStart;

    const missedPoints = findMissedTriggerPoints(reminder.cronExpr, anchor, scanEnd);
    if (missedPoints.length === 0) return;

    // 只处理最后一个错过的触发点，避免一次性弹出大量通知打扰用户
    const lastMissed = missedPoints[missedPoints.length - 1];
    fireCatchupNotification(reminder, lastMissed);
    // 补过就把基准推进到该点，下次启动不会再补同一秒
    reminder.lastCatchupTimestamp = lastMissed;
    hasChanges = true;
  });

  if (hasChanges) {
    saveReminders(reminders);
  }
  console.log('关机补提醒检查完成');
  return reminders;
}

// 加载所有提醒任务
function loadAllTasks() {
  // 先执行回溯检查，拿到带完整字段的提醒列表
  const reminders = runCatchupCheck();
  reminders.forEach(reminder => {
    if (reminder.enabled) startTask(reminder);
  });
  console.log(`已加载 ${reminders.length} 条提醒规则`);
}

// 启动单个定时任务
function startTask(reminder) {
  // 先停止已存在的同ID任务
  if (taskMap.has(reminder.id)) taskMap.get(reminder.id).stop();
  
  const task = cron.schedule(reminder.cronExpr, () => {
    const now = Date.now();
    console.log(`触发提醒: ${reminder.name}`);
    notifyUser({
      title: '🕒 定时提醒',
      message: reminder.content,
      ...getIconOption()
    }, reminder.jumpUrl);
    // 更新最后触发时间戳并持久化
    const list = JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8')).map(migrateReminderFields);
    const idx = _.findIndex(list, { id: reminder.id });
    if (idx !== -1) {
      list[idx].lastFiredTimestamp = now;
      saveReminders(list);
    }
  });
  taskMap.set(reminder.id, task);
}

// 停止单个任务
function stopTask(id) {
  if (taskMap.has(id)) {
    taskMap.get(id).stop();
    taskMap.delete(id);
  }
}

/* ---------------- HTTP 服务 ---------------- */

// 响应 JSON 的简写
function sendJson(res, payload, statusCode) {
  res.statusCode = statusCode || 200;
  res.setHeader('Content-Type', 'application/json;charset=utf-8');
  res.end(JSON.stringify(payload));
}

// 静态文件 MIME
function contentTypeOf(ext) {
  return {
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.html': 'text/html;charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.gif': 'image/gif'
  }[ext] || 'application/octet-stream';
}

let activePort = 0;
let server = null;

function handleRequest(req, res) {
  // 允许跨域
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') return res.end();

  // 静态页面路由
  if (req.url === '/' || req.url.startsWith('/index.html')) {
    const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
    res.setHeader('Content-Type', 'text/html;charset=utf-8');
    return res.end(html);
  }

  // 全局设置页面路由
  if (req.url === '/config' || req.url.startsWith('/config.html')) {
    const html = fs.readFileSync(path.join(__dirname, 'public', 'config.html'));
    res.setHeader('Content-Type', 'text/html;charset=utf-8');
    return res.end(html);
  }

  // 提供node_modules下的静态资源访问
  if (req.url.startsWith('/node_modules/')) {
    const filePath = path.join(__dirname, req.url);
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      res.setHeader('Content-Type', contentTypeOf(path.extname(filePath)));
      return fs.createReadStream(filePath).pipe(res);
    }
  }

  // public目录下的其他静态资源
  if (req.url.startsWith('/')) {
    const publicPath = path.join(__dirname, 'public', req.url);
    if (fs.existsSync(publicPath) && fs.statSync(publicPath).isFile()) {
      res.setHeader('Content-Type', contentTypeOf(path.extname(publicPath)));
      return fs.createReadStream(publicPath).pipe(res);
    }
  }

  // API接口：获取全局配置（附带运行时信息，配置页用来显示当前实际生效状态）
  if (req.url === '/api/config' && req.method === 'GET') {
    const config = loadConfig();
    return sendJson(res, {
      code: 0,
      data: config,
      runtime: {
        activePort,
        packaged: !!process.pkg,
        platform: process.platform,
        autoStartEnabled: isAutoStartEnabled(),
        traySupported: isTraySupported(),
        trayActive: isTrayActive(),
        trayPid: trayProcess ? trayProcess.pid : 0,
        trayError: lastTrayError,
        dataDir: DATA_DIR,
        configPath: CONFIG_PATH,
        mode: process.pkg ? 'exe' : 'dev'
      }
    });
  }

  // API接口：保存全局配置
  if (req.url === '/api/config' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1024 * 100) req.destroy();
    });
    req.on('end', () => {
      let newConfig;
      try {
        newConfig = JSON.parse(body);
        if (!newConfig || typeof newConfig !== 'object' || Array.isArray(newConfig)) {
          throw new Error('配置必须是 JSON 对象');
        }
      } catch (e) {
        console.error('保存配置失败:', e.message);
        return sendJson(res, { code: -1, msg: '配置格式不正确' }, 500);
      }

      const oldConfig = loadConfig();
      // 先归一化再落盘，避免脏值写进配置文件
      const finalConfig = normalizeConfig(newConfig, oldConfig);
      saveConfig(finalConfig);

      // 开机自启：开关变化时立刻写/删注册表
      let autoStartResult = { ok: true, changed: false };
      if (finalConfig.autoStart !== oldConfig.autoStart) {
        autoStartResult = applyAutoStart(finalConfig.autoStart);
        autoStartResult.changed = true;
        if (!autoStartResult.ok) {
          // 写注册表失败就回滚配置，保证配置与真实状态一致
          finalConfig.autoStart = oldConfig.autoStart;
          saveConfig(finalConfig);
        }
      }

      // 托盘开关：与端口可能同时变化，等端口确定后再统一应用，
      // 保证托盘菜单里的链接指向真正在监听的端口
      const trayChanged = finalConfig.startMinimizedToTray !== oldConfig.startMinimizedToTray;

      const finish = (portApplied) => {
        let trayApplied = { ok: true, changed: false, active: isTrayActive() };
        if (trayChanged) {
          if (finalConfig.startMinimizedToTray) {
            trayApplied = Object.assign({ changed: true }, startTray(activePort));
          } else {
            stopTray({ showConsole: true });
            trayApplied = { ok: true, changed: true, active: false };
          }
        } else if (finalConfig.startMinimizedToTray && isTrayActive() && trayPort !== activePort) {
          // 端口热切换后，托盘菜单里的链接也要跟着换
          stopTray();
          trayApplied = Object.assign({ changed: false, restarted: true }, startTray(activePort));
        }

        sendJson(res, {
          code: 0,
          data: finalConfig,
          applied: {
            port: portApplied,
            autoStart: autoStartResult,
            tray: trayApplied
          }
        });
      };

      // 端口：立即切到新端口监听，失败则回滚
      if (finalConfig.webPort === activePort) {
        return finish({ ok: true, port: activePort, changed: false });
      }

      switchPort(finalConfig.webPort).then(result => {
        if (!result.ok) {
          finalConfig.webPort = oldConfig.webPort;
          saveConfig(finalConfig);
        }
        finish({
          ok: result.ok,
          port: result.ok ? result.port : activePort,
          changed: result.ok,
          reason: result.reason
        });
      }).catch(e => {
        console.warn('切换端口异常:', e.message);
        finalConfig.webPort = oldConfig.webPort;
        saveConfig(finalConfig);
        finish({ ok: false, port: activePort, changed: false, reason: e.message });
      });
    });
    return;
  }

  // API接口：获取所有提醒
  if (req.url === '/api/reminders' && req.method === 'GET') {
    const list = JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8')).map(migrateReminderFields);
    return sendJson(res, list);
  }

  // API接口：新增/编辑提醒
  if (req.url === '/api/reminders' && req.method === 'POST') {
    let body = '';
    // 异步等待完整接收请求体
    req.on('data', chunk => {
      body += chunk;
      // 限制最大请求体大小，防止恶意攻击
      if (body.length > 1024 * 100) req.destroy();
    });
    req.on('end', () => {
      try {
        const newReminder = migrateReminderFields(JSON.parse(body));
        const list = JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8')).map(migrateReminderFields);
        
        if (newReminder.id) {
          // 编辑模式
          const index = _.findIndex(list, { id: newReminder.id });
          // 保留原有时间戳字段（除非用户主动重置）
          newReminder.lastFiredTimestamp = list[index].lastFiredTimestamp;
          newReminder.lastCatchupTimestamp = list[index].lastCatchupTimestamp;
          list[index] = newReminder;
        } else {
          // 新增模式，初始化时间戳为当前时间，避免刚创建就回溯补提醒
          const now = Date.now();
          newReminder.lastFiredTimestamp = now;
          newReminder.lastCatchupTimestamp = now;
          newReminder.id = _.uniqueId('rem_');
          list.push(newReminder);
        }

        saveReminders(list);
        if (newReminder.enabled) startTask(newReminder);
        else stopTask(newReminder.id);

        sendJson(res, { code: 0, data: newReminder });
      } catch (e) {
        console.error('保存提醒失败:', e);
        sendJson(res, { code: -1, msg: '保存失败' }, 500);
      }
    });
    return;
  }

  // API接口：删除
  if (req.url.startsWith('/api/reminders/') && req.method === 'DELETE') {
    const id = req.url.split('/').pop();
    let list = JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8'));
    list = _.remove(list, item => item.id !== id);
    saveReminders(list);
    stopTask(id);
    return res.end(JSON.stringify({ code: 0 }));
  }

  res.statusCode = 404;
  res.end('Not Found');
}

// 在指定端口起一个监听实例（失败不影响当前实例）
function listenOn(port) {
  return new Promise((resolve, reject) => {
    const s = http.createServer(handleRequest);
    s.once('error', reject);
    s.listen(port, () => {
      s.removeListener('error', reject);
      resolve(s);
    });
  });
}

// 端口热切换：先在新端口起监听，成功后再关掉旧监听
async function switchPort(newPort) {
  if (newPort === activePort) return { ok: true, port: activePort };
  let next;
  try {
    next = await listenOn(newPort);
  } catch (e) {
    console.warn(`端口 ${newPort} 监听失败:`, e.message);
    return { ok: false, port: activePort, reason: `端口 ${newPort} 不可用: ${e.message}` };
  }
  const old = server;
  server = next;
  const prevPort = activePort;
  activePort = newPort;
  if (old) old.close();
  console.log(`服务端口已切换: ${prevPort} -> ${newPort}`);
  return { ok: true, port: newPort, previous: prevPort };
}

// 启动流程
async function main() {
  initDataStore();
  const config = loadConfig();

  // 开机自启配置在启动时同步一次，避免注册表与配置不一致
  const autoStartResult = applyAutoStart(config.autoStart);
  if (autoStartResult.ok && !autoStartResult.skipped) {
    console.log(`开机自启: ${config.autoStart ? '已启用' : '已关闭'}`);
  }

  loadAllTasks();

  // 端口来源：测试用环境变量 > 配置文件 > 默认端口
  const startPort = clampNumber(
    process.env.REMINDER_PORT || config.webPort,
    CONFIG_LIMITS.webPort,
    DEFAULT_PORT
  );
  try {
    server = await listenOn(startPort);
    activePort = startPort;
  } catch (e) {
    if (startPort !== DEFAULT_PORT) {
      console.warn(`端口 ${startPort} 被占用，回退到默认端口 ${DEFAULT_PORT}`);
      server = await listenOn(DEFAULT_PORT);
      activePort = DEFAULT_PORT;
    } else {
      throw e;
    }
  }
  console.log(`提醒服务已启动，提醒配置页: http://localhost:${activePort}`);
  console.log(`全局设置页: http://localhost:${activePort}/config`);

  // 按配置驻留托盘：打包 exe 时助手会隐藏控制台窗口，双击图标可回到配置页
  if (config.startMinimizedToTray) {
    const trayResult = startTray(activePort);
    if (!trayResult.ok) {
      console.warn('最小化到托盘失败:', trayResult.reason);
    }
  }
}

main().catch(e => {
  console.error('服务启动失败:', e.message);
  process.exit(1);
});
