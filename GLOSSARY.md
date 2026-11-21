# 链路盒子

链路盒子管理 Clash Verge 的中转节点，并检查经固定出口建立的代理链路。

## 术语

- **中转入口**（entry relay）是连接固定出口时使用的第一跳，也指容纳这些节点的 Clash 选择组。
- **固定出口**（fixed exit）是通过中转入口连接、对外提供预期公网 IP 的节点。
- **订阅**（subscription）是 Clash Verge 管理的一组远程中转节点。
- **勾选名单**（selection）是用户保存的订阅及节点组合，决定哪些节点可以加入中转入口组。
- **节点归属**（owner subscription of a selected name）是为某个已勾选的节点名称选定的唯一订阅。
- **整理计划**（reconciliation plan）是根据最新订阅得出的勾选名单、候选顺序和应使用的中转入口。
- **全链路测速**（chain benchmark）测量经过中转入口和固定出口、且通过出口 IP 验证的 HTTPS 请求耗时。
- **入口测速**（entrance benchmark）测量只经过中转入口的 HTTPS 请求耗时。
- **同步订阅**（subscription sync）是刷新 Clash Verge 本地订阅缓存并按最新内容整理勾选名单的操作。
