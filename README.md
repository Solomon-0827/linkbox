# 链路盒子 · LinkBox

管理 Clash Verge 的中转节点，保持固定出口，独立检查整条代理链路。

[下载最新版](https://github.com/Solomon-0827/linkbox/releases/latest) · [使用与配置](docs/setup.md) · [发布说明](docs/release-v1.1.0.md)

## 功能

- macOS 原生浅色界面、Windows 桌面界面；关闭窗口后继续后台运行。
- 双击选择中转入口，固定出口保持不变。
- 入口测速、全链路测速，最多 **5 条线路并发**；独立临时内核不启用 TUN，不切换正在使用的节点。
- macOS「管理节点」自动读取 Clash Verge 本地订阅，按订阅分组选择节点，支持全部/分组全选与取消；保存时保留当前入口。
- 本机保存节点筛选规则：屏蔽整个订阅或指定节点，更新订阅后仍保留筛选。
- 启动及每小时自动测速、最后测速时间、结果排序与停止测速。
- 出口 IP、IPv6、WebRTC、Claude Code 现有连接核验；证据不足会显示未验证。
- ipwho.is 与 Net.Coffee 信息展示。第三方评分不保证任何服务的账号安全。

## 下载与安装

| 系统 | 文件 | 使用方式 |
|---|---|---|
| macOS 13+，Apple Silicon | `linkbox-macos-arm64.zip` | 解压，将 `链路盒子.app` 拖到 Applications |
| Windows 10/11，x64 | `linkbox-windows-x64.zip` | 完整解压文件夹，运行 `LinkBox.exe` |

两个版本均需要已安装的 **Clash Verge Rev / Mihomo**，不是独立代理内核。Mac 已内置 Python 后端及依赖；Windows 已内置 Electron，无需另装 Python、Node 或 PyYAML。

Mac 使用本地 ad-hoc 签名，未做 Apple 公证；Windows 暂无发行商代码签名。请核对 Release 中的 SHA-256。代码签名不等同于代理连接的加密。

## 首次配置

1. 在 Clash Verge 中配置 `中转入口` 选择组和名为 `美国静态家宽` 的固定出口，后者设置 `dialer-proxy: 中转入口`。
2. 选择全局模式，GLOBAL 选择固定出口；需要接管全机流量时启用 TUN。
3. 启动链路盒子，点击刷新状态，然后检查网络。预期出口默认取自本机固定出口的 IP 地址。
4. 示例在 [examples](examples)；所有示例地址与密码都是占位值，不能直接联网。

**公开仓库和 Release 不包含任何可用订阅、账号密码、静态家宽凭据或个人测速记录。** 这些数据只放在自己的本机配置中，不应提交到 GitHub。

## 开发与构建

Mac（Apple Silicon）：

```sh
python3 -m venv .venv
. .venv/bin/activate
pip install -r macos/requirements-build.txt
python -m unittest discover -s macos/backend -p 'test_*.py'
python macos/build.py
```

Windows：

```sh
cd windows
npm ci
npm test
npm run package
```

输出在 `dist/`。GitHub Actions 分别在 macOS ARM64 和 Windows x64 上构建；版本标签触发 Release 上传。

## 检测范围

全链路测速测量 HTTPS 请求耗时，不是下载带宽测试。网络检查不会重启 Clash、修改 Claude Code 或关闭其连接，但网络探测会使用少量带宽。无活跃 Claude 连接时无法确认它的实时出口。

Mac 的浏览器检查在打开报告页的浏览器中执行；Windows 检查的是应用内 Chromium，不代表其他浏览器、WSL 或容器。结果只对应当次网络环境。
