import { defineConfig } from "vitepress";

/**
 * Documentation site for report-mcp.
 *
 * Deployed to GitHub Pages under `/report-mcp/` — hence `base`. Everything
 * VitePress generates (asset URLs, markdown links, themeConfig links) is
 * prefixed with it; `docs/public/` contents are copied verbatim on top, which
 * is how the panel demo lands at `/report-mcp/panel/`.
 *
 * `cleanUrls` stays off: GitHub Pages serves `guide/install.html`, but nothing
 * rewrites `/guide/install` for a plain static artifact, so extensionless links
 * would 404.
 */
export default defineConfig({
  lang: "zh-CN",
  title: "report-mcp",
  description: "agent 向人类汇报的 MCP server：单向推送进度、状态、日志与结构化成果，落盘 JSONL，实时呈现到本地面板",
  base: "/report-mcp/",
  cleanUrls: false,
  lastUpdated: true,

  // docs/public/panel/assets/*.md are demo artifact *data* files staged by
  // scripts/stage-panel.mjs, not documentation — without this VitePress
  // compiles them into pages (and SSR chokes on their content).
  srcExclude: ["**/panel/**"],

  head: [
    ["link", { rel: "icon", type: "image/svg+xml", href: "/report-mcp/favicon.svg" }],
    ["link", { rel: "icon", type: "image/png", sizes: "32x32", href: "/report-mcp/favicon-32.png" }],
    ["link", { rel: "apple-touch-icon", sizes: "180x180", href: "/report-mcp/favicon.png" }],
    ["meta", { name: "theme-color", content: "#4c9aff" }],
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:title", content: "report-mcp" }],
    [
      "meta",
      {
        property: "og:description",
        content: "agent 向人类汇报的 MCP server：单向、非阻塞、可审计、实时面板",
      },
    ],
    ["meta", { property: "og:image", content: "https://adam-ikari.github.io/report-mcp/images/og-image.png" }],
    ["meta", { property: "og:image:alt", content: "report-mcp 面板：左侧 run 列表，右侧实时时间线" }],
    ["meta", { name: "twitter:card", content: "summary_large_image" }],
    ["meta", { name: "twitter:image", content: "https://adam-ikari.github.io/report-mcp/images/og-image.png" }],
  ],

  themeConfig: {
    nav: [
      { text: "指南", link: "/guide/install" },
      { text: "参考", link: "/reference/tools" },
      { text: "更新日志", link: "/changelog" },
      { text: "在线 Demo", link: "/panel/", target: "_blank" },
      { text: "Releases", link: "https://github.com/adam-ikari/report-mcp/releases" },
      { text: "GitHub", link: "https://github.com/adam-ikari/report-mcp" },
    ],

    sidebar: [
      {
        text: "指南",
        items: [
          { text: "安装与接入", link: "/guide/install" },
          { text: "使用方法", link: "/guide/usage" },
          { text: "面板与 Demo", link: "/guide/panel" },
        ],
      },
      {
        text: "参考",
        items: [
          { text: "Tool 一览", link: "/reference/tools" },
          { text: "架构与数据模型", link: "/reference/architecture" },
          { text: "设计决策与局限", link: "/reference/design" },
        ],
      },
      {
        text: "开发",
        items: [{ text: "开发、测试与发布", link: "/contributing" }],
      },
    ],

    socialLinks: [{ icon: "github", link: "https://github.com/adam-ikari/report-mcp" }],

    notFound: {
      title: "404 · 页面不存在",
      quote: "链接可能写错了，也可能这个 run 早被清掉了。面板不会说谎，但 URL 会过期。",
      linkText: "回到首页",
      linkLabel: "回到首页",
    },

    outline: { label: "本页目录", level: [2, 3] },
    lastUpdated: { text: "最后更新" },
    docFooter: { prev: "上一页", next: "下一页" },
    returnToTopLabel: "回到顶部",
    sidebarMenuLabel: "菜单",
    darkModeSwitchLabel: "外观",

    search: {
      provider: "local",
      options: {
        translations: {
          button: { buttonText: "搜索文档", buttonAriaLabel: "搜索文档" },
          modal: {
            displayDetails: "显示详情",
            resetButtonTitle: "清除查询条件",
            backButtonTitle: "关闭搜索",
            noResultsText: "未找到相关结果",
            footer: {
              selectText: "选择",
              selectKeyAriaLabel: "回车",
              navigateText: "切换",
              navigateUpKeyAriaLabel: "上箭头",
              navigateDownKeyAriaLabel: "下箭头",
              closeText: "关闭",
              closeKeyAriaLabel: "esc",
            },
          },
        },
      },
    },

    footer: {
      message: "agent → 人类的单向汇报通道 · MIT License",
      copyright: "report-mcp v0.3.0",
    },
  },
});
