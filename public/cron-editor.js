// 中文图形化 Cron 编辑器
(function() {
  const DAYS_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const MONTHS_CN = ['一月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '十一月', '十二月'];

  class CronEditor {
    constructor(container, options) {
      this.container = container;
      this.options = options || {};
      this.value = this.options.initial || '0 * * * * *';
      this.onChange = this.options.onChange || function() {};
      this.init();
    }

    init() {
      this.render();
      this.bindEvents();
      this.setValue(this.value);
    }

    render() {
      this.container.innerHTML = `
        <div class="cron-editor">
          <div class="cron-tabs">
            <span class="cron-tab active" data-tab="second">秒</span>
            <span class="cron-tab" data-tab="minute">分</span>
            <span class="cron-tab" data-tab="hour">时</span>
            <span class="cron-tab" data-tab="dom">日</span>
            <span class="cron-tab" data-tab="month">月</span>
            <span class="cron-tab" data-tab="dow">周</span>
          </div>

          <!-- 秒面板 -->
          <div class="cron-panel active" data-panel="second">
            <div class="cron-row">
              <label><input type="radio" name="sec-mode" value="*"> 每秒</label>
            </div>
            <div class="cron-row">
              <label><input type="radio" name="sec-mode" value="cycle"> 周期：从第 <input type="number" min="0" max="59" class="sec-from" value="0"> 秒到 <input type="number" min="0" max="59" class="sec-to" value="59"> 秒</label>
            </div>
            <div class="cron-row">
              <label><input type="radio" name="sec-mode" value="step"> 从第 <input type="number" min="0" max="59" class="sec-step-start" value="0"> 秒开始，每隔 <input type="number" min="1" max="59" class="sec-step" value="10"> 秒</label>
            </div>
            <div class="cron-row">
              <label><input type="radio" name="sec-mode" value="spec">指定秒</label>
            </div>
            <div class="cron-check-group sec-checks"></div>
          </div>

          <!-- 分面板 -->
          <div class="cron-panel" data-panel="minute">
            <div class="cron-row">
              <label><input type="radio" name="min-mode" value="*"> 每分钟</label>
            </div>
            <div class="cron-row">
              <label><input type="radio" name="min-mode" value="cycle"> 周期：从第 <input type="number" min="0" max="59" class="min-from" value="0"> 分到 <input type="number" min="0" max="59" class="min-to" value="59"> 分</label>
            </div>
            <div class="cron-row">
              <label><input type="radio" name="min-mode" value="step"> 从第 <input type="number" min="0" max="59" class="min-step-start" value="0"> 分开始，每隔 <input type="number" min="1" max="59" class="min-step" value="10"> 分钟</label>
            </div>
            <div class="cron-row">
              <label><input type="radio" name="min-mode" value="spec">指定分</label>
            </div>
            <div class="cron-check-group min-checks"></div>
          </div>

          <!-- 时面板 -->
          <div class="cron-panel" data-panel="hour">
            <div class="cron-row">
              <label><input type="radio" name="hour-mode" value="*"> 每小时</label>
            </div>
            <div class="cron-row">
              <label><input type="radio" name="hour-mode" value="cycle"> 周期：从 <input type="number" min="0" max="23" class="hour-from" value="0"> 点到 <input type="number" min="0" max="23" class="hour-to" value="23"> 点</label>
            </div>
            <div class="cron-row">
              <label><input type="radio" name="hour-mode" value="step"> 从 <input type="number" min="0" max="23" class="hour-step-start" value="0"> 点开始，每隔 <input type="number" min="1" max="23" class="hour-step" value="2"> 小时</label>
            </div>
            <div class="cron-row">
              <label><input type="radio" name="hour-mode" value="spec">指定小时</label>
            </div>
            <div class="cron-check-group hour-checks"></div>
          </div>

          <!-- 日面板 -->
          <div class="cron-panel" data-panel="dom">
            <div class="cron-row">
              <label><input type="radio" name="dom-mode" value="*"> 每天</label>
            </div>
            <div class="cron-row">
              <label><input type="radio" name="dom-mode" value="cycle"> 周期：从 <input type="number" min="1" max="31" class="dom-from" value="1"> 号到 <input type="number" min="1" max="31" class="dom-to" value="31"> 号</label>
            </div>
            <div class="cron-row">
              <label><input type="radio" name="dom-mode" value="step"> 从 <input type="number" min="1" max="31" class="dom-step-start" value="1"> 号开始，每隔 <input type="number" min="1" max="31" class="dom-step" value="2"> 天</label>
            </div>
            <div class="cron-row">
              <label><input type="radio" name="dom-mode" value="spec">指定日期</label>
            </div>
            <div class="cron-check-group dom-checks"></div>
          </div>

          <!-- 月面板 -->
          <div class="cron-panel" data-panel="month">
            <div class="cron-row">
              <label><input type="radio" name="mon-mode" value="*"> 每月</label>
            </div>
            <div class="cron-row">
              <label><input type="radio" name="mon-mode" value="cycle"> 周期：从 <input type="number" min="1" max="12" class="mon-from" value="1"> 月到 <input type="number" min="1" max="12" class="mon-to" value="12"> 月</label>
            </div>
            <div class="cron-row">
              <label><input type="radio" name="mon-mode" value="step"> 从 <input type="number" min="1" max="12" class="mon-step-start" value="1"> 月开始，每隔 <input type="number" min="1" max="12" class="mon-step" value="2"> 月</label>
            </div>
            <div class="cron-row">
              <label><input type="radio" name="mon-mode" value="spec">指定月份</label>
            </div>
            <div class="cron-check-group mon-checks"></div>
          </div>

          <!-- 周面板 -->
          <div class="cron-panel" data-panel="dow">
            <div class="cron-row">
              <label><input type="radio" name="dow-mode" value="*"> 每周每天</label>
            </div>
            <div class="cron-row">
              <label><input type="radio" name="dow-mode" value="spec">指定星期</label>
            </div>
            <div class="cron-check-group dow-checks"></div>
          </div>

          <div class="cron-desc">
            生成的 Cron 表达式：<code class="cron-output">0 * * * * *</code>
          </div>
        </div>
      `;

      // 生成秒复选框 0-59
      const secBox = this.container.querySelector('.sec-checks');
      for (let i = 0; i < 60; i++) {
        secBox.innerHTML += `<span class="cron-check-item" data-val="${i}">${i}秒</span>`;
      }
      // 生成分复选框 0-59
      const minBox = this.container.querySelector('.min-checks');
      for (let i = 0; i < 60; i++) {
        minBox.innerHTML += `<span class="cron-check-item" data-val="${i}">${i}分</span>`;
      }
      // 生成小时复选框 0-23
      const hourBox = this.container.querySelector('.hour-checks');
      for (let i = 0; i < 24; i++) {
        hourBox.innerHTML += `<span class="cron-check-item" data-val="${i}">${i}时</span>`;
      }
      // 生成日期复选框 1-31
      const domBox = this.container.querySelector('.dom-checks');
      for (let i = 1; i <= 31; i++) {
        domBox.innerHTML += `<span class="cron-check-item" data-val="${i}">${i}日</span>`;
      }
      // 生成月份复选框 1-12
      const monBox = this.container.querySelector('.mon-checks');
      for (let i = 1; i <= 12; i++) {
        monBox.innerHTML += `<span class="cron-check-item" data-val="${i}">${MONTHS_CN[i-1]}</span>`;
      }
      // 生成星期复选框 0-6
      const dowBox = this.container.querySelector('.dow-checks');
      for (let i = 0; i < 7; i++) {
        dowBox.innerHTML += `<span class="cron-check-item" data-val="${i}">${DAYS_CN[i]}</span>`;
      }
    }

    bindEvents() {
      // 标签页切换
      this.container.querySelectorAll('.cron-tab').forEach(tab => {
        tab.addEventListener('click', () => {
          this.container.querySelectorAll('.cron-tab').forEach(t => t.classList.remove('active'));
          this.container.querySelectorAll('.cron-panel').forEach(p => p.classList.remove('active'));
          tab.classList.add('active');
          this.container.querySelector(`.cron-panel[data-panel="${tab.dataset.tab}"]`).classList.add('active');
        });
      });

      // 复选框点击切换
      this.container.querySelectorAll('.cron-check-item').forEach(item => {
        item.addEventListener('click', () => {
          item.classList.toggle('checked');
          this.updateValue();
        });
      });

      // 所有单选和输入框变化时更新值
      this.container.querySelectorAll('input[type="radio"], input[type="number"]').forEach(el => {
        el.addEventListener('change', () => this.updateValue());
      });
    }

    parsePart(prefix) {
      const mode = this.container.querySelector(`input[name="${prefix}-mode"]:checked`);
      if (!mode) return '*';
      switch(mode.value) {
        case '*': return '*';
        case 'cycle':
          const f = parseInt(this.container.querySelector(`.${prefix}-from`).value, 10);
          const t = parseInt(this.container.querySelector(`.${prefix}-to`).value, 10);
          return `${f}-${t}`;
        case 'step':
          const st = parseInt(this.container.querySelector(`.${prefix}-step-start`).value, 10);
          const sp = parseInt(this.container.querySelector(`.${prefix}-step`).value, 10);
          return `*/${sp}`;
        case 'spec':
          const checks = Array.from(this.container.querySelectorAll(`.${prefix}-checks .cron-check-item.checked`));
          if (checks.length === 0) return '*';
          return checks.map(c => c.dataset.val).join(',');
        default:
          return '*';
      }
    }

    updateValue() {
      const parts = [
        this.parsePart('sec'),
        this.parsePart('min'),
        this.parsePart('hour'),
        this.parsePart('dom'),
        this.parsePart('mon'),
        this.parsePart('dow')
      ];
      this.value = parts.join(' ');
      this.container.querySelector('.cron-output').textContent = this.value;
      this.onChange.call(this);
    }

    setPart(prefix, val, maxVal) {
      // 周字段里 7 与 0 等价，先归一，避免 7 找不到复选框而被清成 *
      if (prefix === 'dow') val = val.replace(/\b7\b/g, '0');
      const modeRadio = this.container.querySelector(`input[name="${prefix}-mode"][value]`);
      const allRadios = this.container.querySelectorAll(`input[name="${prefix}-mode"]`);

      // 先清空所有选中
      allRadios.forEach(r => r.checked = false);
      this.container.querySelectorAll(`.${prefix}-checks .cron-check-item`).forEach(c => c.classList.remove('checked'));

      if (val === '*') {
        this.container.querySelector(`input[name="${prefix}-mode"][value="*"]`).checked = true;
        return;
      }
      if (val.startsWith('*/')) {
        const step = parseInt(val.slice(2), 10);
        this.container.querySelector(`input[name="${prefix}-mode"][value="step"]`).checked = true;
        this.container.querySelector(`.${prefix}-step`).value = step;
        this.container.querySelector(`.${prefix}-step-start`).value = 0;
        return;
      }
      if (val.includes('-') && !val.includes(',')) {
        const [f, t] = val.split('-').map(Number);
        this.container.querySelector(`input[name="${prefix}-mode"][value="cycle"]`).checked = true;
        this.container.querySelector(`.${prefix}-from`).value = f;
        this.container.querySelector(`.${prefix}-to`).value = t;
        return;
      }
      // 指定值模式
      this.container.querySelector(`input[name="${prefix}-mode"][value="spec"]`).checked = true;
      val.split(',').forEach(v => {
        const item = this.container.querySelector(`.${prefix}-checks .cron-check-item[data-val="${v.trim()}"]`);
        if (item) item.classList.add('checked');
      });
    }

    setValue(expr) {
      const text = String(expr == null ? '' : expr).trim();
      const parts = (text || '0 * * * * *').split(/\s+/);
      if (parts.length === 5) parts.unshift('0');
      if (parts.length !== 6) return;
      this.setPart('sec', parts[0], 59);
      this.setPart('min', parts[1], 59);
      this.setPart('hour', parts[2], 23);
      this.setPart('dom', parts[3], 31);
      this.setPart('mon', parts[4], 12);
      this.setPart('dow', parts[5], 6);
      this.updateValue();
    }

    getValue() {
      return this.value;
    }
  }

  // 挂载到全局
  window.CronEditor = CronEditor;
})();