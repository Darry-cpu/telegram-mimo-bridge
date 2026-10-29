# Telegram ⇄ MiMo Desktop Bridge

在 **Telegram** 里遥控你电脑上的 **MiMo Desktop**：发消息 → MiMo 干活 → 结果发回 Telegram。

思路借鉴了 [dsh-im](https://github.com/xmanrui/dsh-im)（把 IM 接到 DeepSeek Harness 的开源项目），本项目改为对接本机 **MiMo Desktop** 的本地接口，零第三方依赖（只需 Node.js）。

> Remote-control MiMo Desktop from Telegram. Zero npm dependencies. China-friendly proxy support.

## 能做什么

- 在 Telegram 私聊里直接指挥 MiMo（问问题、让它在电脑上干活）
- 自动绑定 / 手动 `/bind` 会话，可与桌面端会话对应查看
- 白名单限制谁能用（强烈建议配置）
- 回复过长自动分段；处理中会更新“正在干活”提示
- 国内网络可通过本机代理（Clash 等）访问 Telegram

## 前置条件

1. 电脑上已安装并登录 **MiMo Desktop**（小米 MiMo）
2. 电脑能访问 Telegram（推荐本机代理，如 Clash，常见端口 `7890`）
3. Node.js 18+（若装过 MiMo Desktop，通常已自带可用 Node）

## 快速开始

### 1. 申请 Telegram 机器人

1. 在 Telegram 里找 [@BotFather](https://t.me/BotFather)
2. 发送 `/newbot`，按提示取名
3. 复制得到的 **Bot Token**（形如 `123456:ABC-DEF...`）

### 2. 配置

```bash
cp config.example.json config.json
```

用记事本打开 `config.json`，至少填写：

```json
{
  "bot_token": "你的Token",
  "allowed_user_ids": [123456789]
}
```

- `allowed_user_ids`：你的 Telegram 数字 ID（可找 [@userinfobot](https://t.me/userinfobot) 查询）。留空 = 允许所有人（不建议）。
- `proxy`：国内默认 `http://127.0.0.1:7890`，按你的代理端口修改。
- `model`：MiMo 使用的模型 ID，默认 `xiaomi/mimo-v2.6-flash`。
- `desktop_api_json`：一般可留空，程序会自动在 `%APPDATA%\Xiaomi MiMo\desktop-api.json` 查找。

### 3. 启动

1. 先打开 **MiMo Desktop**，等它完全加载
2. 双击 `start.bat`（Windows）或运行：

```bash
# Windows（自备代理环境变量时）
set HTTPS_PROXY=http://127.0.0.1:7890
set HTTP_PROXY=http://127.0.0.1:7890
set NODE_USE_ENV_PROXY=1
node bridge.js
```

看到 `开始收消息` 即成功。此窗口需保持打开。

### 4. 使用

在 Telegram 里打开你的机器人，直接发消息即可。

首次发言会自动绑定一个 MiMo 会话（会跳过你桌面上正在聊的那一条，避免串台）。

| 命令 | 作用 |
|------|------|
| `/start` `/help` | 帮助 |
| `/status` | 检查本机 MiMo 是否在线 |
| `/sessions` | 列出最近的 MiMo 会话 |
| `/bind <会话ID>` | 绑定到指定会话 |

在 MiMo Desktop 侧边栏点开对应会话，可以看到完整聊天记录。

## 确认框与选择题：手机端的两条对策

MiMo Desktop 目前的本地接口**没有开放**确认框/选择题的回应入口（实测 `/permissions`、`/questions` 等路径全部 404），
所以手机端**没法替你点电脑上的确认框**。本桥用两个办法减少这种卡死：

**1) 让它尽量不弹框（预防）**

每条消息发给 MiMo 前，会自动加一段前缀，要求它：

> 遇到需要确认、需要二选一、需要审批的操作时，不要停下来问，自己按最合理最保守的方案做完，
> 并在最后说明做了哪些假设。

这段提示写死在 `bridge.js` 的 `REMOTE_HINT`，也可用 `config.json` 里的 `system_hint` 叠加自己的规则。

**2) 卡住就提醒你（兜底）**

一轮任务超过 3 分钟没有任何输出时，会在 Telegram 里发一条提醒：很可能电脑上弹了确认框，
需要你回电脑点一下，点完这里会继续收到结果。

> 想彻底避免弹框，可在 MiMo Desktop 里把权限设为「完全访问权限」。

## 稳定性：断线自动恢复

桥掉了不用管，程序会自己想办法。

**内建自愈（`bridge.js`）**

- 单个错误不会让进程崩掉（捕获未处理异常）
- MiMo Desktop 还没启动时，最多等 30 分钟，期间每分钟重试一次，不再直接退出
- Telegram 连不上时按 5s→60s 逐步延长重试；连续失败约 3 分钟就主动退出，交给看护程序重启
- 用 `bridge.lock` 保证同一时间只有一个实例（Telegram 长轮询不允许两个实例抢同一条消息通道）
- 定期写 `heartbeat.txt` 心跳，供看护程序判断是否卡死
- 发送失败（网络抖动）自动重试最多 3 次

**消息发送**

- 每个聊天本地限速 15 条/分钟，超了排队；进度提示走“编辑消息”，不占额度
- 遇到 Telegram 429 限流，按平台给的 `retry_after` 等待后重试
- 长回复自动按 4000 字分段发送

**超时后补发**

前台只等 `turn_timeout_min`（默认 30 分钟）。等不到就转入后台继续盯：

- 后台每 10 秒检查一次，任务完成立刻把结果补发到原聊天（带「（补发）」前缀）
- 同一条任务只跟踪一次，避免重复发送
- 后台最长跟踪 `deferred_timeout_min`（默认 180 分钟），超时才放弃并提示

**代理与连接隔离**

- 启动时自动把 `localhost,127.0.0.1,::1` 加进 `NO_PROXY`：本机 MiMo 接口永远不走代理，
  避免代理切节点时本地调用偶发失败（Telegram 请求仍按 `HTTPS_PROXY` 走代理）
- 每个请求都有独立超时：本机接口 15 秒、发送消息 20 秒、长轮询 45 秒，
  长轮询卡住不会拖住发送，反之亦然
- 收消息与干活解耦：任务在串行队列里排队执行，`getUpdates` 持续运行，
  一轮长任务跑 30 分钟期间也能照常收到新消息

**延迟参考（实测）**

MiMo 落盘 → 桥发现约 1.5 秒 → 消息发出约 2 秒。
如果你手机上的 Telegram 明显更晚才收到，延迟通常在手机端推送网络，而不是桥。

**看护进程（`watchdog.ps1`）**

每 60 秒检查一次：

- 桥不在 → 拉起
- 发现多个实例 → 全部清掉重开一个（解决 `Conflict: terminated by other getUpdates request`）
- **心跳 > 15 分钟且日志也 > 15 分钟没动** → 判定真卡死，重启
- 心跳旧但日志还在写 → 说明只是网络在重试，**不动它**（避免代理抖动时反复重启）
- 重启间隔按 1→2→4→8→10 分钟退避，连续稳定 5 分钟后清零

启动看护（任选其一）：

```bat
:: 有窗口，方便看输出
watchdog.bat
```

```bat
:: 全静默，适合后台常驻
wscript start-watchdog.vbs
```

**开机自启**

把 `start-watchdog.vbs` 的快捷方式放进启动文件夹：

```
%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup
```

（按 `Win+R` 输入 `shell:startup` 可直接打开该文件夹）

## 自检

改完配置或排查问题时，可以跑一次自检（会给指定聊天发测试消息）：

```bash
node selftest.js <你的chatId>            # 限流 + 补发都测
node selftest.js <你的chatId> deferred   # 只测补发
```

## 为什么必须用会话自己的目录

MiMo 的每个会话都绑着一个工作目录。向会话提交任务时如果传了不匹配的 `dir`，
接口会返回 `202 Accepted`，但任务**永远不会执行**，也不报错。

本桥会自动从会话列表里查出该会话的真实目录再提交，所以不需要手工配置。
如果你自己改代码，请保持这一点。

## 工作原理

```
Telegram  --长轮询-->  bridge.js  --本机 HTTP-->  MiMo Desktop (desktop-api.json)
                              ^                        |
                              +------ 结果回传 --------+
```

- 桥读取 `%APPDATA%\Xiaomi MiMo\desktop-api.json` 获得本机端口与令牌（每次启动 MiMo 会变化，故每次现读）
- 通过 `POST /v1/sessions/{id}/turns` 提交任务，轮询 `GET /v1/sessions/{id}/messages` 取最终回复
- 仅监听 `127.0.0.1`，Token 不出本机

## 文件说明

| 文件 | 说明 |
|------|------|
| `bridge.js` | 主程序 |
| `config.example.json` | 配置模板（复制为 `config.json`） |
| `start.bat` | Windows 一键启动（单次运行） |
| `watchdog.ps1` | 看护程序（掉线/卡死自动重启） |
| `watchdog.bat` | 带窗口启动看护 |
| `start-watchdog.vbs` | 静默启动看护（开机自启用它） |
| `selftest.js` | 自检脚本（测限流与补发） |
| `session-map.json` | 聊天 ↔ 会话映射（自动生成） |
| `bridge.log` | 桥运行日志 |
| `watchdog.log` | 看护日志 |

## 安全提醒

- **不要**把 `config.json`（含 Bot Token）提交到任何仓库或发给他人
- 务必配置 `allowed_user_ids` 白名单
- 本桥会让 Telegram 间接操作你电脑上的 MiMo，请只信任自己的账号

## 常见问题

**双击 start.bat 没反应？**  
请确认已复制并填写 `config.json`；用管理员权限以外的方式重新双击；或在命令行里运行 `node bridge.js` 看具体报错。

**连不上 MiMo？**  
先打开 MiMo Desktop，等界面就绪后再启动桥。

**Telegram 无回复？**  
检查 Token、代理是否开着、`start.bat` 窗口是否还在、日志 `bridge.log`。

**想换会话？**  
Telegram 里发 `/sessions`，再 `/bind <ID>`。

## 致谢

- 架构思路来自 [dsh-im](https://github.com/xmanrui/dsh-im)
- 依赖 [MiMo Desktop](https://github.com/XiaomiMiMo) 本机接口

## License

[MIT](./LICENSE)
