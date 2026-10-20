#!/usr/bin/env node
/**
 * Telegram ↔ MiMo Desktop 桥
 * 灵感借鉴 dsh-im：渠道适配器 + 白名单 + 超时补发
 * 通过本机 desktop-api 把 Telegram 消息交给 MiMo 干活，再把结果发回去。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const CONFIG_PATH = path.join(__dirname, "config.json");
const MAP_PATH = path.join(__dirname, "session-map.json");
const LOG_PATH = path.join(__dirname, "bridge.log");

function defaultDesktopApiJson() {
  const appData =
    process.env.APPDATA ||
    path.join(process.env.HOME || process.env.USERPROFILE || "", "AppData", "Roaming");
  return path.join(appData, "Xiaomi MiMo", "desktop-api.json");
}

// ---------- 基础工具 ----------
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_PATH, line + "\n", "utf8");
  } catch {}
}

function loadJson(p, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
}

function saveJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), "utf8");
}

function loadConfig() {
  const c = loadJson(CONFIG_PATH);
  if (!c || !c.bot_token) {
    console.error("请先编辑 config.json，填入 bot_token（找 @BotFather 申请）。");
    process.exit(1);
  }
  if (!c.desktop_api_json) c.desktop_api_json = defaultDesktopApiJson();
  if (!c.work_dir) c.work_dir = path.join(__dirname, "work");
  return c;
}

function loadSessionMap() {
  return loadJson(MAP_PATH, {}) || {};
}

function saveSessionMap(map) {
  saveJson(MAP_PATH, map);
}

// ---------- MiMo Desktop 本地接口 ----------
let deskCache = { at: 0, port: 0, token: "" };

function readDesktopApi(cfg) {
  const now = Date.now();
  if (now - deskCache.at < 5000 && deskCache.port) return deskCache;
  const apiPath = cfg.desktop_api_json || defaultDesktopApiJson();
  const j = loadJson(apiPath);
  if (!j || !j.port || !j.token) {
    throw new Error(
      "找不到或读不懂 desktop-api.json。请确认 MiMo Desktop 正在运行。"
    );
  }
  deskCache = { at: now, port: j.port, token: j.token };
  return deskCache;
}

async function deskFetch(cfg, pathname, options = {}) {
  const { port, token } = readDesktopApi(cfg);
  const url = `http://127.0.0.1:${port}${pathname}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    let body = "";
    try {
      body = await res.text();
    } catch {}
    const err = new Error(`桌面接口 ${pathname} 失败 HTTP ${res.status}: ${body}`);
    err.status = res.status;
    throw err;
  }
  return res;
}

async function deskHealth(cfg) {
  const res = await deskFetch(cfg, "/v1/health");
  return res.json();
}

async function deskSessions(cfg, limit = 50) {
  const res = await deskFetch(cfg, `/v1/sessions?limit=${limit}`);
  return res.json();
}

async function deskMessages(cfg, sessionId, dir) {
  const q = dir ? `?dir=${encodeURIComponent(dir)}` : "";
  const res = await deskFetch(cfg, `/v1/sessions/${encodeURIComponent(sessionId)}/messages${q}`);
  return res.json();
}

async function deskSendTurn(cfg, sessionId, body) {
  const res = await deskFetch(cfg, `/v1/sessions/${encodeURIComponent(sessionId)}/turns`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

function extractAssistantText(msg) {
  if (!msg || !msg.parts || !Array.isArray(msg.parts)) return "";
  const texts = [];
  for (const p of msg.parts) {
    if (p && p.type === "text" && typeof p.text === "string") {
      texts.push(p.text);
    }
  }
  return texts.join("\n").trim();
}

/** 发一轮并等待完成，返回助手最终文字。支持边跑边回调进度。 */
async function runTurn(cfg, sessionId, message, onProgress) {
  const turnBody = {
    message,
    model: cfg.model || "xiaomi/mimo-v2.6-flash",
  };
  if (cfg.work_dir) turnBody.dir = cfg.work_dir;

  // 记录发消息前的最新 assistant 时间戳，方便轮询找新回复
  let beforeCompleted = 0;
  try {
    const msgs = await deskMessages(cfg, sessionId, cfg.work_dir);
    for (const m of msgs) {
      const t = m?.info?.time?.completed || 0;
      if (t > beforeCompleted) beforeCompleted = t;
    }
  } catch {
    // 会话可能还很新，忽略
  }

  await deskSendTurn(cfg, sessionId, turnBody);
  if (onProgress) onProgress("已交给 MiMo，正在处理…");

  const deadline = Date.now() + (cfg.turn_timeout_min || 30) * 60 * 1000;
  let lastProgressAt = 0;
  let lastText = "";

  while (Date.now() < deadline) {
    await sleep(2000);
    let msgs;
    try {
      msgs = await deskMessages(cfg, sessionId, cfg.work_dir);
    } catch {
      continue;
    }

    // 找 completed 晚于本轮开始、且 finish 有的助手消息
    let latest = null;
    let latestCompleted = 0;
    for (const m of msgs) {
      if (m?.info?.role !== "assistant") continue;
      const completed = m?.info?.time?.completed || 0;
      if (completed > beforeCompleted && completed > latestCompleted) {
        latest = m;
        latestCompleted = completed;
      }
    }

    if (latest && (latest.info.finish === "stop" || latest.info.finish === "length" || latest.info.finish === "error")) {
      const text = extractAssistantText(latest) || "(这轮没有文字回复)";
      return text;
    }

    // 进度提示：每 20 秒最多一次
    if (onProgress && Date.now() - lastProgressAt > 20000) {
      lastProgressAt = Date.now();
      // 如果有部分文字，展示预览
      let partial = "";
      for (const m of msgs) {
        if (m?.info?.role === "assistant") {
          const t = extractAssistantText(m);
          if (t) partial = t;
        }
      }
      if (partial && partial !== lastText) {
        lastText = partial;
        onProgress("正在写…\n" + truncate(partial, 200));
      } else {
        onProgress("MiMo 还在干活，请稍等…");
      }
    }
  }
  return "等太久了（超时），但 MiMo 可能还在继续。稍后再问一次结果，或到电脑上打开 MiMo 查看。";
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function truncate(s, n) {
  if (!s) return s;
  return s.length <= n ? s : s.slice(0, n) + "…";
}

// ---------- 会话绑定 ----------
function pickSessionId(cfg, map, chatId) {
  if (map[String(chatId)]?.session_id) return map[String(chatId)].session_id;
  if (cfg.session_id) return cfg.session_id;
  return null;
}

async function bindSession(cfg, map, chatId) {
  const sessions = await deskSessions(cfg, 30);
  if (!Array.isArray(sessions) || !sessions.length) {
    throw new Error("MiMo 里还没有任何会话。请先在 MiMo Desktop 里新建一个对话。");
  }
  // 1) 优先：标题/目录里带专用标记的
  let chosen = sessions.find((s) =>
    /telegram|遥控|bridge|tg-/i.test(`${s.title || ""} ${s.directory || ""}`)
  );
  // 2) 其次：跳过最新一条（多半是你正在聊的窗口），用第二新的
  if (!chosen && sessions.length >= 2) chosen = sessions[1];
  if (!chosen) chosen = sessions[0];
  map[String(chatId)] = { session_id: chosen.id, title: chosen.title || "" };
  saveSessionMap(map);
  log(`chat ${chatId} 绑定会话 ${chosen.id} (${chosen.title || "无标题"})`);
  return chosen;
}

// ---------- Telegram ----------
function tgBase(cfg) {
  // 可选走代理：由 start.bat 里 NODE_USE_ENV_PROXY + HTTPS_PROXY 处理
  return `https://api.telegram.org/bot${cfg.bot_token}`;
}

async function tgApi(cfg, method, params) {
  const url = `${tgBase(cfg)}/${method}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) {
    throw new Error(`Telegram ${method} 失败: ${data.description || res.status}`);
  }
  return data.result;
}

async function tgSendMessage(cfg, chatId, text, opts = {}) {
  const chunks = splitMessage(text || "(空回复)");
  let last = null;
  for (const chunk of chunks) {
    last = await tgApi(cfg, "sendMessage", {
      chat_id: chatId,
      text: chunk,
      ...opts,
    });
  }
  return last;
}

async function tgEditMessage(cfg, chatId, messageId, text) {
  try {
    await tgApi(cfg, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: truncate(text, 4000),
    });
  } catch {
    // 编辑失败就忽略（可能内容没变）
  }
}

function splitMessage(text, limit = 4000) {
  const t = String(text);
  if (t.length <= limit) return [t];
  const parts = [];
  let i = 0;
  while (i < t.length) {
    parts.push(t.slice(i, i + limit));
    i += limit;
  }
  return parts;
}

function isAllowed(cfg, userId) {
  if (!Array.isArray(cfg.allowed_user_ids) || cfg.allowed_user_ids.length === 0) {
    return true; // 未配置白名单 = 允许所有人（仅建议本机自用）
  }
  return cfg.allowed_user_ids.map(String).includes(String(userId));
}

// ---------- 主循环 ----------
async function handleMessage(cfg, map, update) {
  const msg = update.message || update.edited_message;
  if (!msg || !msg.text) return;
  const chatId = msg.chat.id;
  const userId = msg.from?.id;
  const text = msg.text.trim();

  if (!isAllowed(cfg, userId)) {
    await tgSendMessage(cfg, chatId, "你不在白名单里，我不能服务你。");
    return;
  }

  // 命令
  if (text === "/start" || text === "/help") {
    await tgSendMessage(
      cfg,
      chatId,
      "我是 MiMo 的 Telegram 遥控器。\n直接发消息，MiMo 会帮你干活并把结果发回来。\n\n命令：\n/sessions — 查看可用会话\n/bind <会话ID> — 绑定到指定会话\n/status — 检查电脑上的 MiMo 是否在线"
    );
    return;
  }

  if (text === "/status") {
    try {
      const h = await deskHealth(cfg);
      await tgSendMessage(cfg, chatId, `MiMo 状态：${h.engine || "未知"}（应用 ${h.app || "?"}）`);
    } catch (e) {
      await tgSendMessage(cfg, chatId, `连不上 MiMo：${e.message}\n请确认电脑上的 MiMo Desktop 正在运行。`);
    }
    return;
  }

  if (text === "/sessions") {
    try {
      const sessions = await deskSessions(cfg, 15);
      const lines = sessions.slice(0, 15).map((s) => `${s.id}\n  ${s.title || "(无标题)"}`);
      await tgSendMessage(cfg, chatId, "最近的 MiMo 会话：\n\n" + lines.join("\n"));
    } catch (e) {
      await tgSendMessage(cfg, chatId, `读取会话失败：${e.message}`);
    }
    return;
  }

  const bindMatch = /^\/bind\s+(\S+)/.exec(text);
  if (bindMatch) {
    map[String(chatId)] = { session_id: bindMatch[1], title: "(手动绑定)" };
    saveSessionMap(map);
    await tgSendMessage(cfg, chatId, `已绑定到会话 ${bindMatch[1]}`);
    return;
  }

  // 普通消息 → 交给 MiMo
  let sessionId = pickSessionId(cfg, map, chatId);
  if (!sessionId) {
    await tgSendMessage(cfg, chatId, "正在为你绑定一个 MiMo 会话…");
    try {
      const chosen = await bindSession(cfg, map, chatId);
      sessionId = chosen.id;
      await tgSendMessage(
        cfg,
        chatId,
        `已绑定会话：${chosen.title || chosen.id}\n\n接下来直接说话就行。`
      );
    } catch (e) {
      await tgSendMessage(cfg, chatId, `绑定失败：${e.message}`);
      return;
    }
  }

  // 发一条“正在处理”的占位消息，之后编辑更新
  let statusMsg = null;
  try {
    statusMsg = await tgSendMessage(cfg, chatId, "⏳ 已收到，正在交给 MiMo…");
  } catch {}

  const onProgress = async (p) => {
    if (statusMsg) await tgEditMessage(cfg, chatId, statusMsg.message_id, p);
  };

  try {
    const answer = await runTurn(cfg, sessionId, text, onProgress);
    if (statusMsg) {
      await tgEditMessage(cfg, chatId, statusMsg.message_id, "✅ 完成，正在发送结果…");
    }
    await tgSendMessage(cfg, chatId, answer);
    if (statusMsg) {
      try {
        await tgApi(cfg, "editMessageText", {
          chat_id: chatId,
          message_id: statusMsg.message_id,
          text: `✅ 完成（会话 ${sessionId}）`,
        });
      } catch {}
    }
  } catch (e) {
    log("处理失败: " + e.message);
    await tgSendMessage(cfg, chatId, `出错了：${e.message}`);
  }
}

// ---------- 自愈与看护 ----------
const HEARTBEAT_PATH = path.join(__dirname, "heartbeat.txt");
const LOCK_PATH = path.join(__dirname, "bridge.lock");
let consecutivePollFailures = 0;
const MAX_POLL_FAILURES = 20; // 约 3 分钟一直连不上 Telegram 就交回看护程序重启

function acquireLock() {
  const existing = loadJson(LOCK_PATH);
  if (existing && existing.pid) {
    try {
      process.kill(existing.pid, 0); // 进程还活着
      return false;
    } catch {
      // 进程已不在，可以接管
    }
  }
  try {
    fs.writeFileSync(LOCK_PATH, JSON.stringify({ pid: process.pid, at: Date.now() }), "utf8");
  } catch {}
  return true;
}

function releaseLock() {
  try {
    const cur = loadJson(LOCK_PATH);
    if (cur && cur.pid === process.pid) fs.rmSync(LOCK_PATH, { force: true });
  } catch {}
}

function heartbeat(note) {
  try {
    fs.writeFileSync(HEARTBEAT_PATH, `${Date.now()}\n${note || ""}\n`, "utf8");
  } catch {}
}

process.on("uncaughtException", (e) => {
  log("未捕获异常（不退出）: " + (e && e.stack ? e.stack : e));
});
process.on("unhandledRejection", (e) => {
  log("未处理的 Promise 拒绝（不退出）: " + (e && e.stack ? e.stack : e));
});

process.on("SIGINT", () => {
  log("收到 Ctrl+C，正常退出");
  releaseLock();
  process.exit(0);
});

process.on("exit", () => {
  releaseLock();
});

async function waitForMiMo(cfg, maxMinutes = 30) {
  const deadline = Date.now() + maxMinutes * 60 * 1000;
  let lastLog = 0;
  for (;;) {
    try {
      const h = await deskHealth(cfg);
      log(`MiMo OK: engine=${h.engine} app=${h.app}`);
      return true;
    } catch (e) {
      if (Date.now() > deadline) {
        log("等 MiMo 超时，退出交给看护程序重启");
        return false;
      }
      if (Date.now() - lastLog > 60000) {
        lastLog = Date.now();
        log("MiMo 还没就绪，1 分钟后重试…");
      }
      await sleep(60000);
    }
  }
}

async function main() {
  const cfg = loadConfig();
  const map = loadSessionMap();
  try {
    fs.mkdirSync(cfg.work_dir, { recursive: true });
  } catch {}

  if (!acquireLock()) {
    log("已经有一个桥在运行了，本进程退出（避免两个实例抢消息）");
    process.exit(5);
  }

  log("检查 MiMo Desktop…");
  const ready = await waitForMiMo(cfg);
  if (!ready) process.exit(2);

  log("向 Telegram 报到…");
  let me = null;
  for (let i = 0; i < 60; i++) {
    try {
      me = await tgApi(cfg, "getMe", {});
      break;
    } catch (e) {
      if (i === 0) log("Telegram 暂时连不上（检查代理），持续重试…");
      await sleep(10000);
    }
  }
  if (!me) {
    log("连不上 Telegram，退出交给看护程序重启");
    process.exit(3);
  }
  log(`机器人：@${me.username}`);

  // 清掉旧的 webhook，改用长轮询
  try {
    await tgApi(cfg, "deleteWebhook", { drop_pending_updates: true });
  } catch {}

  let offset = 0;
  heartbeat("started");
  log("开始收消息（Ctrl+C 退出）…");
  for (;;) {
    try {
      const updates = await tgApi(cfg, "getUpdates", {
        offset,
        timeout: 30,
        allowed_updates: ["message"],
      });
      consecutivePollFailures = 0;
      heartbeat("polling");

      for (const u of updates) {
        offset = u.update_id + 1;
        // 串行处理，避免 MiMo 会话打架
        try {
          await handleMessage(cfg, map, u);
        } catch (e) {
          log("handleMessage 错误: " + (e.stack || e.message));
        }
        heartbeat("handled");
      }
    } catch (e) {
      consecutivePollFailures++;
      const wait = Math.min(60000, 5000 * Math.min(consecutivePollFailures, 12));
      log(
        `轮询出错（第 ${consecutivePollFailures} 次，${Math.round(wait / 1000)} 秒后重试）: ${e.message}`
      );
      if (consecutivePollFailures >= MAX_POLL_FAILURES) {
        log("连续失败太多次，退出交给看护程序重启");
        process.exit(4);
      }
      await sleep(wait);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
