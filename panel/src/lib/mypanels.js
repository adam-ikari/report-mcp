/** "我的面板" — on a static host, the bookmark book for your own live panels. */

const KEY = "report-mcp.myPanels";

export const loadPanels = () => {
  try {
    const v = JSON.parse(localStorage.getItem(KEY));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};

const savePanels = (v) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(v));
  } catch {
    /* private mode */
  }
};

/**
 * Add a panel origin. Only http(s) is accepted: a `javascript:` or `data:` URL
 * here would be a stored-XSS vector in the very page we are asking people to
 * bookmark their own panels from.
 *
 * Returns the new list, or null when the input was not an http(s) URL.
 */
export function addPanel(raw) {
  let u = null;
  try {
    u = new URL(String(raw).trim());
  } catch {
    /* not a URL */
  }
  if (!u || (u.protocol !== "http:" && u.protocol !== "https:")) return null;
  const v = loadPanels();
  if (!v.includes(u.origin)) {
    v.push(u.origin);
    savePanels(v);
  }
  return v;
}

export function removePanel(origin) {
  savePanels(loadPanels().filter((u) => u !== origin));
  return loadPanels();
}
