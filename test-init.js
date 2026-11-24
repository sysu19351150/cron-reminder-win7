const fs = require('fs');
const path = require('path');

const DATA_PATH = path.join(__dirname, 'data', 'reminders.json');

// 预设测试案例
const testReminders = [
  {
    id: 'rem_1',
    name: '30秒测试提醒',
    cronExpr: '*/30 * * * * *',
    content: '✅ 测试成功！每30秒触发一次的定时提醒正常工作',
    enabled: true
  },
  {
    id: 'rem_2',
    name: '整点测试提醒',
    cronExpr: '0 * * * * *',
    content: '⏰ 整点到啦，这是每分钟触发的测试提醒',
    enabled: false
  },
  {
    id: 'rem_3',
    name: '下班提醒',
    cronExpr: '0 0 18 * * *',
    content: '🏠 到点下班啦，记得打卡收拾东西回家',
    enabled: false
  }
];

// 写入测试数据
fs.writeFileSync(DATA_PATH, JSON.stringify(testReminders, null, 2));
console.log('✅ 测试数据已生成，共3条测试提醒');
console.table(testReminders);