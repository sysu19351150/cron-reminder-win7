/**
 * 全局配置生效性检查脚本（可重复运行，不污染真实数据）
 *
 * 用法：
 *   node test-config.js                      # 用源码起服务（npm run test:config）
 *   node test-config.js --exe dist/reminder-server.exe   # 直接验证打包后的 exe
 *
 * 做法：
 *  - 用 REMINDER_DATA_DIR 把数据隔离到临时目录、用随机空闲端口启动独立实例；
 *  - 逐项验证 config.json 里的每个字段是否真的在后端生效；
 *  - 覆盖通知静音、端口热切换与回滚、开机自启注册表、补提醒回溯开关/时长；
 *  - 结束时杀掉所有子进程并删除临时目录，开机自启项恢复为关闭。
 */

const { spawn, execSync } = require('child_process');
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = __dirname;

// --exe <path> 时直接测打包产物，避免源码在慢速网络盘上加载依赖过慢
const argv = process.argv.slice(2);
const exeIndex = argv.indexOf('--exe');
const EXE_PATH = exeIndex !== -1 && argv[exeIndex + 1] ? path.resolve(argv[exeIndex + 1]) : '';

const AUTOSTART_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const AUTOSTART_VALUE = 'Win7TinyReminder';

let pass = 0;
let fail = 0;
const failures = [];

function check(cond, label, extra) {
  if (cond) {
    pass += 1;
    console.log('  [ok] ' + label);
  } else {
    fail += 1;
    failures.push(label + (extra ? ' -> ' + extra : ''));
    console.log('  [FAIL] ' + label + (extra ? ' -> ' + extra : ''));
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

const usedPorts = new Set();

function rawFreePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
}

// 保证每次拿到的端口都不重复（系统可能把刚释放的端口再次分配）
async function freePort() {
  for (let i = 0; i < 20; i += 1) {
    const p = await rawFreePort();
    if (!usedPorts.has(p)) {
      usedPorts.add(p);
      return p;
    }
  }
  throw new Error('找不到未使用的端口');
}

function request(port, method, pathname, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: pathname,
      agent: false, // 每次新建连接，避免 keep-alive 复用导致端口关闭检测不准
      headers: payload
        ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
        : {}
    }, res => {
      let buf = '';
      res.on('data', c => { buf += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(buf); } catch (e) { /* 非 JSON 响应 */ }
        resolve({ status: res.statusCode, text: buf, json });
      });
    });
    req.setTimeout(20000, () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function waitForApi(port, timeoutMs) {
  // 首次加载依赖 + 注册表调用较慢的机器上可能超过 10 秒，给足余量
  const deadline = Date.now() + (timeoutMs || 45000);
  let lastErr = '';
  while (Date.now() < deadline) {
    try {
      const r = await request(port, 'GET', '/api/config');
      if (r.status === 200 && r.json) return r.json;
    } catch (e) {
      lastErr = e.message;
    }
    await sleep(200);
  }
  throw new Error('等待服务就绪超时: ' + lastErr);
}

class Server {
  constructor(dataDir, port, extraEnv) {
    this.dataDir = dataDir;
    this.port = port;
    this.logs = [];
    this.child = spawn(EXE_PATH || process.execPath, EXE_PATH ? [] : [path.join(ROOT, 'server.js')], {
      cwd: EXE_PATH ? path.dirname(EXE_PATH) : ROOT,
      env: Object.assign({}, process.env, {
        REMINDER_DATA_DIR: dataDir,
        REMINDER_PORT: String(port)
      }, extraEnv || {})
    });
    const collect = chunk => {
      String(chunk).split(/\r?\n/).forEach(line => {
        if (line.trim()) this.logs.push(line.trim());
      });
    };
    this.child.stdout.on('data', collect);
    this.child.stderr.on('data', collect);
    this.child.on('error', e => this.logs.push('[spawn-error] ' + e.message));
    this.child.on('exit', (code, sig) => this.logs.push('[exit] code=' + code + ' signal=' + sig));
  }

  hasLog(re) {
    return this.logs.some(l => re.test(l));
  }

  countLog(re) {
    return this.logs.filter(l => re.test(l)).length;
  }

  async stop() {
    if (!this.child || this.child.exitCode !== null) return;
    this.child.kill();
    // 等进程真正退出，避免残留实例继续持有数据目录、端口
    const deadline = Date.now() + 3000;
    while (this.child.exitCode === null && Date.now() < deadline) await sleep(100);
  }
}

function readConfigFile(dataDir) {
  return JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf-8'));
}

function writeConfigFile(dataDir, cfg) {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify(cfg, null, 2));
  if (!fs.existsSync(path.join(dataDir, 'reminders.json'))) {
    fs.writeFileSync(path.join(dataDir, 'reminders.json'), JSON.stringify([], null, 2));
  }
}

// 一次性写配置 + 提醒数据，供补提醒用例构造历史状态
function seedDir(dataDir, cfg, reminders) {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify(cfg, null, 2));
  fs.writeFileSync(path.join(dataDir, 'reminders.json'), JSON.stringify(reminders, null, 2));
}

function readReminders(dataDir) {
  return JSON.parse(fs.readFileSync(path.join(dataDir, 'reminders.json'), 'utf-8'));
}

function regQuery() {
  try {
    const out = execSync(`reg query "${AUTOSTART_KEY}" /v ${AUTOSTART_VALUE}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    return out;
  } catch (e) {
    return '';
  }
}

function regCleanup() {
  try {
    execSync(`reg delete "${AUTOSTART_KEY}" /v ${AUTOSTART_VALUE} /f`, { stdio: 'ignore' });
  } catch (e) { /* 本来就没有 */ }
}

async function main() {
  console.log('测试目标: ' + (EXE_PATH ? ('exe -> ' + EXE_PATH) : '源码 -> ' + path.join(ROOT, 'server.js')));
  const allDirs = [];
  const makeDir = tag => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rem-config-' + tag + '-'));
    allDirs.push(dir);
    return dir;
  };
  const dirA = makeDir('a');
  const dirB = makeDir('b');
  const dirC = makeDir('c');
  const portA = await freePort();
  const portB = await freePort();
  const portC = await freePort();
  const servers = [];

  try {
    /* ============ 1. 主实例：页面路由 + 配置读写 + 各字段生效 ============ */
    console.log('\n[1] 启动独立实例 ' + portA + '（数据目录已隔离）');
    const s1 = new Server(dirA, portA);
    servers.push(s1);
    const initial = await waitForApi(portA);
    check(initial.code === 0, 'GET /api/config 返回 code=0');
    const cfg0 = initial.data;
    check(cfg0.muted === false && cfg0.enableCatchupCheck === true && cfg0.autoStart === false,
      '默认布尔配置项正确', JSON.stringify(cfg0));
    check(cfg0.notificationDuration === 5 && cfg0.maxCatchupHours === 48 && cfg0.webPort === 28765,
      '默认数值配置项正确（webPort 默认 28765，测试用环境变量覆盖监听端口）', JSON.stringify(cfg0));
    check(initial.runtime && initial.runtime.activePort === portA, 'runtime.activePort 与实际监听端口一致', JSON.stringify(initial.runtime));

    // 默认 config.webPort(28765) 与测试监听端口不一致，先对齐，
    // 否则后面任何 POST /api/config 都会触发热切换到 28765
    const align = await request(portA, 'POST', '/api/config', { webPort: portA });
    check(align.json && align.json.data.webPort === portA, '配置端口已对齐测试端口', JSON.stringify(align.json && align.json.data));

    // 页面路由
    const pageMain = await request(portA, 'GET', '/');
    check(pageMain.status === 200 && pageMain.text.indexOf('href="/config"') !== -1,
      '主页面可访问且带「全局设置」入口');
    const pageCfg = await request(portA, 'GET', '/config');
    check(pageCfg.status === 200 && pageCfg.text.indexOf('服务配置') !== -1, '/config 返回全局设置页');
    check(pageCfg.text.indexOf('href="/"') !== -1 && pageCfg.text.indexOf('target="_blank"') === -1, '设置页与主页面在当前标签页内互跳');
    const pageCfg2 = await request(portA, 'GET', '/config.html');
    check(pageCfg2.status === 200, '/config.html 兼容访问');

    // 非法值归一化（不含端口，避免误切端口）
    const bad = await request(portA, 'POST', '/api/config', {
      notificationDuration: 'abc',
      maxCatchupHours: 0,
      muted: 'yes',
      autoStart: 'false',
      enableCatchupCheck: 'no'
    });
    check(bad.json && bad.json.code === 0, '提交非法值仍返回 code=0');
    const bd = bad.json.data;
    check(bd.notificationDuration === 5, '非数字时长回落默认 5', String(bd.notificationDuration));
    check(bd.maxCatchupHours === 1, '0 小时夹到下限 1', String(bd.maxCatchupHours));
    check(bd.muted === true, '字符串 yes 解析为 true', String(bd.muted));
    check(bd.autoStart === false, '字符串 false 解析为 false（不误判为真）', String(bd.autoStart));
    check(bd.enableCatchupCheck === false, '字符串 no 解析为 false', String(bd.enableCatchupCheck));

    const persisted = readConfigFile(dirA);
    check(persisted.notificationDuration === 5 && persisted.maxCatchupHours === 1 && persisted.muted === true,
      '归一化后的值已落盘 config.json', JSON.stringify(persisted));

    // 非对象请求体被拒绝
    const badBody = await request(portA, 'POST', '/api/config', [1, 2, 3]);
    check(badBody.status === 500 && badBody.json && badBody.json.code === -1, '数组请求体被拒绝', String(badBody.status));

    /* ============ 2. 静音开关是否真的拦住了通知 ============ */
    console.log('\n[2] 校验静音开关（muted）');
    await request(portA, 'POST', '/api/config', { muted: true });
    const rMuted = await request(portA, 'POST', '/api/reminders', {
      name: '静音测试', cronExpr: '*/1 * * * * *', content: '静音期间不应弹气泡', enabled: true
    });
    const mutedId = rMuted.json.data.id;
    await sleep(3000);
    check(s1.hasLog(/触发提醒: 静音测试/), '秒级任务按时触发（调度正常）');
    check(s1.hasLog(/\[静音\] 已跳过通知: .*静音测试|\[静音\] 已跳过通知: 🕒 定时提醒 - 静音期间不应弹气泡/),
      'muted=true 时通知被拦截并留下日志', s1.logs.slice(-6).join(' | '));

    const beforeUnmuted = s1.countLog(/\[静音\] 已跳过通知/);
    await request(portA, 'DELETE', '/api/reminders/' + mutedId);
    await sleep(1500);
    await request(portA, 'POST', '/api/config', { muted: false });
    const rLoud = await request(portA, 'POST', '/api/reminders', {
      name: '对照测试', cronExpr: '*/2 * * * * *', content: '静音关闭后的对照通知', enabled: true
    });
    const loudId = rLoud.json.data.id;
    await sleep(4000);
    check(s1.hasLog(/触发提醒: 对照测试/), 'muted=false 时任务照常触发');
    const afterUnmuted = s1.countLog(/\[静音\] 已跳过通知/);
    check(afterUnmuted === beforeUnmuted,
      '关闭静音后不再产生拦截记录，通知真实发出',
      'before=' + beforeUnmuted + ' after=' + afterUnmuted);
    check(!s1.hasLog(/静音关闭后的对照通知/), '该通知走的是真实通知分支而非静音分支');
    await request(portA, 'DELETE', '/api/reminders/' + loudId);

    /* ============ 3. 端口热切换 + 占用回滚 ============ */
    console.log('\n[3] 校验 webPort（热切换）');
    const switchRes = await request(portA, 'POST', '/api/config', { webPort: portB });
    check(switchRes.json && switchRes.json.applied.port.ok === true, '端口切换成功', JSON.stringify(switchRes.json && switchRes.json.applied));
    check(switchRes.json.data.webPort === portB, '配置里记录的是新端口', String(switchRes.json.data.webPort));
    const afterSwitch = await waitForApi(portB, 5000);
    check(afterSwitch.runtime.activePort === portB, '新端口已实际监听', String(afterSwitch.runtime.activePort));
    let oldClosed = false;
    try {
      await request(portA, 'GET', '/api/config');
    } catch (e) {
      oldClosed = true;
    }
    check(oldClosed, '旧端口已关闭');
    check(readConfigFile(dirA).webPort === portB, '新端口已写入 config.json');
    check(s1.hasLog(new RegExp('服务端口已切换: ' + portA + ' -> ' + portB)), '切换有日志留痕');

    // 端口被占用 -> 回滚（自己占一个端口，不依赖外部环境）
    const blocker = net.createServer();
    await new Promise(r => blocker.listen(0, r));
    const occupiedPort = blocker.address().port;
    const busyRes = await request(portB, 'POST', '/api/config', { webPort: occupiedPort });
    const busyApplied = busyRes.json.applied.port;
    check(busyApplied.ok === false, '切换到被占用端口失败', JSON.stringify(busyApplied));
    check(busyRes.json.data.webPort === portB,
      '端口切换失败时配置回滚到实际端口', JSON.stringify(busyRes.json.data));
    const stillOnB = await request(portB, 'GET', '/api/config');
    check(stillOnB.json.runtime.activePort === portB, '回滚后服务仍在原端口监听');
    await new Promise(r => blocker.close(r));

    /* ============ 4. 补提醒开关 / 回溯时长（启动时读取） ============ */
    console.log('\n[4] 校验 enableCatchupCheck / maxCatchupHours（启动时生效）');
    const port4a = await freePort();
    const port4b = await freePort();
    const port4c = await freePort();

    // 4a 关闭补提醒
    const now = Date.now();
    writeConfigFile(dirB, { muted: true, notificationDuration: 5, maxCatchupHours: 48, webPort: port4a, autoStart: false, enableCatchupCheck: false });
    fs.writeFileSync(path.join(dirB, 'reminders.json'), JSON.stringify([{
      id: 'rem_t1', name: '补提醒用例', cronExpr: '0 * * * * *', content: '回溯测试',
      enabled: true, lastFiredTimestamp: now - 90 * 1000, lastCatchupTimestamp: now - 90 * 1000, jumpUrl: ''
    }], null, 2));
    const s2 = new Server(dirB, port4a);
    servers.push(s2);
    await waitForApi(port4a);
    await sleep(1200);
    check(s2.hasLog(/补提醒功能已关闭，跳过回溯检查/), 'enableCatchupCheck=false 时跳过回溯');
    check(!s2.hasLog(/补提醒触发/), '关闭时没有补提醒通知');
    await s2.stop();

    // 4b 回溯窗口外的旧提醒不补发：触发点固定在 2 小时前的那个整点，超出 1 小时窗口
    const outsideHour = (new Date(now).getHours() + 22) % 24;
    writeConfigFile(dirB, { muted: true, notificationDuration: 5, maxCatchupHours: 1, webPort: port4b, autoStart: false, enableCatchupCheck: true });
    fs.writeFileSync(path.join(dirB, 'reminders.json'), JSON.stringify([{
      id: 'rem_t1', name: '补提醒用例', cronExpr: '0 0 ' + outsideHour + ' * * *', content: '回溯测试',
      enabled: true, lastFiredTimestamp: now - 2 * 3600 * 1000, lastCatchupTimestamp: now - 2 * 3600 * 1000, jumpUrl: ''
    }], null, 2));
    const s3 = new Server(dirB, port4b);
    servers.push(s3);
    await waitForApi(port4b);
    await sleep(1200);
    check(s3.hasLog(/关机补提醒检查完成/), '开启补提醒时会执行回溯检查');
    check(!s3.hasLog(/补提醒触发/), 'maxCatchupHours=1 时 2 小时前的提醒不补发');
    await s3.stop();

    // 4c 窗口内的提醒会补发（静音下只留日志）
    writeConfigFile(dirB, { muted: true, notificationDuration: 5, maxCatchupHours: 48, webPort: port4c, autoStart: false, enableCatchupCheck: true });
    fs.writeFileSync(path.join(dirB, 'reminders.json'), JSON.stringify([{
      id: 'rem_t1', name: '补提醒用例', cronExpr: '0 * * * * *', content: '回溯测试',
      enabled: true, lastFiredTimestamp: now - 90 * 1000, lastCatchupTimestamp: now - 90 * 1000, jumpUrl: ''
    }], null, 2));
    const s4 = new Server(dirB, port4c);
    servers.push(s4);
    await waitForApi(port4c);
    await sleep(1200);
    check(s4.hasLog(/补提醒触发: 补提醒用例/), 'maxCatchupHours=48 且窗口内的提醒会补发');
    check(s4.hasLog(/\[静音\] 已跳过通知: 📌 补提醒/), '补提醒同样受静音开关约束');
    const catchupFile = JSON.parse(fs.readFileSync(path.join(dirB, 'reminders.json'), 'utf-8'));
    check(catchupFile[0].lastCatchupTimestamp > now - 90 * 1000, '补发后 lastCatchupTimestamp 已更新');
    await s4.stop();

    /* ---- 4d. 已经正常触发过的那一秒，不能在启动时再补一次 ---- */
    const dirD = makeDir('d');
    const port4d = await freePort();
    const nowD = Date.now();
    const noon = new Date();
    noon.setHours(12, 0, 0, 0);
    let lastNoon = noon.getTime();
    if (lastNoon > nowD) lastNoon -= 24 * 3600 * 1000; // 今天还没到 12 点就用昨天的
    seedDir(dirD, { muted: true, notificationDuration: 5, maxCatchupHours: 48, webPort: port4d, autoStart: false, enableCatchupCheck: true }, [{
      id: 'rem_noon', name: '已触发不重复', cronExpr: '0 0 12 * * *', content: '中午提醒',
      enabled: true, lastFiredTimestamp: lastNoon, lastCatchupTimestamp: lastNoon, jumpUrl: ''
    }]);
    const sD = new Server(dirD, port4d);
    servers.push(sD);
    await waitForApi(port4d);
    await sleep(1200);
    check(!sD.hasLog(/补提醒触发/), '已正常触发过的点不会在启动时重复补发');
    check(readReminders(dirD)[0].lastCatchupTimestamp === lastNoon, '该提醒的时间戳没有被误推进');
    await sD.stop();

    /* ---- 4e. 真错过时补一条，且重启不重复 ---- */
    const dirE = makeDir('e');
    const port4e = await freePort();
    const port4e2 = await freePort();
    const nowE = Date.now();
    const anchorE = nowE - 40 * 60 * 1000;
    seedDir(dirE, { muted: true, notificationDuration: 5, maxCatchupHours: 48, webPort: port4e, autoStart: false, enableCatchupCheck: true }, [{
      id: 'rem_miss', name: '真错过用例', cronExpr: '0 */30 * * * *', content: '半小时提醒',
      enabled: true, lastFiredTimestamp: anchorE, lastCatchupTimestamp: anchorE, jumpUrl: ''
    }]);
    const sE1 = new Server(dirE, port4e);
    servers.push(sE1);
    await waitForApi(port4e);
    await sleep(1200);
    check(sE1.countLog(/补提醒触发/) === 1, '确实错过时只补一条最近的点', String(sE1.countLog(/补提醒触发/)));
    check(sE1.hasLog(/补提醒触发: 真错过用例/), '补提醒指向正确的提醒');
    const fileE = readReminders(dirE)[0];
    check(fileE.lastCatchupTimestamp > anchorE && fileE.lastCatchupTimestamp <= nowE,
      '补提醒后基准推进到那个错过点', String(fileE.lastCatchupTimestamp));
    await sE1.stop();

    seedDir(dirE, { muted: true, notificationDuration: 5, maxCatchupHours: 48, webPort: port4e2, autoStart: false, enableCatchupCheck: true }, [{
      id: 'rem_miss', name: '真错过用例', cronExpr: '0 */30 * * * *', content: '半小时提醒',
      enabled: true, lastFiredTimestamp: fileE.lastFiredTimestamp, lastCatchupTimestamp: fileE.lastCatchupTimestamp, jumpUrl: ''
    }]);
    const sE2 = new Server(dirE, port4e2);
    servers.push(sE2);
    await waitForApi(port4e2);
    await sleep(1200);
    check(!sE2.hasLog(/补提醒触发/), '紧接着重启不会重复补同一条');
    await sE2.stop();

    /* ---- 4f. 时间戳缺失（老数据）时不做回溯 ---- */
    const dirF = makeDir('f');
    const port4f = await freePort();
    const nowF = Date.now();
    seedDir(dirF, { muted: true, notificationDuration: 5, maxCatchupHours: 48, webPort: port4f, autoStart: false, enableCatchupCheck: true }, [{
      id: 'rem_zero', name: '缺时间戳', cronExpr: '0 * * * * *', content: '老数据',
      enabled: true, lastFiredTimestamp: 0, lastCatchupTimestamp: 0, jumpUrl: ''
    }]);
    const sF = new Server(dirF, port4f);
    servers.push(sF);
    await waitForApi(port4f);
    await sleep(1200);
    check(!sF.hasLog(/补提醒触发/), '时间戳缺失时不做回溯，避免一启动补一堆旧提醒');
    const fileF = readReminders(dirF)[0];
    check(fileF.lastFiredTimestamp > nowF - 5000 && fileF.lastCatchupTimestamp > nowF - 5000,
      '缺失的时间戳被初始化为当前时间', JSON.stringify([fileF.lastFiredTimestamp, fileF.lastCatchupTimestamp]));
    await sF.stop();

    /* ---- 4g. 基准早于回溯窗口时，窗口内真正错过的点仍要补 ---- */
    const dirG = makeDir('g');
    const port4g = await freePort();
    const nowG = Date.now();
    seedDir(dirG, { muted: true, notificationDuration: 5, maxCatchupHours: 48, webPort: port4g, autoStart: false, enableCatchupCheck: true }, [{
      id: 'rem_old', name: '超窗基准', cronExpr: '0 * * * * *', content: '每分钟提醒',
      enabled: true, lastFiredTimestamp: nowG - 5 * 24 * 3600 * 1000, lastCatchupTimestamp: nowG - 5 * 24 * 3600 * 1000, jumpUrl: ''
    }]);
    const sG = new Server(dirG, port4g);
    servers.push(sG);
    await waitForApi(port4g);
    await sleep(1200);
    check(sG.countLog(/补提醒触发/) === 1, '基准超出回溯窗口时仍补窗口内最近的点', String(sG.countLog(/补提醒触发/)));
    await sG.stop();

    /* ============ 5. 开机自启（真实注册表写入/移除） ============ */
    console.log('\n[5] 校验 autoStart（注册表 HKCU Run）');
    regCleanup(); // 先保证测试前是干净状态
    const port5 = await freePort();
    const s5 = new Server(dirC, port5);
    servers.push(s5);
    await waitForApi(port5);
    await request(port5, 'POST', '/api/config', { webPort: port5 }); // 对齐配置端口，避免自启测试时触发热切换

    const onRes = await request(port5, 'POST', '/api/config', { autoStart: true });
    check(onRes.json.applied.autoStart.ok === true, 'autoStart=true 写入成功', JSON.stringify(onRes.json.applied.autoStart));
    check(regQuery().indexOf(AUTOSTART_VALUE) !== -1, '注册表已出现自启项');
    const rt1 = await request(port5, 'GET', '/api/config');
    check(rt1.json.runtime.autoStartEnabled === true, '运行时状态显示自启已开启');

    const offRes = await request(port5, 'POST', '/api/config', { autoStart: false });
    check(offRes.json.applied.autoStart.ok === true, 'autoStart=false 移除成功', JSON.stringify(offRes.json.applied.autoStart));
    check(regQuery().indexOf(AUTOSTART_VALUE) === -1, '注册表自启项已移除');
    const rt2 = await request(port5, 'GET', '/api/config');
    check(rt2.json.runtime.autoStartEnabled === false, '运行时状态显示自启已关闭');
    check(readConfigFile(dirC).autoStart === false, 'config.json 记录 autoStart=false');
  } catch (e) {
    console.error('\n测试脚本异常:', e);
    for (const s of servers) {
      console.error('--- 实例日志 (dataDir=' + s.dataDir + ', port=' + s.port + ') ---');
      console.error(s.logs.join('\n'));
    }
    throw e;
  } finally {
    for (const s of servers) {
      try { await s.stop(); } catch (e) { /* ignore */ }
    }
    regCleanup();
    for (const d of allDirs) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    }
  }

  console.log('\n================ 结果 ================');
  console.log('通过: ' + pass + '  失败: ' + fail);
  if (fail) {
    console.log('失败项:');
    failures.forEach(f => console.log(' - ' + f));
    process.exit(1);
  }
  console.log('全部配置项均在后台生效。');
}

main().catch(e => {
  console.error('测试脚本异常:', e);
  regCleanup();
  process.exit(1);
});
