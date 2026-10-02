// Code.gs を Node でそのまま動かすための、Google Apps Script の最小の模擬。
// スプレッドシート（シート・範囲・追記・検索）、キャッシュ、ロック、スクリプトプロパティ、
// ContentService、Utilities.formatDate を、Code.gs が使う分だけ真似る。
// 本物の Google には一切つながらない。
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

/** 知らないメソッドは「何もしないで自分を返す」（書式・入力規則・条件付き書式などの飾り） */
function noop() {
  const p = new Proxy(function () {}, {
    get: (t, k) => (k === 'then' ? undefined : p),
    apply: () => p,
  });
  return p;
}

class Sheet {
  constructor(name) { this.name = name; this.data = []; }
  getName() { return this.name; }
  getLastRow() {
    for (let r = this.data.length; r > 0; r--) if ((this.data[r - 1] || []).some(v => v !== '' && v != null)) return r;
    return 0;
  }
  getLastColumn() {
    let c = 0;
    this.data.forEach(row => { for (let i = (row || []).length; i > c; i--) if (row[i - 1] !== '' && row[i - 1] != null) { c = i; break; } });
    return c;
  }
  getMaxRows() { return Math.max(1000, this.data.length); }
  getMaxColumns() { return Math.max(26, this.getLastColumn()); }
  cell(r, c) { const row = this.data[r - 1]; return row && row[c - 1] !== undefined ? row[c - 1] : ''; }
  set(r, c, v) {
    while (this.data.length < r) this.data.push([]);
    const row = this.data[r - 1];
    while (row.length < c) row.push('');
    row[c - 1] = v;
  }
  getRange(a, b, c, d) {
    if (typeof a === 'string') return noop();          // 'B:B' など（書式を付けるだけ）
    return new Range(this, a, b, c || 1, d || 1);
  }
  getDataRange() { return new Range(this, 1, 1, Math.max(1, this.getLastRow()), Math.max(1, this.getLastColumn())); }
  appendRow(row) { const r = this.getLastRow() + 1; row.forEach((v, i) => this.set(r, i + 1, v)); return this; }
  deleteRow(r) { this.data.splice(r - 1, 1); }
  deleteRows(r, n) { this.data.splice(r - 1, n); }
  insertRowsAfter() { return this; }
  insertColumnsAfter() { return this; }
}
// 書式などの飾りのメソッドは何もしない
['setFrozenRows', 'setColumnWidth', 'autoResizeColumns', 'setTabColor', 'hideSheet', 'setConditionalFormatRules',
 'getConditionalFormatRules', 'sort', 'activate', 'protect', 'clearConditionalFormatRules'].forEach(m => {
  Sheet.prototype[m] = function () { return m === 'getConditionalFormatRules' ? [] : this; };
});

class Range {
  constructor(sh, r, c, nr, nc) { Object.assign(this, { sh, r, c, nr, nc }); }
  getRow() { return this.r; }
  getColumn() { return this.c; }
  getValues() {
    const out = [];
    for (let i = 0; i < this.nr; i++) { const row = []; for (let j = 0; j < this.nc; j++) row.push(this.sh.cell(this.r + i, this.c + j)); out.push(row); }
    return out;
  }
  getDisplayValues() { return this.getValues().map(r => r.map(v => String(v))); }
  getValue() { return this.sh.cell(this.r, this.c); }
  setValues(v) {
    if (v.length !== this.nr || v.some(row => row.length !== this.nc)) throw new Error('範囲と値の大きさが違います');
    v.forEach((row, i) => row.forEach((x, j) => this.sh.set(this.r + i, this.c + j, x)));
    return this;
  }
  setValue(v) { this.sh.set(this.r, this.c, v); return this; }
  createTextFinder(text) {
    const self = this;
    let entire = false, matchCase = false;
    const hits = () => {
      const out = [];
      for (let i = 0; i < self.nr; i++) for (let j = 0; j < self.nc; j++) {
        const v = String(self.sh.cell(self.r + i, self.c + j));
        const a = matchCase ? v : v.toLowerCase(), b = matchCase ? String(text) : String(text).toLowerCase();
        if (entire ? a === b : a.includes(b)) out.push(new Range(self.sh, self.r + i, self.c + j, 1, 1));
      }
      return out;
    };
    const f = {
      matchCase(x) { matchCase = x !== false; return f; },
      matchEntireCell(x) { entire = x !== false; return f; },
      findNext() { return hits()[0] || null; },
      findAll() { return hits(); },
    };
    return f;
  }
}
// 書式などの飾り
['setFontWeight', 'setNumberFormat', 'setBackground', 'setDataValidation', 'setFontColor', 'setHorizontalAlignment',
 'setNote', 'clearContent', 'clearDataValidations', 'setWrap', 'setFontSize'].forEach(m => {
  Range.prototype[m] = function () { return this; };
});

class Spreadsheet {
  constructor() { this.sheets = []; }
  getSheetByName(n) { return this.sheets.find(s => s.name === n) || null; }
  insertSheet(n) {
    if (this.getSheetByName(n)) throw new Error('同じ名前のシートがあります：' + n);
    const s = new Sheet(n); this.sheets.push(s); return s;
  }
  getSheets() { return this.sheets.slice(); }
  getId() { return 'TEST'; }
  getSpreadsheetTimeZone() { return 'Asia/Tokyo'; }
  setSpreadsheetTimeZone() {}
}

function formatDate(d, tz, fmt) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: tz || 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(d)).map(p => [p.type, p.value]));
  return fmt.replace(/yyyy|MM|dd|HH|H|mm|ss/g, t => ({
    yyyy: parts.year, MM: parts.month, dd: parts.day, HH: parts.hour, H: String(Number(parts.hour)), mm: parts.minute, ss: parts.second,
  })[t]);
}

/**
 * 新しい模擬の環境に Code.gs を読み込む。
 * @param {{props?: object}} opt スクリプトプロパティ（ADMIN_PASS など）
 * @returns 実行環境（Code.gs の関数・変数がそのまま生える）と、中身をのぞくための ss・cache
 */
function loadGas(opt = {}) {
  const ss = new Spreadsheet();
  const cache = new Map();
  const props = Object.assign({}, opt.props || {});
  const ctx = {
    console: { log() {}, warn() {}, error() {} },
    Logger: { log() {} },
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ss, openById: () => ss, flush() {},
      newDataValidation: noop, newConditionalFormatRule: noop,
      DataValidationCriteria: noop(), BorderStyle: noop(),
    },
    CacheService: {
      getScriptCache: () => ({
        get: k => (cache.has(k) ? cache.get(k) : null),
        put: (k, v) => { cache.set(k, String(v)); },
        remove: k => { cache.delete(k); },
        getAll: ks => Object.fromEntries(ks.filter(k => cache.has(k)).map(k => [k, cache.get(k)])),
        putAll: o => Object.entries(o).forEach(([k, v]) => cache.set(k, String(v))),
        removeAll: ks => ks.forEach(k => cache.delete(k)),
      }),
    },
    LockService: { getScriptLock: () => ({ tryLock: () => true, waitLock() {}, releaseLock() {}, hasLock: () => true }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = v; } }) },
    ContentService: {
      MimeType: { JSON: 'json', TEXT: 'text' },
      createTextOutput: t => { const o = { content: t, setMimeType() { return o; }, getContent: () => t }; return o; },
    },
    Utilities: { formatDate, sleep() {} },
    Session: { getScriptTimeZone: () => 'Asia/Tokyo' },
    ScriptApp: { getProjectTriggers: () => [], deleteTrigger() {}, newTrigger: noop },
    Date, JSON, Math, String, Number, Array, Object, RegExp, Error, isNaN, isFinite, encodeURIComponent, unescape, escape, parseInt, parseFloat,
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8'), ctx, { filename: 'Code.gs' });
  ctx.__ss = ss; ctx.__cache = cache; ctx.__props = props;
  /** GET を送って JSON を受け取る */
  ctx.__get = (param = {}) => JSON.parse(ctx.doGet({ parameter: param }).getContent());
  /** POST を送って JSON を受け取る */
  ctx.__post = body => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(body) } }).getContent());
  return ctx;
}

module.exports = { loadGas };
