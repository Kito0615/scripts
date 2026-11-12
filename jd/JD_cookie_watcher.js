/**
 * cookie-watch.js — Quantumult X 请求头 Cookie 监视 + 青龙 JD_COOKIE 自动同步
 * ---------------------------------------------------------------------------
 * 命中 QX rewrite 规则的请求到达时：
 *   1. 读取 Cookie 请求头里你指定的两个键，持久化到 $prefs；
 *   2. 值与上次不同 → 发通知 + 更新本地存储；
 *   3. 把两个键拼成 "key1=value1;key2=value2;"，通过青龙 Open API
 *      查询并更新 JD_COOKIE 环境变量。
 *
 * 不修改请求：任何情况下都以 $done({}) 结束（QX 官方 "Not changed" 语义）。
 *              只有值变化（或上次同步失败待重试）时才发起网络请求，
 *              普通请求零额外延迟；网络最长等待 finishTimeoutMs 后强制放行。
 *
 * 凭据安全：client_id / client_secret **不写在脚本里**，也不必长期留在配置里。
 *           见 README「第一步：填写青龙凭据」，用一次性 setup 写入 $prefs。
 *
 * 环境：Quantumult X 的 script-request-header 重写脚本（需为目标域名开 MitM）
 * ---------------------------------------------------------------------------
 */
'use strict';

var CONFIG = {
  // ★ 要监视的两个 Cookie 键名（区分大小写、精确匹配）
  // 若留空数组，脚本会通知你「本次请求里有哪些键名」，方便先确认名字。
  cookieKeys: ['pt_key', 'pt_pin'],

  // $prefs 里的键前缀；两个值会额外镜像成 <前缀><键名>，方便别的脚本直接读
  storagePrefix: 'cookie_watch.',

  // 可选：脚本内再做一次 URL 正则过滤（字符串）。留空 = 完全信任 QX 规则
  urlFilter: '',

  // 组合格式：true → "pt_key=A;pt_pin=B;"（每段后带分号，含结尾）
  //           false → "pt_key=A;pt_pin=B"
  composeTrailingSemicolon: true,

  notifyTitle: 'Cookie 值已变化',
  maskValue: false,          // 通知里对值脱敏，只显示首尾各几位
  maskHead: 4,
  maskTail: 4,
  notifyOnFirstCapture: false, // 首次建立基线时是否也发一条通知
  copyToPasteboard: false,  // 变化时把完整的两个值写入剪贴板（会覆盖剪贴板）
  logLevel: 1,              // 0 只打错误 / 1 摘要 / 2 调试；日志永不打印明文值或密钥

  /* ---------------- 青龙面板 Open API ---------------- */
  qinglong: {
    enabled: true,
    baseUrl: 'https://ql.leyunxuan.cc',   // 面板地址，不要带尾斜杠
    envName: 'JD_COOKIE',                 // 要更新的环境变量名
    envId: '',                           // 有多个同名变量时，指定要更新那条的 id；留空取第一条
    createIfMissing: false,              // 找不到 JD_COOKIE 时是否自动新建（默认不建）
    syncOnFirstCapture: false,           // 首次建立基线时是否也同步一次（默认不，避免误覆盖）
    retryIntervalSec: 30,                // 同步失败后，距上次尝试至少隔多少秒才重试
    finishTimeoutMs: 9000,               // 等待青龙接口的最长时间，到点必须 $done({}) 放行请求
  },

  /* ---------------- 凭据（这里只放「怎么读」，不放值）---------------- */
  credentials: {
    // client_id / client_secret 绝不写在本文件里。
    // 一次性导入用的凭证文件名，位于 iCloud Drive/Quantumult X/Data/ 下。
    // 内容：{"client_id":"...","client_secret":"..."}，导入成功后即可删除。
    importFile: 'ql-credentials.json',
  },
};

var STATE_KEY_SUFFIX = '__state';

/** 凭据与 token 在 $prefs 里的键名 */
function credKey(name) {
  return CONFIG.storagePrefix + 'ql.' + name;
}

/* ================================================================== */
/* 通用纯函数                                                          */
/* ================================================================== */

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

/** 把任何可能进入日志/通知的文本里的密钥、token 抹掉 */
function scrub(text, creds, token) {
  var t = String(text === null || text === undefined ? '' : text);
  function hide(v) {
    var s = String(v || '');
    if (s.length >= 3) t = t.split(s).join('***');
  }
  if (creds) { hide(creds.client_id); hide(creds.client_secret); }
  if (token) hide(token);
  t = t.replace(/client_secret=[^&\s"']+/gi, 'client_secret=***');
  t = t.replace(/client_id=[^&\s"']+/gi, 'client_id=***');
  t = t.replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, 'Bearer ***');
  return t.length > 300 ? t.slice(0, 300) + '…' : t;
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

/** 日志/通知里只保留 URL 的路径部分，去掉 query（可能含 token 或密钥） */
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

/** 按用户要求的格式拼串：pt_key=xxx;pt_pin=yyy;  —— 两个键缺一不可 */
function composeCookieString(state) {
  var values = (state && state.values) || {};
  var parts = [];
  for (var i = 0; i < CONFIG.cookieKeys.length; i++) {
    var k = CONFIG.cookieKeys[i];
    var v = values[k];
    if (v === undefined || v === null || v === '') return '';
    parts.push(k + '=' + v + (CONFIG.composeTrailingSemicolon ? ';' : ''));
  }
  return parts.join(CONFIG.composeTrailingSemicolon ? '' : ';');
}

/* ================================================================== */
/* QX 环境适配层                                                       */
/* ================================================================== */

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

function qxVars() {
  try {
    return (typeof $environment !== 'undefined' && $environment.variables) || {};
  } catch (e) { return {}; }
}

/** 读取 iCloud Drive/Quantumult X/Data/ 下的文本文件内容 */
function qxReadFile(path) {
  try {
    if (typeof $iCloud === 'undefined' || typeof $iCloud.readFile !== 'function') return '';
    var u8 = $iCloud.readFile(path);
    if (!u8) return '';
    if (typeof TextDecoder !== 'undefined') return new TextDecoder().decode(u8);
    var s = '';
    for (var i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    return s;
  } catch (e) { return ''; }
}

/** 统一成 Promise<{statusCode, body}>，失败抛 Error（不把原始 URL 带出去） */
function qxFetch(opts) {
  return new Promise(function (resolve, reject) {
    if (typeof $task === 'undefined' || typeof $task.fetch !== 'function') {
      reject(new Error('$task.fetch 不可用'));
      return;
    }
    $task.fetch(opts).then(
      function (res) { resolve(res); },
      function (reason) {
        reject(new Error(reason && reason.error ? String(reason.error) : '网络请求失败'));
      }
    );
  });
}

function qxFinish(value) {
  // {} = Not changed，请求原样放行，绝不改动任何头
  try { if (typeof $done === 'function') $done(value || {}); } catch (e) { /* noop */ }
}

function qxTaskFinish() {
  // task 脚本用 $done()，无参数
  try { if (typeof $done === 'function') $done(); } catch (e) { /* noop */ }
}

/* ================================================================== */
/* 凭据：只从 $prefs / URL hash / 一次性凭证文件读取，脚本里没有明文      */
/* ================================================================== */

function saveCredentials(store, creds) {
  store.set(credKey('client_id'), creds.client_id);
  store.set(credKey('client_secret'), creds.client_secret);
  store.set(credKey('token'), ''); // 换凭据时让旧 token 失效
}

/**
 * 读取优先级：
 *   1. $prefs（最安全：只存在手机 QX 沙盒，由一次性 setup 写入）
 *   2. $environment.variables（脚本 URL 的 # 参数，适合远程脚本常驻传参）
 *   3. iCloud 凭证文件（本地脚本可用；读到后立刻写入 $prefs，随后可删文件）
 */
function readCredentials(deps) {
  var id = deps.store.get(credKey('client_id'));
  var sec = deps.store.get(credKey('client_secret'));
  if (id && sec) {
    return { client_id: String(id), client_secret: String(sec), source: 'prefs' };
  }

  var vars = deps.environment || {};
  if (vars.client_id && vars.client_secret) {
    return { client_id: String(vars.client_id), client_secret: String(vars.client_secret), source: 'url' };
  }

  var text = deps.readFile ? deps.readFile(CONFIG.credentials.importFile) : '';
  if (text) {
    try {
      var obj = JSON.parse(text);
      if (obj.client_id && obj.client_secret) {
        var creds = {
          client_id: String(obj.client_id),
          client_secret: String(obj.client_secret),
          source: 'file',
        };
        saveCredentials(deps.store, creds); // 一次性导入，之后不再需要文件
        log('已从凭证文件导入并写入 $prefs，可删除 ' + CONFIG.credentials.importFile, 1);
        return creds;
      }
    } catch (e) {
      log('凭证文件不是有效 JSON', 0);
    }
  }
  return null;
}

/**
 * 一次性凭据初始化：作为 task 手动运行一次即可。
 * QX 支持在脚本 URL 的 # 后传参，运行时通过 $environment.variables 读取。
 *   cookie-watch.js#mode=setup&client_id=xxx&client_secret=yyy
 * 写入 $prefs 后立刻删除该 task 规则，密钥就不在任何文件里了。
 */
function runSetup(deps) {
  var vars = deps.environment || {};
  var creds = null;
  if (vars.client_id && vars.client_secret) {
    creds = { client_id: String(vars.client_id), client_secret: String(vars.client_secret), source: 'url' };
  }
  if (!creds) {
    var text = deps.readFile ? deps.readFile(CONFIG.credentials.importFile) : '';
    if (text) {
      try {
        var obj = JSON.parse(text);
        if (obj.client_id && obj.client_secret) {
          creds = {
            client_id: String(obj.client_id),
            client_secret: String(obj.client_secret),
            source: 'file',
          };
        }
      } catch (e) { /* 下面统一报错 */ }
    }
  }

  if (!creds) {
    deps.notify(
      '青龙凭据未写入',
      '缺少参数',
      '在脚本 URL 的 # 后加：mode=setup&client_id=你的ID&client_secret=你的密钥\n' +
      '或把 {"client_id":"...","client_secret":"..."} 存成 ' +
      CONFIG.credentials.importFile + ' 放到 QX 的 Data 目录。'
    );
  } else {
    saveCredentials(deps.store, creds);
    deps.notify(
      '青龙凭据已保存',
      '已写入本机 $prefs',
      '现在请立刻删除 [task_local] 里这条带 #mode=setup 的规则' +
      (creds.source === 'file' ? '，以及凭证文件 ' + CONFIG.credentials.importFile : '') +
      '。\n密钥不会留在脚本或配置文件里。'
    );
  }
  deps.finish();
}

/* ================================================================== */
/* 青龙 Open API                                                       */
/* ================================================================== */

function qlBase() {
  return String(CONFIG.qinglong.baseUrl || '').replace(/\/+$/, '');
}

function qlHeaders(token, withJson) {
  var h = { Accept: 'application/json', Authorization: 'Bearer ' + token };
  if (withJson) h['Content-Type'] = 'application/json';
  return h;
}

function parseApiResponse(res) {
  var status = res && (res.statusCode !== undefined ? res.statusCode : res.status);
  status = Number(status || 0);
  if (status && (status < 200 || status >= 300)) throw new Error('HTTP ' + status);
  var raw = res && res.body;
  var obj = raw;
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw); } catch (e) { throw new Error('响应不是有效 JSON'); }
  }
  if (!obj || typeof obj !== 'object') throw new Error('响应为空');
  if (obj.code !== undefined && obj.code !== 200) {
    throw new Error('API ' + obj.code + (obj.message ? '：' + obj.message : ''));
  }
  return obj;
}

/** 青龙不同版本的 data 可能是数组，也可能包了一层 */
function extractEnvList(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    if (Array.isArray(data.data)) return data.data;
    if (Array.isArray(data.list)) return data.list;
    if (Array.isArray(data.items)) return data.items;
    if (Array.isArray(data.rows)) return data.rows;
  }
  return [];
}

function filterByName(list, name) {
  var out = [];
  for (var i = 0; i < list.length; i++) {
    if (list[i] && list[i].name === name) out.push(list[i]);
  }
  return out;
}

function chooseEnv(hits) {
  var name = CONFIG.qinglong.envName;
  if (CONFIG.qinglong.envId) {
    for (var i = 0; i < hits.length; i++) {
      if (String(hits[i].id) === String(CONFIG.qinglong.envId)) {
        return { env: hits[i], note: '按 envId 更新' };
      }
    }
    return { env: null, note: '未找到 envId=' + CONFIG.qinglong.envId + ' 的 ' + name };
  }
  if (!hits.length) return { env: null, note: '未找到环境变量 ' + name };
  var note = hits.length > 1
    ? '发现 ' + hits.length + ' 条同名 ' + name + '，更新了第 1 条（可在 qinglong.envId 指定）'
    : '已更新 ' + name;
  return { env: hits[0], note: note };
}

function readToken(store) {
  var raw = store.get(credKey('token'));
  if (!raw) return '';
  try {
    var t = JSON.parse(raw);
    var expMs = t.expiration
      ? Number(t.expiration) * 1000
      : (t.cachedAt ? Number(t.cachedAt) + 86400000 : 0);
    // 留 60 秒余量，快过期就重新换
    if (t.token && expMs - Date.now() > 60000) return String(t.token);
  } catch (e) { /* 缓存损坏，重新取 */ }
  return '';
}

function saveToken(store, data) {
  store.set(credKey('token'), JSON.stringify({
    token: data.token,
    expiration: data.expiration || 0,
    cachedAt: Date.now(),
  }));
}

function clearToken(store) {
  store.set(credKey('token'), '');
}

/** GET /open/auth/token —— 有有效缓存就直接复用 */
function apiGetToken(creds, deps) {
  var cached = readToken(deps.store);
  if (cached) {
    log('复用已缓存的青龙 token', 2);
    return Promise.resolve(cached);
  }
  var url = qlBase() + '/open/auth/token?client_id=' +
    encodeURIComponent(creds.client_id) +
    '&client_secret=' + encodeURIComponent(creds.client_secret);
  return deps.fetch({ url: url, method: 'GET', headers: { Accept: 'application/json' } })
    .then(function (res) {
      var obj = parseApiResponse(res);
      var d = obj.data || {};
      if (!d.token) throw new Error('鉴权响应里没有 token');
      saveToken(deps.store, d);
      return d.token;
    });
}

/** GET /open/envs?searchValue=... —— 查不到再回退到全量精确过滤 */
function apiFindEnv(token, deps) {
  var base = qlBase() + '/open/envs';
  var name = CONFIG.qinglong.envName;

  function query(qs) {
    return deps.fetch({ url: base + qs, method: 'GET', headers: qlHeaders(token) })
      .then(function (res) { return extractEnvList(parseApiResponse(res).data); });
  }

  return query('?searchValue=' + encodeURIComponent(name)).then(function (list) {
    var hits = filterByName(list, name);
    if (hits.length) return hits;
    log('searchValue 未命中，回退全量查询', 2);
    return query('').then(function (all) { return filterByName(all, name); });
  });
}

/** PUT /open/envs —— 文档要求 id/name/value 一起提交，并保留原备注/标签 */
function apiPutEnv(token, env, value, deps) {
  var body = {
    id: env.id,
    name: env.name || CONFIG.qinglong.envName,
    value: value,
  };
  if (env.remarks !== undefined) body.remarks = env.remarks;
  if (env.labels !== undefined) body.labels = env.labels;
  return deps.fetch({
    url: qlBase() + '/open/envs',
    method: 'PUT',
    headers: qlHeaders(token, true),
    body: JSON.stringify(body),
  }).then(function (res) {
    parseApiResponse(res);
    return 'updated';
  });
}

/** POST /open/envs —— 可选：变量不存在时新建 */
function apiPostEnv(token, value, deps) {
  var body = [{ name: CONFIG.qinglong.envName, value: value, remarks: '' }];
  return deps.fetch({
    url: qlBase() + '/open/envs',
    method: 'POST',
    headers: qlHeaders(token, true),
    body: JSON.stringify(body),
  }).then(function (res) {
    parseApiResponse(res);
    return 'created';
  });
}

/** 完整同步链路：取 token → 查变量 → 更新（或新建）。返回 Promise<string 说明> */
function syncToQingLong(deps, value) {
  var creds = readCredentials(deps);
  if (!creds) return Promise.reject(new Error('未配置青龙凭据 client_id / client_secret'));
  var token = '';
  return apiGetToken(creds, deps)
    .then(function (t) {
      token = t;
      return apiFindEnv(t, deps);
    })
    .then(function (hits) {
      var picked = chooseEnv(hits);
      if (picked.env) {
        return apiPutEnv(token, picked.env, value, deps).then(function () { return picked.note; });
      }
      if (CONFIG.qinglong.createIfMissing) {
        return apiPostEnv(token, value, deps).then(function () { return '变量不存在，已新建 ' + CONFIG.qinglong.envName; });
      }
      throw new Error(picked.note);
    });
}

/* ================================================================== */
/* 主流程                                                              */
/* ================================================================== */

/**
 * 处理一次命中请求，返回 null（无需等待）或 Promise（需等网络完成后再 $done）。
 * 独立成函数是为了让早退路径也能统一回到 main() 里调用 doneOnce()。
 */
function processRequest(ctx) {
  var store = ctx.store, notify = ctx.notify, deps = ctx.deps;
  var url = ctx.url, headers = ctx.headers;

  if (CONFIG.urlFilter && !(new RegExp(CONFIG.urlFilter, 'i')).test(url)) {
    log('URL 未通过脚本内过滤，跳过', 2);
    return null;
  }

  var rawCookie = getHeader(headers, 'cookie');
  if (!rawCookie) {
    log('本次请求没有 Cookie 头，跳过（URL: ' + shortUrl(url) + '）', 2);
    return null;
  }

  var cookies = parseCookie(rawCookie);
  var allNames = Object.keys(cookies);
  log('命中请求，Cookie 中共 ' + allNames.length + ' 个键', 2);

  if (!CONFIG.cookieKeys || CONFIG.cookieKeys.length === 0) {
    notify(
      '请配置 Cookie 键名',
      '本次请求发现 ' + allNames.length + ' 个键',
      '把需要的两个键名填进脚本顶部 CONFIG.cookieKeys：\n\n· ' +
        allNames.join('\n· ') + '\n\n（键名区分大小写，此处不显示任何值）'
    );
    return null;
  }

  var state = loadState(store);
  var hadBaseline = !!state.baseline;
  var changes = [];
  var firstKeys = [];
  var seen = 0;

  for (var i = 0; i < CONFIG.cookieKeys.length; i++) {
    var key = CONFIG.cookieKeys[i];
    var newVal = cookies[key];
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
    store.set(CONFIG.storagePrefix + key, newVal);
  }

  if (seen === 0) {
    log('两个目标键本次请求都没有，保持存储不变', 1);
    return null;
  }

  if (!hadBaseline) log('首次运行，已建立基线：' + firstKeys.join(', '), 1);

  /* ---------- 本地通知 ---------- */
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
    notify(CONFIG.notifyTitle, changes.length + ' 个键发生变化', buildChangeBody(changes, url), opts4);
    state.changeCount += changes.length;
    state.lastChangeAt = isoNow();
    log('已发送变化通知，涉及 ' + changes.length + ' 个键', 1);
  } else if (!hadBaseline && CONFIG.notifyOnFirstCapture && firstKeys.length) {
    notify('Cookie 基线已建立', '已记录 ' + firstKeys.length + ' 个键',
      '· ' + firstKeys.join('\n· ') + '\n\n此后只有在值发生变化时才会通知。');
  }

  /* ---------- 决定是否同步青龙 ---------- */
  var composed = composeCookieString(state);
  var retryDue = !!state.syncPending &&
    (Date.now() - (state.syncPendingSince || 0) >= CONFIG.qinglong.retryIntervalSec * 1000);
  var shouldSync = false;
  if (CONFIG.qinglong.enabled && composed) {
    if (changes.length) shouldSync = true;
    else if (!hadBaseline && CONFIG.qinglong.syncOnFirstCapture) shouldSync = true;
    else if (state.syncPending && retryDue) shouldSync = true; // 上次失败，自动补同步
  }

  if (shouldSync) {
    state.syncPending = composed;
    state.syncPendingSince = Date.now();
    log('准备同步到青龙 ' + CONFIG.qinglong.envName, 1);
  }

  state.baseline = true;
  state.lastSeenAt = isoNow();
  state.lastUrl = shortUrl(url);
  store.set(CONFIG.storagePrefix + STATE_KEY_SUFFIX, JSON.stringify(state));

  if (!shouldSync) return null;

  var creds = readCredentials(deps);
  var tokenUsed = readToken(deps.store);
  return syncToQingLong(deps, composed).then(
    function (note) {
      state.syncPending = '';
      state.lastSyncAt = isoNow();
      state.lastSyncNote = note;
      store.set(CONFIG.storagePrefix + STATE_KEY_SUFFIX, JSON.stringify(state));
      notify('青龙同步成功', CONFIG.qinglong.envName + ' 已更新',
        '· ' + note + '\n· 值：' + maskValue(composed) + '\n· 时间：' + localTime());
      log('青龙同步成功：' + note, 1);
    },
    function (err) {
      var safe = scrub(err && err.message ? err.message : err, creds, tokenUsed);
      if (/401|403|HTTP 4\d\d|token/i.test(safe)) clearToken(deps.store);
      // 保留 state.syncPending，下次命中请求会自动重试
      log('青龙同步失败（已标记待重试）：' + safe, 0);
      notify('青龙同步失败', '下次请求会自动重试',
        '原因：' + safe + '\n\n本地两个键的值已更新，不影响手机侧记录。');
    }
  );
}

/**
 * @param {object=} opts 仅用于电脑端离线自测注入：
 *   { request, store:{get,set}, notify, finish, fetch, environment, readFile }
 *   在 QX 的 rewrite 里不传参，自动从全局取。
 * @returns Promise|null 需要等待的后台任务（总是 resolved），供测试 await
 */
function main(opts) {
  opts = opts || {};
  var req = opts.request || (typeof $request !== 'undefined' ? $request : null) || {};
  var store = opts.store || qxStore();
  var deps = {
    store: store,
    notify: opts.notify || qxNotify,
    fetch: opts.fetch || qxFetch,
    environment: opts.environment || qxVars(),
    readFile: opts.readFile || qxReadFile,
  };
  var finish = opts.finish || qxFinish;
  var finished = false;
  function doneOnce() {
    if (finished) return;
    finished = true;
    finish({}); // {} = Not changed，对注入的测试 finish 也保持同一语义
  }

  var asyncTask = null;
  try {
    asyncTask = processRequest({
      store: store,
      notify: deps.notify,
      deps: deps,
      url: req.url || '',
      headers: req.headers || {},
    });
  } catch (e) {
    log('脚本异常，请求未做任何修改：' + (e && e.message ? e.message : e), 0);
  }

  if (asyncTask && typeof asyncTask.then === 'function') {
    var timer = setTimeout(doneOnce, CONFIG.qinglong.finishTimeoutMs);
    return asyncTask.then(
      function () { clearTimeout(timer); doneOnce(); },
      function () { clearTimeout(timer); doneOnce(); }
    );
  }
  doneOnce();
  return null;
}

/* ================================================================== */
/* 入口                                                                */
/*   rewrite → main()；task + #mode=setup → 一次性写入凭据；Node → 导出  */
/* ================================================================== */
var API = {
  CONFIG: CONFIG,
  credKey: credKey,
  getHeader: getHeader,
  parseCookie: parseCookie,
  maskValue: maskValue,
  scrub: scrub,
  loadState: loadState,
  buildChangeBody: buildChangeBody,
  composeCookieString: composeCookieString,
  readCredentials: readCredentials,
  saveCredentials: saveCredentials,
  runSetup: runSetup,
  readToken: readToken,
  parseApiResponse: parseApiResponse,
  extractEnvList: extractEnvList,
  chooseEnv: chooseEnv,
  syncToQingLong: syncToQingLong,
  processRequest: processRequest,
  main: main,
};

var QX_VARS = qxVars();

if (typeof $request !== 'undefined' && typeof $done === 'function') {
  main();                                              // rewrite 正常模式
} else if (typeof $done === 'function' &&
           (QX_VARS.mode === 'setup' || QX_VARS.setup === '1')) {
  runSetup({                                           // task 一次性凭据初始化
    store: qxStore(),
    notify: qxNotify,
    finish: qxTaskFinish,
    environment: QX_VARS,
    readFile: qxReadFile,
  });
} else if (typeof module !== 'undefined' && module.exports) {
  module.exports = API;                                // Node 离线自测
} else if (typeof $done === 'function') {
  qxTaskFinish();                                      // 其它未知调用，安全退出
}
