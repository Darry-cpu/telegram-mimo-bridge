// 自检脚本：验证「发送限流」和「超时后补发」是否按预期工作。
// 用法：node selftest.js <chatId> [只跑补发测试: deferred]
"use strict";

const bridge = require("./bridge.js");

const CHAT_ID = process.argv[2];
const ONLY = process.argv[3] || "";
if (!CHAT_ID) {
  console.error("用法: node selftest.js <chatId> [deferred]");
  process.exit(1);
}

function log(m) {
  console.log(`[selftest] ${m}`);
}

async function testRateLimit(cfg) {
  log("测试 1：本地限流（连发 16 条）");
  const t0 = Date.now();
  for (let i = 1; i <= 16; i++) {
    await bridge.tgSendMessage(cfg, CHAT_ID, `【自检】限流测试 ${i}/16`);
  }
  const elapsed = Math.round((Date.now() - t0) / 1000);
  log(`测试 1 结束，耗时 ${elapsed} 秒（超过 60 秒即限流生效）`);
}

async function testDeferred(cfg, sessionId) {
  log("测试 2：超时补发（前台只等 5 秒）");
  const baseline = await bridge.startTurn(
    cfg,
    sessionId,
    "请详细写一段约 600 字的说明，主题是「为什么人会拖延」，分点论述。"
  );
  log(`已提交，基线=${JSON.stringify(baseline)}`);

  const r = await bridge.pollTurn(cfg, sessionId, baseline, {
    deadline: Date.now() + 5000,
    onProgress: (p) => log("进度: " + p.replace(/\n/g, " / ")),
  });

  if (r.done) {
    log("5 秒内就完成了（本机很快），补发路径未触发");
    return;
  }
  log("前台超时 → 转入后台补发，等它自己完成");
  bridge.scheduleDeferred(cfg, sessionId, baseline, CHAT_ID, null);

  // 在本进程里陪着后台任务跑，方便观察结果（最多等 5 分钟）
  const until = Date.now() + 5 * 60 * 1000;
  while (Date.now() < until) {
    await new Promise((r2) => setTimeout(r2, 5000));
    const msgs = await bridge.deskMessages(cfg, sessionId, baseline.dir);
    const done = msgs.some(
      (m) =>
        m?.info?.role === "assistant" &&
        (m?.info?.time?.completed || 0) > baseline.beforeCompleted &&
        m?.info?.finish
    );
    if (done) {
      log("本轮已在 MiMo 侧完成，补发应已发出");
      break;
    }
  }
}

(async () => {
  const cfg = bridge.loadConfig();
  const map = bridge.loadSessionMap();
  const sessionId = cfg.session_id || map[String(CHAT_ID)]?.session_id;

  if (ONLY !== "deferred") await testRateLimit(cfg);
  if (!sessionId) {
    log("没有可用会话，跳过补发测试");
    return;
  }
  await testDeferred(cfg, sessionId);
})();
