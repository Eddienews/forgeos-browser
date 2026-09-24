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
 * Two lists come back, and the split matters:
 *   elements    — actionable now, on screen
 *   below_fold  — real controls that exist but are out of view
 *
 * Reporting the second list is what stops an agent from scrolling blindly. A
 * page whose only way forward is a "Next" link far below the fold used to look
 * EMPTY: the agent saw nothing, scrolled hoping, and saw nothing again. Knowing
 * that a named control exists below is the difference between searching and
 * knowing.
 *
 * What counts as actionable is the DOM's answer, not ours: a tag rendered as
 * <a> with no href is not a link. Sites do that for styling, and offering those
 * as targets would waste the agent's steps.
 *
 * Element ids live in a WeakMap keyed by the DOM node, so an index survives
 * re-snapshots as long as the node itself is still attached.
 *
 * Adapted (MIT) from ndrezn/ts-browser-agent snapshot.py and
 * browser-use/jev-ultrafast. Runs as a plain function; no Node APIs.
 */
'use strict';

const { snapshotSafetyScript } = require('./engine/sensitive-fields');
const { forgeEffectProofSource } = require('./page-actions');

/** Build (or reuse) the per-page agent store. */
function forgeSnapshotScript(includePrivateEffectProofs = false) {
  return `(() => {
  ${snapshotSafetyScript()}
  ${forgeEffectProofSource()}
  const privateEffectProofs = ${includePrivateEffectProofs ? 'new Map()' : 'null'};
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
    if (el.tagName === "INPUT" && ["submit", "button", "reset", "image"].includes(el.type)) {
      return String(el.value || "").trim();
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

  const sensitive = (el, label = "") => classifyField({
    ...domFieldInfo(el), label,
  }).sensitive;
  const formInfo = (el) => {
    const form = el.form || el.closest("form");
    if (!form) return { form_action: null, form_method: null };
    const target = el.getAttribute("formaction") || (form.getAttribute && form.getAttribute("action")) || location.href;
    const method = (el.getAttribute("formmethod") || (form.getAttribute && form.getAttribute("method")) || "get").toLowerCase();
    return { form_action: safeUrl(target), form_method: /^(get|post|dialog)$/.test(method) ? method : "unknown" };
  };
  const isSubmit = (el) => (el.tagName === "BUTTON" && (el.type === "submit" || !!el.form || !!el.closest("form"))) ||
    (el.tagName === "INPUT" && (["submit", "image"].includes(el.type) ||
      (el.type === "button" && (!!el.form || !!el.closest("form"))))) ||
    (el.getAttribute("role") === "button" && !!el.closest("form"));

  // A native <a> with no href is styling, not navigation. ARIA roles on plain
  // <li>/<div> are included because autocomplete menus render that way — without
  // them a suggestion list is visible but unclickable.
  const selector =
    "a[href],button,input,textarea,select," +
    "[role='button'],[role='link'],[role='option'],[role='menuitem']," +
    "[role='menuitemradio'],[role='menuitemcheckbox'],[role='tab']," +
    "[role='checkbox'],[role='radio'],[role='switch']";

  const MAX_ELEMENTS = 200;
  const MAX_BELOW_FOLD = 60;
  const elements = [];
  const belowFold = [];
  let occluded = 0;
  let offscreen = 0;

  // Viewport-only for the main list is a cheap focus: what is below the fold is
  // reached by scrolling first, and this keeps candidate counts bounded. But it
  // is an OPTIMISATION, not a defence — a native view that is not laid out yet
  // reports 0, and filtering by that would silently empty the catalogue and
  // leave the agent blind on a page full of controls. Only filter when usable.
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const viewportUsable = vw > 0 && vh > 0;
  const inViewport = (x, y) => !viewportUsable || (x >= 0 && y >= 0 && x < vw && y < vh);

  const inventory = domFieldInventory();
  const leaked = new Set([...inventory.values, ...queryValues(location.href, location.href)]);
  const collect = (url) => { for (const value of queryValues(url, location.href)) leaked.add(value); };
  // Collect before rendering any text: values may be repeated in prose, title,
  // labels or link text, not just in the input where they originated.
  for (const { el: field, info, classification } of inventory.entries) {
    const label = [info.associatedLabels, info.ariaLabel, info.ariaLabelledBy].filter(Boolean).join(' ');
    if (classification.sensitive) {
      if (label) {
        leaked.add(label);
        for (const token of label.split(/\\s+/)) if (token.length >= 8) leaked.add(token);
      }
      if (field.options) for (const option of field.options) {
        if (option.value) leaked.add(String(option.value));
        if (option.label) leaked.add(String(option.label));
      }
    }
    collect(field.getAttribute("href"));
    collect(field.getAttribute("formaction"));
    const form = field.form || field.closest("form");
    if (form) collect(form.getAttribute && form.getAttribute("action"));
  }
  const safeText = (value) => scrubKnownValues(value, leaked);
  const safeUrl = (value) => value == null ? null : sanitizeUrl(safeText(value));
  const describe = (el, id, label, extra) => {
    if (privateEffectProofs && !privateEffectProofs.has(id)) privateEffectProofs.set(id, forgeEffectProof(el));
    return Object.assign({
    index: id,
    role: roleOf(el) || "generic",
    // Keep the control visible for orientation, but never offer an action the
    // page action gate will necessarily refuse.
    kind: sensitive(el, label) && (editable(el) || el.tagName === "SELECT")
      ? "blocked" : editable(el) ? "fill" : "click",
    label: sensitive(el, label) ? "(sensitive field)" : safeText(label),
    current_value: sensitive(el, label) ? "" : safeText("value" in el ? String(el.value) : ""),
    input_type: (el.type || "").toLowerCase(),
    autocomplete: el.autocomplete || "",
    field_name: sensitive(el, label) ? "" : safeText(el.name || ""),
    sensitive: sensitive(el, label),
    is_submit: isSubmit(el),
    is_anchor: el.tagName === "A",
    ...formInfo(el),
    href: el.tagName === "A" ? safeUrl(el.getAttribute("href")) : null,
    }, extra || {});
  };

  for (const el of document.querySelectorAll(selector)) {
    if (elements.length >= MAX_ELEMENTS && belowFold.length >= MAX_BELOW_FOLD) break;
    if (el.disabled || !visible(el)) continue;
    // Largest rendered fragment, not the union box: a wrapped inline link's
    // union center can sit on text that is not the link.
    const fragments = [...el.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
    if (!fragments.length) continue;
    const rect = fragments.reduce((a, b) => (a.width * a.height >= b.width * b.height ? a : b));
    const cx = rect.x + rect.width / 2;
    const cy = rect.y + rect.height / 2;
    const below = !inViewport(cx, cy);
    if (below && belowFold.length >= MAX_BELOW_FOLD) { offscreen++; continue; }
    if (!below && elements.length >= MAX_ELEMENTS) continue;

    const id = identify(el);
    const label = (accessibleName(el) || roleOf(el) || "element").replace(/\\s+/g, " ").trim();

    if (el.tagName === "SELECT") {
      const bucket = below ? belowFold : elements;
      const cap = below ? MAX_BELOW_FOLD : MAX_ELEMENTS;
      for (const option of el.options) {
        if (bucket.length >= cap) break;
        if (option.disabled) continue;
        bucket.push(describe(el, id, label + " -> " + option.label, {
          option_value: sensitive(el, label + " " + option.label) ? "" : safeText(option.value),
          role: "combobox",
          kind: sensitive(el, label + " " + option.label) ? "blocked" : "select",
          current_value: sensitive(el, label + " " + option.label) ? "" : safeText(el.selectedOptions[0] ? el.selectedOptions[0].label : ""),
          below_fold: below || undefined,
        }));
      }
      continue;
    }

    if (below) {
      offscreen++;
      belowFold.push(describe(el, id, label, { below_fold: true }));
      continue;
    }

    // The SAME occlusion test the action applies (page-actions.js): if another
    // element covers the click point, the agent cannot act here. Offering it
    // anyway taught the model to pick a control it would then be refused on —
    // the catalogue must only contain what is genuinely actionable.
    const atPoint = document.elementFromPoint(cx, cy);
    if (!atPoint || !el.contains(atPoint)) { occluded++; continue; }

    elements.push(describe(el, id, label));
  }

  const bodyText = safeText((document.body ? document.body.innerText : "").slice(0, 4000));
  return {
    url: safeUrl(location.href),
    title: safeText(document.title),
    text: bodyText,
    elements,
    ...(privateEffectProofs ? { _privateEffectProofs: [...privateEffectProofs] } : {}),
    // Real controls that exist out of view: the agent should scroll toward them
    // deliberately instead of hunting for them.
    below_fold: belowFold,
    // Diagnostics, so "the catalogue is empty" is answerable: an unusable
    // viewport, an overlay, or genuinely nothing to press.
    occluded_count: occluded,
    offscreen_count: offscreen,
    viewport: [vw, vh],
    // The scroll position is part of the page's state: without it, scrolling a
    // page whose controls are all below the fold produces an identical
    // observation, and a loop that detects 'nothing changed' stops the very
    // action it needs.
    scroll_y: Math.round(window.scrollY),
    can_scroll_down: window.scrollY + window.innerHeight < document.documentElement.scrollHeight - 2,
    can_scroll_up: window.scrollY > 0,
  };
})()`;
}

module.exports = { forgeSnapshotScript };
