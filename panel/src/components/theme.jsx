import { ConfigProvider, theme } from "antd";

import { UNGROUPED } from "./sidebar.jsx";

/**
 * Ant Design theme, mapped onto the panel's existing CSS custom properties.
 *
 * The point of this file is that adopting a component library does not mean
 * adopting a second visual identity: the bespoke dark palette in
 * public/index.html is the source of truth, and antd's tokens are derived from
 * it so a `<Button>` sits next to a hand-written `.btn` without looking borrowed.
 *
 * The timeline, result cards, drawer and run list stay hand-written — they carry
 * the design the docs and screenshots show, and the whole assertion suite is
 * written against their DOM. antd is used for the primitives where a component
 * library is genuinely better than hand-rolling: theme provider, tooltip, empty
 * state, skeleton, progress bar, badge, tag, button, input.
 */
const tokens = {
  colorPrimary: "#4c9aff",
  colorSuccess: "#36b37e",
  colorWarning: "#ffab00",
  colorError: "#ff5630",
  colorInfo: "#8794a5",
  colorBgBase: "#0e1116",
  colorBgContainer: "#151a21",
  colorBgElevated: "#1b212a",
  colorBorder: "#262e39",
  colorBorderSecondary: "#212934",
  colorText: "#dce3ec",
  colorTextSecondary: "#8794a5",
  borderRadius: 6,
  fontSize: 14,
  wireframe: false,
};

export function PanelTheme({ children }) {
  return (
    <ConfigProvider
      theme={{
        algorithm: theme.darkAlgorithm,
        token: tokens,
        components: {
          Button: { controlHeightSM: 26, paddingInlineSM: 10, fontSizeSM: 12 },
          Tooltip: { colorBgSpotlight: "#1b212a", colorTextLightSolid: "#dce3ec" },
          Empty: { colorTextDescription: "#8794a5" },
          Progress: { defaultColor: "#4c9aff" },
          Tag: { defaultBg: "#212934", defaultColor: "#8794a5" },
        },
      }}
    >
      {children}
    </ConfigProvider>
  );
}

/** Human label for a run's status, for tooltips and tags. */
export const statusColor = {
  running: "processing",
  waiting: "warning",
  blocked: "warning",
  error: "error",
  failed: "error",
  done: "success",
  aborted: "default",
};

export { UNGROUPED };
