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
| `start.bat` | Windows 一键启动 |
| `session-map.json` | 聊天 ↔ 会话映射（自动生成） |
| `bridge.log` | 运行日志 |

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
