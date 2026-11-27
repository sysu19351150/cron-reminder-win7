const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const _ = require('lodash');
const cron = require('node-cron');
const notifierLib = require('node-notifier');
const os = require('os');

// 数据文件路径：打包成 exe 后 __dirname 指向只读快照，运行时数据统一放到 exe 同级目录
const APP_DIR = process.pkg ? path.dirname(process.execPath) : __dirname;
const DATA_PATH = path.join(APP_DIR, 'data', 'reminders.json');
const CONFIG_PATH = path.join(APP_DIR, 'data', 'config.json');
const ICON_PATH = path.join(APP_DIR, 'assets', 'icon.png');
const PORT = 28765;

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

// 回溯查找[fromTime, toTime)区间内所有匹配cron的触发点
function findMissedTriggerPoints(cronExpr, fromTime, toTime) {
  const cronConfig = parseCronExpr(cronExpr);
  if (!cronConfig) return [];
  const points = [];
  // 按秒遍历，最大回溯窗口限制为7天避免性能问题
  const maxWindow = 7 * 24 * 3600 * 1000;
  const startTime = Math.max(fromTime, toTime - maxWindow);
  let t = startTime;
  while (t < toTime) {
    const d = new Date(t);
    if (timeMatchesCron(d, cronConfig)) {
      points.push(t);
    }
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
    const defaultConfig = {
      muted: false,
      notificationDuration: 5,
      maxCatchupHours: 48,
      webPort: 28765,
      autoStart: false,
      enableCatchupCheck: true
    };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(defaultConfig, null, 2));
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

// 读取全局配置，自动补全缺失字段
function loadConfig() {
  let config;
  try {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  } catch (e) {
    config = {};
  }
  // 字段兼容补全
  if (typeof config.enableCatchupCheck !== 'boolean') config.enableCatchupCheck = true;
  if (typeof config.muted !== 'boolean') config.muted = false;
  if (typeof config.notificationDuration !== 'number') config.notificationDuration = 5;
  if (typeof config.maxCatchupHours !== 'number') config.maxCatchupHours = 48;
  if (typeof config.webPort !== 'number') config.webPort = 28765;
  if (typeof config.autoStart !== 'boolean') config.autoStart = false;
  return config;
}

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
  const notifyOptions = {
    title: `📌 补提醒 - ${reminder.name}`,
    message: `原定 ${formatTime(triggerTime).split(' ')[1]} 触发\n${reminder.content}`,
    ...getIconOption()
  };
  applyNotifyWait(notifyOptions);
  notifier.notify(notifyOptions, (err, res) => {
    if ((res === 'activate' || res === 'click') && reminder.jumpUrl) {
      console.log('通知点击，执行跳转:', reminder.jumpUrl);
      openResource(reminder.jumpUrl);
    }
  });
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
  let hasChanges = false;

  reminders.forEach(reminder => {
    if (!reminder.enabled) return;
    // 回溯起点取 lastCatchupTimestamp 和 lastFiredTimestamp 的较大值
    const fromTime = Math.max(reminder.lastCatchupTimestamp, reminder.lastFiredTimestamp);
    if (fromTime >= now) return;
    // 超过最大回溯时长的直接跳过
    if (now - fromTime > maxCatchupWindow) return;

    const missedPoints = findMissedTriggerPoints(reminder.cronExpr, fromTime, now);
    if (missedPoints.length === 0) return;

    // 只处理最后一个错过的触发点，避免一次性弹出大量通知打扰用户
    const lastMissed = missedPoints[missedPoints.length - 1];
    fireCatchupNotification(reminder, lastMissed);
    // 更新补提醒时间戳
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
    const notifyOptions = {
      title: '🕒 定时提醒',
      message: reminder.content,
      ...getIconOption()
    };
    applyNotifyWait(notifyOptions);
    notifier.notify(notifyOptions, (err, res) => {
      // 点击气泡时执行跳转
      if ((res === 'activate' || res === 'click') && reminder.jumpUrl) {
        console.log('通知点击，执行跳转:', reminder.jumpUrl);
        openResource(reminder.jumpUrl);
      }
    });
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

// 简单CORS处理 + 静态文件服务
const server = http.createServer((req, res) => {
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

  // 提供node_modules下的静态资源访问
  if (req.url.startsWith('/node_modules/')) {
    const filePath = path.join(__dirname, req.url);
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath);
      const contentType = {
        '.css': 'text/css',
        '.js': 'application/javascript',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.gif': 'image/gif'
      }[ext] || 'application/octet-stream';
      res.setHeader('Content-Type', contentType);
      return fs.createReadStream(filePath).pipe(res);
    }
  }

  // public目录下的其他静态资源
  if (req.url.startsWith('/')) {
    const publicPath = path.join(__dirname, 'public', req.url);
    if (fs.existsSync(publicPath) && fs.statSync(publicPath).isFile()) {
      const ext = path.extname(publicPath);
      const contentType = {
        '.css': 'text/css',
        '.js': 'application/javascript',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.gif': 'image/gif'
      }[ext] || 'application/octet-stream';
      res.setHeader('Content-Type', contentType);
      return fs.createReadStream(publicPath).pipe(res);
    }
  }

  // API接口：获取全局配置
  if (req.url === '/api/config' && req.method === 'GET') {
    const config = loadConfig();
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ code: 0, data: config }));
  }

  // API接口：保存全局配置
  if (req.url === '/api/config' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1024 * 100) req.destroy();
    });
    req.on('end', () => {
      try {
        const newConfig = JSON.parse(body);
        const oldConfig = loadConfig();
        // 合并新旧配置，只更新传入的字段
        const finalConfig = { ...oldConfig, ...newConfig };
        saveConfig(finalConfig);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ code: 0, data: finalConfig }));
      } catch (e) {
        console.error('保存配置失败:', e);
        res.statusCode = 500;
        res.end(JSON.stringify({ code: -1, msg: '保存配置失败' }));
      }
    });
    return;
  }

  // API接口：获取所有提醒
  if (req.url === '/api/reminders' && req.method === 'GET') {
    const list = JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8')).map(migrateReminderFields);
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify(list));
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

        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ code: 0, data: newReminder }));
      } catch (e) {
        console.error('保存提醒失败:', e);
        res.statusCode = 500;
        res.end(JSON.stringify({ code: -1, msg: '保存失败' }));
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
});

// 启动流程
initDataStore();
loadAllTasks();
server.listen(PORT, () => {
  console.log(`提醒服务已启动，配置页面访问地址: http://localhost:${PORT}`);
});