/*
 * page-snapshot.js — indexed DOM snapshot, injected into the page on demand.
 *
 * Reads the page ATOMICALLY, once per step, and returns a stable numbered table
 * of interactive elements plus the visible text. The agent refers to elements by
 * that number; page-actions.js re-resolves geometry and visibility immediately
 * before every action, so a stale index can never click the wrong thing.
 *
 * Why a numbered table: an agent that only receives raw page text cannot act —
 * it has no way to say "click THAT button". Numbers give it a vocabulary.
 *
 * Element ids live in a WeakMap keyed by the DOM node, so an index survives
 * re-snapshots as long as the node itself is still attached.
 *
 * Adapted (MIT) from ndrezn/ts-browser-agent snapshot.py and
 * browser-use/jev-ultrafast. Runs as a plain function; no Node APIs.
 */
'use strict';

/** Build (or reuse) the per-page agent store. */
function forgeSnapshotScript() {
  return `(() => {
  const store = (window.__forgeAgent ??= { ids: new WeakMap(), nodes: new Map(), next: 1 });
  const identify = (el) => {
    if (!store.ids.has(el)) store.ids.set(el, store.next++);
    const id = store.ids.get(el);
    store.nodes.set(id, el);
    return id;
  };
  const visible = (el) =>
    el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) &&
    !el.closest("[aria-hidden='true'],[inert]");

  // Accessible name, computed the way assistive tech does: explicit labelling
  // first, then "name from content". A widget with no label of its own (a
  // calendar cell wrapping a div whose own aria-label carries the date) only
  // gets a meaningful name through the last step.
  const accessibleName = (el, seen = new Set()) => {
    if (!el || seen.has(el)) return "";
    seen.add(el);
    const labelledBy = (el.getAttribute("aria-labelledby") || "")
      .split(/\\s+/).filter(Boolean)
      .map((id) => accessibleName(document.getElementById(id), seen))
      .filter(Boolean).join(" ");
    if (labelledBy) return labelledBy.trim();
    const ariaLabel = el.getAttribute("aria-label");
    if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim();
    if (el.labels && el.labels.length) {
      const fromLabels = [...el.labels].map((l) => accessibleName(l, seen)).filter(Boolean).join(" ");
      if (fromLabels) return fromLabels;
    }
    if (el.tagName !== "INPUT") {
      const fromContent = [...el.childNodes].map((node) => {
        if (node.nodeType === Node.TEXT_NODE) return node.textContent;
        if (node.nodeType === Node.ELEMENT_NODE && node.getAttribute("aria-hidden") !== "true") {
          return accessibleName(node, seen);
        }
        return "";
      }).join(" ").trim();
      if (fromContent) return fromContent;
    }
    return (el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("alt") || "").trim();
  };

  const roleOf = (el) => {
    const tag = el.tagName;
    if (tag === "A" || tag === "BUTTON") return "button";
    if (tag === "SELECT") return "combobox";
    if (tag === "TEXTAREA") return "textbox";
    if (tag === "INPUT") {
      if (["submit", "button", "reset", "image"].includes(el.type)) return "button";
      if (["checkbox", "radio"].includes(el.type)) return el.type;
      return "textbox";
    }
    return el.getAttribute("role");
  };
  const editable = (el) =>
    (el.tagName === "TEXTAREA" ||
      (el.tagName === "INPUT" &&
        !["submit", "button", "reset", "checkbox", "radio", "image"].includes(el.type))) &&
    !el.readOnly;

  // Only what is inside the viewport: elements below the fold are reached by
  // scrolling first, and this keeps candidate counts bounded on real pages.
  // ARIA roles on plain <li>/<div> are included because autocomplete menus
  // render that way — without them, a suggestion list is visible but unclickable.
  const MAX_ELEMENTS = 200;
  const elements = [];
  let occluded = 0; // covered controls, counted for diagnostics
  const selector =
    "a[href],button,input,textarea,select," +
    "[role='button'],[role='link'],[role='option'],[role='menuitem']," +
    "[role='menuitemradio'],[role='menuitemcheckbox'],[role='tab']," +
    "[role='checkbox'],[role='radio'],[role='switch']";

  for (const el of document.querySelectorAll(selector)) {
    if (elements.length >= MAX_ELEMENTS) break;
    if (el.disabled || !visible(el)) continue;
    // Largest rendered fragment, not the union box: a wrapped inline link's
    // union center can sit on text that is not the link.
    const fragments = [...el.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
    if (!fragments.length) continue;
    const rect = fragments.reduce((a, b) => (a.width * a.height >= b.width * b.height ? a : b));
    const cx = rect.x + rect.width / 2;
    const cy = rect.y + rect.height / 2;
    if (cx < 0 || cy < 0 || cx >= innerWidth || cy >= innerHeight) continue;
    const id = identify(el);
    const label = (accessibleName(el) || roleOf(el) || "element").replace(/\\s+/g, " ").trim();
    // The SAME occlusion test the action applies (page-actions.js): if another
    // element covers the click point, the agent cannot act here. Offering it
    // anyway taught the model to pick a control it would then be refused on —
    // the catalogue must only contain what is genuinely actionable.
    const atPoint = document.elementFromPoint(cx, cy);
    if (!atPoint || !el.contains(atPoint)) { occluded++; continue; }
    if (el.tagName === "SELECT") {
      for (const option of el.options) {
        if (elements.length >= MAX_ELEMENTS) break;
        if (option.disabled) continue;
        elements.push({
          index: id,
          option_value: option.value,
          role: "combobox",
          kind: "select",
          label: label + " -> " + option.label,
          current_value: el.selectedOptions[0] ? el.selectedOptions[0].label : "",
        });
      }
      continue;
    }
    elements.push({
      index: id,
      role: roleOf(el) || "generic",
      kind: editable(el) ? "fill" : "click",
      label: label,
      current_value: "value" in el ? String(el.value) : "",
      // The raw attribute, not the resolved URL: "#anchor" says same-page and
      // "/wiki/X" says where a link goes, which a label alone cannot.
      href: el.tagName === "A" ? el.getAttribute("href") : null,
    });
  }

  const bodyText = (document.body ? document.body.innerText : "").slice(0, 4000);
  return {
    url: location.href,
    title: document.title,
    text: bodyText,
    elements,
    // How many controls were skipped because something covers them — a page
    // with many of these is one where the agent will find little to press.
    occluded_count: occluded,
    can_scroll_down: window.scrollY + window.innerHeight < document.documentElement.scrollHeight - 2,
    can_scroll_up: window.scrollY > 0,
  };
})()`;
}

module.exports = { forgeSnapshotScript };
