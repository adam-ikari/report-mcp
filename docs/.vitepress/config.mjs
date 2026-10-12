import { defineConfig } from "vitepress";

/**
 * Documentation site for report-mcp.
 *
 * Deployed to GitHub Pages under `/report-mcp/` — hence `base`. Everything
 * VitePress generates (asset URLs, markdown links, themeConfig links) is
 * prefixed with it; `docs/public/` contents are copied verbatim on top, which
 * is how the example report pages land at `/report-mcp/reports/`.
 *
 * Those pages are NOT site content: scripts/render-samples.mjs renders
 * examples/*.md with the vendored renderer and commits the result, and CI
 * re-renders with --check. They are the vendor's usability gate.
 *
 * `cleanUrls` stays off: GitHub Pages serves `guide/install.html`, but nothing
 * rewrites `/guide/install` for a plain static artifact, so extensionless links
 * would 404.
 */
export default defineConfig({
  lang: "zh-CN",
  title: "report-mcp",
  description: "里程碑汇报的 MCP server：agent 交一份草稿，渲染成一页自包含 HTML，常驻宿主给它一个手机上能点的链接",
  base: "/report-mcp/",
  cleanUrls: false,
  lastUpdated: true,

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
        content: "agent 交草稿，一页自包含 HTML 落盘，宿主给链接：里程碑汇报的 MCP server",
      },
    ],
    ["meta", { property: "og:image", content: "https://adam-ikari.github.io/report-mcp/images/og-image.png" }],
    ["meta", { property: "og:image:alt", content: "report-mcp 渲染出的一页汇报：面板网格、流程图与时序图" }],
    ["meta", { name: "twitter:card", content: "summary_large_image" }],
    ["meta", { name: "twitter:image", content: "https://adam-ikari.github.io/report-mcp/images/og-image.png" }],
  ],

  themeConfig: {
    nav: [
      { text: "指南", link: "/guide/install" },
      { text: "参考", link: "/reference/tools" },
      { text: "更新日志", link: "/changelog" },
      { text: "示例汇报", link: "/reports/01-cache-selection.html", target: "_blank" },
      { text: "Releases", link: "https://github.com/adam-ikari/report-mcp/releases" },
      { text: "GitHub", link: "https://github.com/adam-ikari/report-mcp" },
    ],

    sidebar: [
      {
        text: "指南",
        items: [
          { text: "安装与接入", link: "/guide/install" },
          { text: "使用方法", link: "/guide/usage" },
        ],
      },
      {
        text: "参考",
        items: [
          { text: "Tool 一览", link: "/reference/tools" },
          { text: "架构与决策", link: "/reference/architecture" },
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
      quote: "页面 URL 由 run id、seq 和 slug 拼出来，永久不变——所以大概率是这条链接自己写错了。",
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
      copyright: "report-mcp v0.4.0",
    },
  },
});
