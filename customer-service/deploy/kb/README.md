# 客服知识库（kb）

本目录是客服系统运行时检索的知识库（容器内挂载为 `/kb`，只读）。

## 内容

来自澳门电力公司官网内容转换的 Markdown 资料（中/英/葡）：

| 类别 | 文件 |
|---|---|
| FAQ / 客户服务 | `faq.md` `client-service.md` `service-box.md` |
| 电费与账单 | `configuration.md` `ev-tip-configuration.md` |
| 停电 / 用电安全 | `power-outage.md` `ev-tip.md` |
| 电动车 / 车型 | `car-model.md` `ev-tip.md` |
| 公告 / 新闻稿 | `announcements.md` `press-release-001~005.md`（688 篇已按 <2MB 拆分） |
| 年报 / 活动 / 其它 | `annual-report.md` `event.md` `education.md` `main-menu.md` … |

## 更新方式

- 直接把 `.md` 文件放入本目录（或子目录），客服下次检索即命中（无需重启；
  检索有 ~5s 目录缓存）。注意**单文件 ≤ 2MB**（检索插件上限；超大文件请先拆分）。
- 若用 Obsidian 维护：把 vault 目录经 compose 的 `KB_VAULT_DIR` 指向即可
  （本目录是默认值 `./kb` 的示例）。
- 本目录内容随 git 分发；生产环境可从 `KB_VAULT_DIR` 挂载自己的 vault，
  不必使用仓库内这份。

## 来源

`/home/as-workstation01/Downloads/临时文件资料/客服agent/json2md/md`（json2md 转换产物，
2026-09-04 同步）。
