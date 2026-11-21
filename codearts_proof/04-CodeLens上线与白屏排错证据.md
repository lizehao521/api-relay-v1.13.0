# CodeLens 组合方案上线证据（2026-11-06 ~ 2026-11-07）

> 本文是 `codearts_proof/` 的**第二轮**证据补录，记录「api-relay 底座 + CodeLens 工作台」组合方案的真实上线过程。
> 与 `00-码道使用总览.md`（第一轮，2026-10-18 ~ 10-28，42 会话）的关系：同项目、同工作区、不同阶段，可合并计数。
> **原始存档**：`~/.codearts/kernel/sessions/api-relay-v1-13-0-li1119489753-d1468474b17a317f/<session_id>/{meta.json, history.jsonl}`，评委可当场核验。

---

## 1. 会话清单（6 个，共 18,264,804 tokens）

| # | session_id（前 8 位） | 角色 | 时间（UTC） | tokens | 用户轮次 | 主要任务 |
|---|---|---|---|---|---|---|
| 43 | `605731b7` | team-leader | 11-06 17:25 → 11-07 03:12 | 4,548,534 | 15 | 主控：接手文档 → 拆解 11 个任务 → 发布/汇总子智能体 |
| 44 | `246cc3ac` | team-mate | 11-06 17:25 → 17:27 | 306,067 | 2 | 端口探测（**结论后来被证伪并纠正**） |
| 45 | `e1c815e4` | team-mate | 11-06 17:25 → 17:31 | 3,445,644 | 2 | 只读核查：API Key 创建途径、模型可用性 |
| 46 | `f3b13c68` | team-mate | 11-06 17:25 → 11-07 03:05 | 3,685,671 | 3 | 部署包修复（**CRLF 缺陷**）、重新打包 |
| 47 | `05d1331a` | team-mate | 11-07 02:46 → 03:11 | 5,757,640 | 4 | SSH 重试 → 上传部署 → 公网端到端验收 |
| 48 | `1374bbdf` | team-mate | 11-07 03:05 → 03:07 | 521,248 | 1 | 只读校验：包体积 / 文件数 / CR 字节级复核 |

**合计：6 个会话 / 18,264,804 tokens。** 与本项目第一轮 42 会话（569,749,124 tokens）合并后为 **48 会话 / 588,013,928 tokens**。

---

## 2. 证据一：端口探测误判与自我纠正（最有价值的一次排错）

**错误结论**（会话 #44，仅用 Node `net.connect`）：

| 端口 | 结果 | 当时的判定 |
|---|---|---|
| 22 | ECONNREFUSED | 「数据包到达主机但无进程监听 → sshd 未运行」 |
| 2222 | ECONNREFUSED | 同上 |
| 8787 | OPEN | api-relay 正常 |
| 8788 | TIMEOUT | 安全组未放行 |
| 22022（对照） | TIMEOUT | 基线，用于验证语义 |

子智能体还用「22022 对照组」论证了 `TIMEOUT = 安全组丢包`、`ECONNREFUSED = 主机无监听` 的映射，逻辑上是自洽的——**但前提本身是错的**。

**纠正**（会话 #47 主控汇总原文摘录）：

> 「之前那次显示“22/2222 ECONNREFUSED”，结论是“主机没有监听”，但其中一部分是**探测方法误判**：node 的 `net.connect` 在这台机器上访问外网时表现异常（连 baidu、github 都超时，但对 223.5.5.5:443 却通）。改用 .NET TcpClient、curl 和真实握手后确认：22 **OPEN**，`SSH-2.0-OpenSSH_9.6p1 Ubuntu-3ubuntu13.18`。」

**为什么这一段值得放进证明材料**：它展示了码道驱动下的「**多方法交叉验证 → 主动推翻自己**」闭环，而不是一次就写对的幸运路径。对照实验设计得很漂亮，但错的假设会产出漂亮的无用结论；真正救回来的是换实现（.NET TcpClient / curl / 真实 SSH 握手）重测。

---

## 3. 证据二：Windows 工作副本 CRLF 导致 KEY_MISMATCH

**现象**：CodeLens 在服务器（Ubuntu 24.04 / Node v22.23.4）启动后鉴权失败。根因不是密钥错误，而是 **`.env` 行尾带 `\r`**：Windows 工作副本生成的配置文件在 Linux 上被读成 `sk-xxx\r`，与上游比对时必然不匹配。

**修复**（会话 #46，task id=9 `fix_crlf`）：

```bash
# codelens/deploy/install-server.sh：生成/更新 .env 后、校验前插入归一化
sed -i 's/\r$//' "$APP/.env"
```

打包侧 `pack-local.sh` 同步做行尾归一化，确保持续交付不再复发。

**同一会话里还纠正了一个计量陷阱**（原话摘录）：

> 「本机 Git Bash（MSYS）的 `grep` 会把行尾 CR 当作行结束处理，导致 `grep -c $'\r'` 对 CRLF 文件也会返回 0……因此额外做了**字节级复核**（`tr -cd "\r" | wc -c` 与 `perl -0777 -ne 'print 0+(()=/\r/g)'` 两条独立方法）。」

**价值**：这是典型的「**工具自身会骗你**」——用 `grep` 验证 CRLF 会得到假阴性。证据里保留了错误方法和正确方法的对照，说明开发者是理解原理而非碰运气。

---

## 4. 证据三：模型可用性只读核查（避免了答辩现场 404）

会话 #45 的只读核查结论：

> 「`qwen3.8-flash-next` 在整个仓库里只出现在 `codelens/deploy/codelens.env.example:17`，因此**必定返回 404**。`qwen3.8-flash` 虽然存在于配置中，但只在已 `disabled` 的三条 opencsg 上游上，直接请求会被静默降级。」

→ 后续将 `TRIAL_MODEL` 切换为实测可用的 `glm-5.3`，并实测 `channel=native / toolCallCount=1`。

**价值**：证明「**先核查再落盘**」不是口号，而是靠读源码 + 配置交叉定位，把一个 5 分钟后才会在答辩现场爆炸的问题提前掐掉。

---

## 5. 证据四：部署产物只读校验（4,729 文件 / 39MB / CR=0）

会话 #48 输出原文：

```
$ du -h codelens-dist.tar.gz
39M	codelens-dist.tar.gz
$ stat -c %s codelens-dist.tar.gz
40729944
$ tar -tzf codelens-dist.tar.gz | wc -l
4729
$ # 包内 deploy 脚本 CR 计数（期望 0，字节级复核）
deploy/codelens.env.example=0
deploy/install-server.sh=0
deploy/pack-local.sh=0
deploy/setup-nginx.sh=0
```

---

## 6. 证据五：CSP `upgrade-insecure-requests` 导致白屏（2026-11-07，headless 实证）

**现象**：`http://1.92.92.200:8788` 页面全白，但 curl 请求所有资源均返回 200。

**排查路径**（全程用码道执行）：

1. 公网 curl 验证：7 个 JS/CSS 资源全部 200 → 排除鉴权问题；
2. 检查 MIME：`Content-Type: text/javascript` 正确 → 排除 MIME 问题；
3. **headless Edge 渲染 + netlog 抓包**，发现真实请求被改写成 https：

```
CORS_REQUEST              https://1.92.92.200:8788/assets/index-DuR-tZKH.js
HTTP_STREAM_JOB_CONTROLLER https://1.92.92.200:8788/assets/index-DuR-tZKH.js
SSL_HANDSHAKE_ERROR -107
URL_REQUEST_START_JOB -107
REQUEST_ALIVE -107
```

4. 定位到上游响应头：`Content-Security-Policy: ...; upgrade-insecure-requests; ...`。该指令把 http 页面下的同源子资源强制升级为 https，而 8788 只监听 http（https 探测返回 000）；
5. 修复：nginx `proxy_hide_header Content-Security-Policy` + 重写 `add_header`，去掉 `upgrade-insecure-requests`，同时给 `script-src` 补 `'unsafe-inline'` 放行内联主题脚本；
6. **复验**：headless Edge 渲染 DOM 由 **2,199 字节 → 26,416 字节**，`#root` 出现完整工作台（「免费试用（固定模型 glm-5.3）：今日还可 47 次」）。

**价值**：这是全项目最隐蔽的一类故障——**状态码全对、资源全 200、只有真实浏览器渲染失败**。证明「不能用状态码代替端到端验证」，也证明码道能驱动 headless 浏览器 + netlog 这类非常规排查手段。

---

## 7. 证据六：上线后运行态（服务器实测原文摘录）

```
● codelens.service - CodeLens local agent workbench (competition demo)
     Loaded: loaded (/etc/systemd/system/codelens.service; enabled; preset: enabled)
     Active: active (running) since Sat 2026-11-07 10:57:31 CST
   Main PID: 6403 (node)
      Tasks: 7 (limit: 824)
     Memory: 52.2M (max: 700.0M available: 378.6M peak: 72.8M)
```

端口分工：`8787` api-relay 网关｜`8788` nginx 对外（Basic Auth + 免密 token 换 cookie）｜`8789` CodeLens 本体，仅 `127.0.0.1`。

---

## 8. 真实性声明

1. 上表 tokens / 时间 / 轮次均**逐字段抄录**自各会话 `meta.json`，未做美化；
2. 会话 #44 的错误结论**原样保留**，并在本文第 2 节完整呈现「错误 → 纠正」过程，不做成功学式删改；
3. 所有服务器输出均为 2026-11-07 当次实测，非历史截图；
4. 凭据、密钥、SSH 密码在所有材料中**从未回显**，仅以「从环境变量读取」「进程内存持有」描述；
5. 本文引用的命令与输出可在 `history.jsonl` 中按 session_id 逐条比对。

---

## 9. 可补录的截图建议（如评委需要可视化）

> 编号从 **S-34** 起，避免与 `02-截图清单与补录指南.md` §9–§11 的既有 S-19~S-33 冲突；该文件 §12 与本表一致。

| 编号 | 内容 | 取图位置 |
|---|---|---|
| S-34 | 主控会话任务面板（11 个子任务状态） | 码道 IDE 会话 `605731b7` |
| S-35 | 端口探测错误结论 → 纠正后结论对照 | 会话 `246cc3ac` / `605731b7` |
| S-36 | CRLF 修复的 diff（install-server.sh / pack-local.sh） | 会话 `f3b13c68` |
| S-37 | headless 渲染白屏（2,199B）vs 修复后工作台（26,416B） | 本地运行 `msedge --headless --dump-dom` 前后 |
| S-38 | CodeLens 工作台运行截图（含试用次数提示条） | `http://1.92.92.200:8788/?token=codelens2026` |