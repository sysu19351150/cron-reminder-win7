const http = require('http');
const fs = require('fs');
const path = require('path');
const _ = require('lodash');
const cron = require('node-cron');
const notifier = require('node-notifier');

// 数据文件路径
const DATA_PATH = path.join(__dirname, 'data', 'reminders.json');
const PORT = 28765;

// 全局任务调度实例存储
const taskMap = new Map();

// 初始化数据目录和文件
function initDataStore() {
  const dataDir = path.dirname(DATA_PATH);
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(DATA_PATH)) fs.writeFileSync(DATA_PATH, JSON.stringify([], null, 2));
}

// 原子化安全写入JSON文件
function saveReminders(reminders) {
  const tempPath = DATA_PATH + '.tmp';
  fs.writeFileSync(tempPath, JSON.stringify(reminders, null, 2));
  fs.renameSync(tempPath, DATA_PATH);
}

// 加载所有提醒任务
function loadAllTasks() {
  const reminders = JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8'));
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
    console.log(`触发提醒: ${reminder.name}`);
    notifier.notify({
      title: '定时提醒',
      message: reminder.content,
      wait: false,
      icon: path.join(__dirname, 'assets', 'icon.png')
    });
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

  // API接口：获取所有提醒
  if (req.url === '/api/reminders' && req.method === 'GET') {
    const list = JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8'));
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
        const newReminder = JSON.parse(body);
        const list = JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8'));
        
        if (newReminder.id) {
          // 编辑模式
          const index = _.findIndex(list, { id: newReminder.id });
          list[index] = newReminder;
        } else {
          // 新增模式
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

  // API接口：删除提醒
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