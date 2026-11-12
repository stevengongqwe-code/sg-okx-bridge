# SG-OKX-Bridge — 本地只读预览

这是从原有 OKX MCP 交易桥导出的独立安全预览，保留原工程的风险预检、订单参数处理和测试。**不是生产交易系统：真实及模拟盘的下单、撤单、调杠杆、设置或修改止盈止损一律禁用。** 现有私有部署不会被修改或接管。

## 已实现和限制

- MCP HTTP 服务仅绑定本机 `127.0.0.1`，使用自动生成的本地 bearer token；拒绝带浏览器 Origin 或非本机 Host 的请求。公网上的 OAuth 和远程接入已移除，请勿通过隧道发布。
- 默认离线；`demo_preflight` 使用固定虚构数据，不读取账户或凭证、不访问交易所、不下单。
- 显式设置 `SG_OKX_NETWORK=enabled` 后，市场只读接口可访问网络；账户只读操作还要求服务进程有本地交互式终端、为预览版单独配置的 OKX 凭证以及有效 token；预览版不会复用原私有服务的 Keychain 条目。**未验证真实账户端到端功能。**
- 五个交易写入工具会立即拒绝，并且 CLI 层另有只读白名单。即使修改本地策略，也不能通过这些接口下单。旧风控函数只是预检，不能证明交易安全。
- 请求体上限 64 KiB，不支持分块请求；不接受浏览器直连。服务日志不记录 token；请不要把生成的 `auth-token`、账户数据、策略或日志提交或粘贴到聊天。
- 经过实际验证的环境：macOS 26、Apple Silicon ARM64、Node.js 22。其他平台尚未验证；账户凭证读取使用 macOS Keychain。

## 安装与离线演示

依赖 Node.js 22 和 npm。第一次安装要联网下载开源依赖；演示本身不访问外网，也不需要账户或 API Key。

```sh
npm ci --ignore-scripts
if [ ! -e policy.json ]; then cp policy.example.json policy.json; else echo "保留现有策略"; fi
npm start
```

保持服务在第一个终端运行，在项目目录的第二个终端执行：

```sh
npm run demo
```

应看到包含 `simulation` 的结果；所有数据为虚构。服务在首次启动时生成仅供本机使用的 `auth-token` 文件。按 Ctrl+C 停止预览服务；不会影响已有的其他服务。若端口冲突，在两个终端使用同一个自选端口导出 `SG_OKX_PORT` 后再运行。不要复制既有私有部署的策略、Key 或令牌。

```sh
npm test
```

测试使用虚构输入和临时本地服务，不访问真实交易所。首次安装会产生 `node_modules`；依赖审计数据随时间变化，应重新运行 `npm audit`。

## 边界与许可证

这是从私有项目清洗的**无历史快照**，未包含原部署、Keychain 内容、凭据、配置、状态、日志、备份或原内嵌第三方仓库。根项目采用 MIT，第三方 npm 依赖各有自己的许可证；分发依赖时须保留相应许可声明。详见 [SECURITY.md](SECURITY.md) 与 [CONTRIBUTING.md](CONTRIBUTING.md)。
