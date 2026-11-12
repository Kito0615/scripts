/**
 * cookie-watch.js — Quantumult X 请求头 Cookie 监视器
 * ---------------------------------------------------------------------------
 * 用途：命中 QX rewrite 规则的请求到达时，读取其 Cookie 请求头，只挑出你
 *       指定的两个键，把值持久化到 $prefs；当值与上次记录不一致时，发一条
 *       系统通知并更新存储。
 *
 * 不修改请求：脚本任何情况下都以 $done({}) 结束 —— 这是 QX 官方示例中
 *              "Not changed" 的写法，请求头/路径/body 都不动。
 *
 * 运行环境：Quantumult X 的 script-request-header 重写脚本
 *           （必须先为目标域名开启 MitM / HTTPS 解密，否则读不到明文头）
 *
 * 配置见下方 CONFIG；完整说明见同目录 README.md
 * ---------------------------------------------------------------------------
 */
'use strict';

var CONFIG = {
  // ★ 必填：改成你要监视的两个 Cookie 键名（区分大小写、精确匹配）★
  // 例：['sessionid', 'csrftoken']
  // 若留空数组，脚本会通知你「本次请求里有哪些键名」，方便先确认名字。
  cookieKeys: ['pt_key', 'pt_pin'],

  // $prefs 里的键前缀；两个值会额外镜像成 <前缀><键名>，方便别的脚本直接读
  storagePrefix: 'cookie_watch.',

  // 可选：脚本内再做一次 URL 正则过滤（字符串）。留空 = 完全信任 QX 规则
  urlFilter: '',

  notifyTitle: 'Cookie 值已变化',
  maskValue: true,          // 通知里对值脱敏，只显示首尾各几位
  maskHead: 4,
  maskTail: 4,
  notifyOnFirstCapture: true, // 首次建立基线时是否也发一条通知
  copyToPasteboard: false,  // 变化时把完整的两个值写入剪贴板（方便直接粘贴使用）
  logLevel: 1,              // 0 只打错误 / 1 摘要 / 2 调试；日志永不打印明文值
};

var STATE_KEY_SUFFIX = '__state';

/* ------------------------------------------------------------------ */
/* 纯函数区（不依赖 QX 全局，可在 Node 里直接单测）                      */
/* ------------------------------------------------------------------ */

function log(msg, level) {
  level = level || 1;
  if (CONFIG.logLevel >= level && typeof console !== 'undefined' && console.log) {
    console.log('[cookie-watch] ' + msg);
  }
}

/** 大小写不敏感地取请求头；值可能是数组（多个同名头） */
function getHeader(headers, lowerName) {
  if (!headers || typeof headers !== 'object') return '';
  var names = Object.keys(headers);
  for (var i = 0; i < names.length; i++) {
    if (names[i].toLowerCase() !== lowerName) continue;
    var v = headers[names[i]];
    if (v === null || v === undefined) return '';
    if (Array.isArray(v)) return v.join('; ');
    return String(v);
  }
  return '';
}

/** "a=1; b=2=3; c" -> { a:'1', b:'2=3', c:'' } —— 只切第一个等号 */
function parseCookie(raw) {
  var out = {};
  var parts = String(raw || '').split(';');
  for (var i = 0; i < parts.length; i++) {
    var pair = String(parts[i]).replace(/^\s+|\s+$/g, '');
    if (!pair) continue;
    var eq = pair.indexOf('=');
    var name, value;
    if (eq < 0) {
      name = pair;
      value = '';
    } else {
      name = pair.slice(0, eq).replace(/^\s+|\s+$/g, '');
      value = pair.slice(eq + 1).replace(/^\s+|\s+$/g, '');
    }
    if (name) out[name] = value;
  }
  return out;
}

/** 通知里的值脱敏，避免凭证出现在锁屏/通知中心 */
function maskValue(v) {
  var s = String(v === null || v === undefined ? '' : v);
  if (!CONFIG.maskValue) return s;
  var h = CONFIG.maskHead, t = CONFIG.maskTail;
  if (s.length <= h + t + 2) return '***（' + s.length + ' 字符）';
  return s.slice(0, h) + '…' + s.slice(-t) + '（' + s.length + ' 字符）';
}

function isoNow() {
  try { return new Date().toISOString(); } catch (e) { return ''; }
}

function localTime() {
  var d = new Date();
  function p(n) { return n < 10 ? '0' + n : '' + n; }
  return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
         p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

/** 通知里只保留 URL 的路径部分，去掉 query（可能含 token）并限长 */
function shortUrl(url) {
  var s = String(url || '').split('?')[0];
  return s.length > 90 ? s.slice(0, 90) + '…' : s;
}

function loadState(store) {
  var raw = store.get(CONFIG.storagePrefix + STATE_KEY_SUFFIX);
  var s = null;
  if (raw) {
    try { s = JSON.parse(raw); } catch (e) { s = null; }
  }
  if (!s || typeof s !== 'object') s = {};
  if (!s.values || typeof s.values !== 'object') s.values = {};
  if (!s.updatedAt || typeof s.updatedAt !== 'object') s.updatedAt = {};
  if (typeof s.changeCount !== 'number') s.changeCount = 0;
  return s;
}

function buildChangeBody(changes, url) {
  var lines = [];
  for (var i = 0; i < changes.length; i++) {
    var c = changes[i];
    lines.push('· ' + c.key);
    lines.push('   旧：' + maskValue(c.oldVal));
    lines.push('   新：' + maskValue(c.newVal));
  }
  lines.push('');
  lines.push('来源：' + shortUrl(url));
  lines.push('时间：' + localTime());
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* QX 环境适配层                                                        */
/* ------------------------------------------------------------------ */

function qxStore() {
  return {
    get: function (key) {
      try {
        return typeof $prefs !== 'undefined' ? $prefs.valueForKey(key) : undefined;
      } catch (e) { return undefined; }
    },
    set: function (key, value) {
      try {
        // 注意 QX 的参数顺序：值在前，键在后
        return typeof $prefs !== 'undefined' ? $prefs.setValueForKey(value, key) : false;
      } catch (e) { return false; }
    },
  };
}

function qxNotify(title, subtitle, body, opts) {
  try {
    if (typeof $notify !== 'function') return;
    if (opts) $notify(title, subtitle, body, opts);
    else $notify(title, subtitle, body);
  } catch (e) {
    log('通知发送失败：' + e, 0);
  }
}

function qxFinish() {
  // {} = Not changed，请求原样放行，绝不改动任何头
  try { if (typeof $done === 'function') $done({}); } catch (e) { /* noop */ }
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

/**
 * @param {object=} opts 仅用于电脑端离线自测注入：
 *                       { request, store:{get,set}, notify, finish }
 *                       在 QX 里不传参，自动从全局取。
 */
function main(opts) {
  opts = opts || {};
  var req = opts.request || (typeof $request !== 'undefined' ? $request : null) || {};
  var store = opts.store || qxStore();
  var notify = opts.notify || qxNotify;
  var finish = opts.finish || qxFinish;
  var url = req.url || '';
  var headers = req.headers || {};

  try {
    // 可选的二次过滤：同一脚本挂多条 rewrite 规则时用得上
    if (CONFIG.urlFilter && !(new RegExp(CONFIG.urlFilter, 'i')).test(url)) {
      log('URL 未通过脚本内过滤，跳过', 2);
      return;
    }

    var rawCookie = getHeader(headers, 'cookie');
    if (!rawCookie) {
      log('本次请求没有 Cookie 头，跳过（URL: ' + shortUrl(url) + '）', 2);
      return;
    }

    var cookies = parseCookie(rawCookie);
    var allNames = Object.keys(cookies);
    log('命中请求，Cookie 中共 ' + allNames.length + ' 个键', 2);

    // 还没填键名：把发现的键名列出来，帮用户完成配置（不打印值、不写入存储）
    if (!CONFIG.cookieKeys || CONFIG.cookieKeys.length === 0) {
      notify(
        '请配置 Cookie 键名',
        '本次请求发现 ' + allNames.length + ' 个键',
        '把需要的两个键名填进脚本顶部 CONFIG.cookieKeys：\n\n· ' +
          allNames.join('\n· ') +
          '\n\n（键名区分大小写，此处不显示任何值）'
      );
      return;
    }

    var state = loadState(store);
    var hadBaseline = !!state.baseline;
    var changes = [];
    var firstKeys = [];
    var seen = 0;

    for (var i = 0; i < CONFIG.cookieKeys.length; i++) {
      var key = CONFIG.cookieKeys[i];
      var newVal = cookies[key];

      // 某个键这次没带（不同接口带的 Cookie 不一定相同）—— 不覆盖、不误报
      if (newVal === undefined) {
        log('本次请求未携带 ' + key + '，跳过', 2);
        continue;
      }
      seen++;

      var oldVal = state.values[key];
      if (oldVal === undefined) {
        firstKeys.push(key);
        state.updatedAt[key] = isoNow();
      } else if (oldVal !== newVal) {
        changes.push({ key: key, oldVal: oldVal, newVal: newVal });
        state.updatedAt[key] = isoNow();
        log(key + ' 发生变化', 1);
      }
      state.values[key] = newVal;

      // 镜像一份明文值，其他 QX 脚本可直接 $prefs.valueForKey 读取
      store.set(CONFIG.storagePrefix + key, newVal);
    }

    if (seen === 0) {
      log('两个目标键本次请求都没有，保持存储不变', 1);
      return;
    }

    if (!hadBaseline) log('首次运行，已建立基线：' + firstKeys.join(', '), 1);

    if (changes.length) {
      var opts4 = null;
      if (CONFIG.copyToPasteboard) {
        var flat = [];
        for (var j = 0; j < CONFIG.cookieKeys.length; j++) {
          var k = CONFIG.cookieKeys[j];
          if (state.values[k] !== undefined) flat.push(k + '=' + state.values[k]);
        }
        opts4 = { 'update-pasteboard': flat.join('; ') };
      }
      notify(
        CONFIG.notifyTitle,
        changes.length + ' 个键发生变化',
        buildChangeBody(changes, url),
        opts4
      );
      state.changeCount += changes.length;
      state.lastChangeAt = isoNow();
      log('已发送变化通知，涉及 ' + changes.length + ' 个键', 1);
    } else if (!hadBaseline && CONFIG.notifyOnFirstCapture && firstKeys.length) {
      notify(
        'Cookie 基线已建立',
        '已记录 ' + firstKeys.length + ' 个键',
        '· ' + firstKeys.join('\n· ') +
          '\n\n此后只有在值发生变化时才会通知。'
      );
    }

    state.baseline = true;
    state.lastSeenAt = isoNow();
    state.lastUrl = shortUrl(url);
    store.set(CONFIG.storagePrefix + STATE_KEY_SUFFIX, JSON.stringify(state));
  } catch (e) {
    // 出错也绝不阻塞请求
    log('脚本异常，请求未做任何修改：' + (e && e.message ? e.message : e), 0);
  } finally {
    finish();
  }
}

/* ------------------------------------------------------------------ */
/* 入口：QX 里自动执行；Node 里导出纯函数供离线自测                      */
/* ------------------------------------------------------------------ */
var API = {
  CONFIG: CONFIG,
  getHeader: getHeader,
  parseCookie: parseCookie,
  maskValue: maskValue,
  loadState: loadState,
  buildChangeBody: buildChangeBody,
  main: main,
};

if (typeof $request !== 'undefined' && typeof $done === 'function') {
  main();
} else if (typeof module !== 'undefined' && module.exports) {
  module.exports = API;
}
