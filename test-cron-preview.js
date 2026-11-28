/**
 * Cron 触发时间预览引擎测试
 *
 * 用法：node test-cron-preview.js / npm run test:preview
 *
 * 预览引擎内联在 public/index.html 的 CRON_PREVIEW_START / CRON_PREVIEW_END 之间，
 * 这里直接提取该代码块在 Node VM 中运行，验证与 node-cron 一致的触发时间计算。
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
const match = /\/\* CRON_PREVIEW_START \*\/([\s\S]*?)\/\* CRON_PREVIEW_END \*\//.exec(html);
if (!match) {
  console.error('未在 public/index.html 中找到 CRON_PREVIEW 代码块');
  process.exit(1);
}

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(match[1], sandbox, { filename: 'index.html#cron-preview' });

const CronPreview = sandbox.CronPreview;
if (!CronPreview || typeof CronPreview.next !== 'function') {
  console.error('预览引擎没有导出 CronPreview.next');
  process.exit(1);
}

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

function pad2(n) {
  return n < 10 ? '0' + n : String(n);
}

function fmt(date) {
  return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate()) +
    ' ' + pad2(date.getHours()) + ':' + pad2(date.getMinutes()) + ':' + pad2(date.getSeconds());
}

// 固定基准：2026-11-28（周六）10:00:00
const BASE = new Date(2026, 10, 28, 10, 0, 0);

function times(expr, base) {
  return CronPreview.next(expr, 5, base || BASE).map(fmt);
}

function expectTimes(expr, expected, label) {
  const got = times(expr);
  check(JSON.stringify(got) === JSON.stringify(expected), label, JSON.stringify(got));
}

function expectThrow(expr, label) {
  let threw = false;
  let message = '';
  try {
    CronPreview.next(expr, 5, BASE);
  } catch (e) {
    threw = true;
    message = e.message;
  }
  check(threw, label, message);
}

console.log('测试基准时间: ' + fmt(BASE));

console.log('\n[1] 常用表达式');
expectTimes('0 */30 * * * *', [
  '2026-11-28 10:30:00', '2026-11-28 11:00:00', '2026-11-28 11:30:00',
  '2026-11-28 12:00:00', '2026-11-28 12:30:00'
], '每 30 分钟');

expectTimes('0 0 9 * * *', [
  '2026-11-29 09:00:00', '2026-11-30 09:00:00', '2026-12-01 09:00:00',
  '2026-12-02 09:00:00', '2026-12-03 09:00:00'
], '每天 09:00');

expectTimes('0 0 18 * * 1-5', [
  '2026-11-30 18:00:00', '2026-12-01 18:00:00', '2026-12-02 18:00:00',
  '2026-12-03 18:00:00', '2026-12-04 18:00:00'
], '工作日 18:00 会跳过周末');

expectTimes('0 30 9 * * 1', [
  '2026-11-30 09:30:00', '2026-12-07 09:30:00', '2026-12-14 09:30:00',
  '2026-12-21 09:30:00', '2026-12-28 09:30:00'
], '每周一 09:30');

expectTimes('*/30 * * * * *', [
  '2026-11-28 10:00:30', '2026-11-28 10:01:00', '2026-11-28 10:01:30',
  '2026-11-28 10:02:00', '2026-11-28 10:02:30'
], '每 30 秒');

expectTimes('0 15 9-11 * * *', [
  '2026-11-28 10:15:00', '2026-11-28 11:15:00', '2026-11-29 09:15:00',
  '2026-11-29 10:15:00', '2026-11-29 11:15:00'
], '小时区间 9-11 的第 15 分');

console.log('\n[2] 日期 / 月份 / 星期组合');
expectTimes('0 0 0 */2 * *', [
  '2026-11-30 00:00:00', '2026-12-02 00:00:00', '2026-12-04 00:00:00',
  '2026-12-06 00:00:00', '2026-12-08 00:00:00'
], '日期步长 */2 与 node-cron 一致（偶数日）');

expectTimes('0 0 9 * * 7', [
  '2026-11-29 09:00:00', '2026-12-06 09:00:00', '2026-12-13 09:00:00',
  '2026-12-20 09:00:00', '2026-12-27 09:00:00'
], '周日的 7 等价于 0');

expectTimes('0 0 9 * * 0,7', [
  '2026-11-29 09:00:00', '2026-12-06 09:00:00', '2026-12-13 09:00:00',
  '2026-12-20 09:00:00', '2026-12-27 09:00:00'
], '星期 0,7 去重后仍只有周日');

expectTimes('0 0 9 * * MON', [
  '2026-11-30 09:00:00', '2026-12-07 09:00:00', '2026-12-14 09:00:00',
  '2026-12-21 09:00:00', '2026-12-28 09:00:00'
], '支持英文星期缩写 MON');

expectTimes('0 0 9 1 JAN *', [
  '2027-01-01 09:00:00', '2028-01-01 09:00:00', '2029-01-01 09:00:00',
  '2030-01-01 09:00:00', '2031-01-01 09:00:00'
], '支持英文月份 JAN');

expectTimes('0 0 0 29 2 *', [
  '2028-02-29 00:00:00', '2032-02-29 00:00:00', '2036-02-29 00:00:00',
  '2040-02-29 00:00:00', '2044-02-29 00:00:00'
], '闰年 2 月 29 日');

const andList = CronPreview.next('0 0 0 1 * 1', 5, BASE);
check(andList.length === 5 && andList.every(function (d) { return d.getDate() === 1 && d.getDay() === 1; }),
  '「日 + 周」同时指定时按 AND 计算（与 node-cron 一致）', JSON.stringify(andList.map(fmt)));

check(CronPreview.next('0 0 0 31 2 *', 5, BASE).length === 0,
  '2 月 31 日不会产生触发时间');

console.log('\n[3] 5 段表达式与字段解析');
expectTimes('0 9 * * *', [
  '2026-11-29 09:00:00', '2026-11-30 09:00:00', '2026-12-01 09:00:00',
  '2026-12-02 09:00:00', '2026-12-03 09:00:00'
], '5 段表达式自动补秒 0');

const parsed = CronPreview.parse('0 */30 * * * *');
check(JSON.stringify(parsed.minute) === '[0,30]', '解析分钟 */30 得到 [0,30]', JSON.stringify(parsed.minute));
check(JSON.stringify(parsed.second) === '[0]', '解析秒 0 得到 [0]', JSON.stringify(parsed.second));

const parsedName = CronPreview.parse('0 0 9 * * MON');
check(JSON.stringify(parsedName.dayOfWeek) === '[1]', '解析 MON 得到周一', JSON.stringify(parsedName.dayOfWeek));

console.log('\n[4] 非法表达式');
expectThrow('', '空表达式被拒绝');
expectThrow('   ', '纯空格被拒绝');
expectThrow('abc def', '非数字内容被拒绝');
expectThrow('0 0 24 * * *', '小时 24 越界');
expectThrow('0 60 * * * *', '分钟 60 越界');
expectThrow('0 0 9 32 * *', '日期 32 越界');
expectThrow('0 0 9 * 13 *', '月份 13 越界');
expectThrow('0 0 9 * * 8', '星期 8 越界');
expectThrow('*/0 * * * * *', '步长 0 被拒绝');
expectThrow('0 0 9 * * * *', '7 段表达式被拒绝');
expectThrow('0 0 9 *', '少于 5 段被拒绝');

console.log('\n[5] 图形编辑器回填保护');
const guardStart = html.indexOf('    function canEditorRepresent');
const guardEnd = html.indexOf('    function setEditorWarning');
if (guardStart === -1 || guardEnd === -1 || guardEnd <= guardStart) {
  console.error('未找到 canEditorRepresent 实现');
  process.exit(1);
}
vm.runInContext(html.slice(guardStart, guardEnd), sandbox, { filename: 'index.html#editor-guard' });
const canEditorRepresent = sandbox.canEditorRepresent;

check(canEditorRepresent('0 0 9 * * *') === true, '普通表达式可回填');
check(canEditorRepresent('0 0 9 * *') === true, '5 段表达式可回填');
check(canEditorRepresent('*/30 * * * * *') === true, '步长表达式可回填');
check(canEditorRepresent('0 0 9 * * 7') === true, '周日的 7 可回填（会归一为 0）');
check(canEditorRepresent('0 0 9 * * MON') === false, '英文星期不回填，避免被清成 *');
check(canEditorRepresent('0 0 9 * * 1-5') === false, '星期区间不回填，避免编辑器出错');
check(canEditorRepresent('0 0 0 1-31/2 * *') === false, '带步长的区间不回填');
check(canEditorRepresent('abc') === false, '非法表达式不回填');

console.log('\n================ 结果 ================');
console.log('通过: ' + pass + '  失败: ' + fail);
if (fail) {
  console.log('失败项:');
  failures.forEach(function (f) { console.log(' - ' + f); });
  process.exit(1);
}
console.log('预览引擎计算与 node-cron 语义一致。');
