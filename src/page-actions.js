/*
 * page-actions.js — resolve an indexed element and act on it, safely.
 *
 * Every action RE-RESOLVES the element from the snapshot's node-identity map and
 * rechecks visibility and occlusion immediately before acting, instead of
 * trusting geometry read during the snapshot. A page that changed since the
 * decision produces a refusal ("stale"), not a blind click on whatever now
 * occupies those coordinates.
 *
 * The click point is the centre of the element's LARGEST rendered fragment, not
 * its bounding box: an inline link that wraps across two lines has two
 * fragments, and the centre of their union can land on plain paragraph text
 * between them — which elementFromPoint correctly reports as "not the link".
 *
 * Adapted (MIT) from ndrezn/ts-browser-agent browser.py.
 */
'use strict';

/**
 * Resolve an element by index and validate it is actionable.
 * Returns coordinates for the caller to click, or a refusal reason.
 * @param {number} index element index from the snapshot
 * @param {"click"|"fill"|"select"} kind
 * @param {string|null} value option value (select) or text (fill)
 */
function forgeActionScript(index, kind, value) {
  return `(() => {
  const store = window.__forgeAgent;
  const el = store && store.nodes ? store.nodes.get(${Number(index)}) : null;
  if (!el || !el.isConnected) return { ok: false, reason: "detached" };
  if (el.disabled || !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) {
    return { ok: false, reason: "not_visible" };
  }
  const fragments = [...el.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
  const rect = fragments.length
    ? fragments.reduce((a, b) => (a.width * a.height >= b.width * b.height ? a : b))
    : el.getBoundingClientRect();
  const x = rect.x + rect.width / 2;
  const y = rect.y + rect.height / 2;
  if (rect.width <= 0 || rect.height <= 0 || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) {
    return { ok: false, reason: "off_screen" };
  }
  const atPoint = document.elementFromPoint(x, y);
  if (!atPoint || !el.contains(atPoint)) return { ok: false, reason: "occluded" };

  if (${JSON.stringify(kind)} === "select") {
    const wanted = ${JSON.stringify(value)};
    if (el.tagName !== "SELECT") return { ok: false, reason: "not_a_select" };
    const hasOption = [...el.options].some((o) => o.value === wanted && !o.disabled);
    if (!hasOption) return { ok: false, reason: "option_missing" };
    el.value = wanted;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, done: true };
  }

  // Focus first so a subsequent insertText lands in the right field.
  try { el.focus({ preventScroll: true }); } catch {}
  return {
    ok: true,
    x: Math.round(x),
    y: Math.round(y),
    tag: el.tagName,
    editable: el.tagName === "TEXTAREA" ||
      (el.tagName === "INPUT" && !["submit","button","reset","checkbox","radio","image"].includes(el.type)),
    // Risk signals the policy layer uses to decide whether a human must approve.
    signal: {
      type: (el.type || "").toLowerCase(),
      isForm: !!el.closest("form"),
      isSubmit: (el.type || "").toLowerCase() === "submit",
      label: (el.innerText || el.value || el.getAttribute("aria-label") || "").slice(0, 120),
      href: el.tagName === "A" ? (el.getAttribute("href") || "") : "",
    },
  };
})()`;
}

/** Scroll the page (no element involved). */
function forgeScrollScript(direction) {
  const dy = direction === 'up' ? -Math.round(600) : Math.round(600);
  return `(() => { window.scrollBy({ top: ${dy}, behavior: "instant" }); return { ok: true, y: window.scrollY }; })()`;
}

module.exports = { forgeActionScript, forgeScrollScript };
