# 链路盒子 v1.1.0

首次公开发布 macOS / Windows 版本。

- 独立节点测速从 3 路提升至 5 路，保留取消、网络变更检测与进程清理。
- 支持本机节点筛选规则，按代理商或节点名称排除，不自动切换当前入口。
- 专用 DNS 策略随隔离测速配置保留，避免误判节点不可用。
- Mac 保留原生浅色界面，内置后端和 PyYAML，不再要求 Homebrew Python。
- Windows 保留托盘后台运行、双击切换、每小时测速、IP / Net.Coffee 卡片及网络检查。
- 预期出口读取本机设置，不把开发者的 IP、订阅地址或凭据写入程序。

## 下载

- Apple Silicon Mac：`linkbox-macos-arm64.zip`
- Windows x64：`linkbox-windows-x64.zip`
- 对应 `.sha256` 文件用于校验下载完整性。

程序需要已安装的 Clash Verge。公开包只有示例配置，没有可用代理账号。Mac 为 ad-hoc 签名、未经公证；Windows 暂无发行商签名。

自动测试与打包不等于全部真实网络场景的验收。尤其是 Windows 的物理网卡、TUN 与现有 Claude Code 连接，需要在自己的 Windows 实机上用“检查网络”确认。
