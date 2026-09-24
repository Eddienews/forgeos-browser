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
const { snapshotSafetyScript } = require('./engine/sensitive-fields');

// This private, unsanitized effect witness is returned only to the main process,
// hashed there, and stripped before any snapshot reaches an agent. Use the SAME
// source at observation and inspection; display projections cannot prove that a
// redacted query parameter or a labeled control has not changed.
function forgeEffectProofSource() {
  return `const forgeEffectProof = (el) => {
    // Never transfer an unbounded page-controlled witness over Electron IPC.
    // An oversized target remains visible in the snapshot but is not actionable.
    if (el.options && el.options.length > 100) return null;
    const textContent = el.textContent || "";
    const label = el.getAttribute("aria-label") || el.innerText || el.value || "";
    if (textContent.length > 4096 || String(label).length > 4096) return null;
    const form = el.tagName === "A" ? null : (el.form || el.closest("form"));
    const href = el.tagName === "A" ? (el.getAttribute("href") || "") : "";
    const formAction = form ? (el.getAttribute("formaction") !== null ? el.getAttribute("formaction") : (form.action || location.href)) : "";
    const formMethod = form ? (el.getAttribute("formmethod") !== null ? el.getAttribute("formmethod") : (form.method || "get")).toLowerCase() : "";
    let resolvedHref = "", resolvedFormAction = "";
    try {
      if (href) resolvedHref = new URL(href, location.href).href;
      if (form) resolvedFormAction = new URL(formAction, location.href).href;
    } catch { return null; }
    const field = ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) ? domFieldInfo(el) : null;
    const labelledBy = (el.getAttribute("aria-labelledby") || "").split(/\\s+/).filter(Boolean)
      .map(id => { const named = document.getElementById(id); return named ? String(named.textContent || "") : ""; });
    const nestedNodes = typeof el.querySelectorAll === "function" ? el.querySelectorAll("[aria-label]") : [];
    if (nestedNodes.length > 100) return null;
    const nestedLabels = [...nestedNodes].map(node => node.getAttribute("aria-label") || "");
    const result = {
      tag: el.tagName, type: (el.type || "").toLowerCase(), role: el.getAttribute("role") || "",
      label, labelledBy, nestedLabels, textContent,
      title: el.getAttribute("title") || "", disabled: !!el.disabled, readOnly: !!el.readOnly,
      resolvedHref, resolvedFormAction, formMethod,
      field, value: field && el.tagName !== "SELECT" ? String(el.value || "") : "",
      options: el.tagName === "SELECT" ? [...el.options].map(o => [o.value, !!o.disabled, o.text || ""]) : null,
    };
    return JSON.stringify(result).length <= 32768 ? result : null;
  };`;
}

// Synchronous SHA-256 is required here: WebCrypto is asynchronous and would
// allow the DOM to change between proof verification and the actual mutation.
function forgeProofDigestSource() {
  return `const forgeProofDigest = (proof) => {
    const bytes = new TextEncoder().encode(JSON.stringify(proof));
    const data = new Uint8Array((bytes.length + 9 + 63) & ~63);
    data.set(bytes); data[bytes.length] = 0x80;
    const bits = bytes.length * 8;
    data[data.length - 4] = bits >>> 24;
    data[data.length - 3] = bits >>> 16;
    data[data.length - 2] = bits >>> 8;
    data[data.length - 1] = bits;
    const h = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
    const k = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
      0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
      0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
      0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
      0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
      0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
      0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
      0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
    const rotr = (v, n) => (v >>> n) | (v << (32 - n));
    for (let offset = 0; offset < data.length; offset += 64) {
      const w = new Uint32Array(64);
      for (let i = 0; i < 16; i++) { const j = offset + 4 * i;
        w[i] = (data[j] << 24) | (data[j+1] << 16) | (data[j+2] << 8) | data[j+3]; }
      for (let i = 16; i < 64; i++) {
        const x = w[i-15], y = w[i-2];
        const s0 = rotr(x,7) ^ rotr(x,18) ^ (x >>> 3);
        const s1 = rotr(y,17) ^ rotr(y,19) ^ (y >>> 10);
        w[i] = (w[i-16] + s0 + w[i-7] + s1) >>> 0;
      }
      let [a,b,c,d,e,f,g,z] = h;
      for (let i = 0; i < 64; i++) {
        const s1 = rotr(e,6) ^ rotr(e,11) ^ rotr(e,25);
        const t1 = (z + s1 + ((e & f) ^ (~e & g)) + k[i] + w[i]) >>> 0;
        const s0 = rotr(a,2) ^ rotr(a,13) ^ rotr(a,22);
        const t2 = (s0 + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
        z=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=b;b=a;a=(t1+t2)>>>0;
      }
      const state = [a,b,c,d,e,f,g,z];
      for (let i = 0; i < 8; i++) h[i] = (h[i] + state[i]) >>> 0;
    }
    return h.map(x => x.toString(16).padStart(8, "0")).join("");
  };`;
}

/**
 * Resolve an element by index and validate it is actionable.
 * Clicks, fills and selections execute in the validated page turn (no
 * focus-to-insertText mutation window), or return a refusal reason.
 * @param {number} index element index from the snapshot
 * @param {"click"|"fill"|"select"} kind
 * @param {string|null} value option value (select) or text (fill)
 */
function forgeActionScript(index, kind, value, approval = null) {
  return `(() => {
  ${snapshotSafetyScript()}
  ${forgeEffectProofSource()}
  ${forgeProofDigestSource()}
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
  const currentEffect = forgeEffectProof(el);
  if (!currentEffect) return { ok: false, reason: "effect_proof_unavailable" };

  // Check the CURRENT DOM, not an earlier snapshot or caller-supplied signal.
  // The approved click is performed inside this same JS turn, so a changed
  // button cannot become a submit between resolution and main's mouse events.
  const href = el.tagName === "A" ? (el.getAttribute("href") || "") : "";
  const type = (el.type || "").toLowerCase();
  const isSubmit = (el.tagName === "BUTTON" && (type === "submit" || !!el.form || !!el.closest("form"))) ||
    (el.tagName === "INPUT" && (["submit", "image"].includes(type) ||
      (type === "button" && (!!el.form || !!el.closest("form"))))) ||
    (el.getAttribute("role") === "button" && !!el.closest("form"));
  const label = (el.getAttribute("aria-label") || el.innerText || el.value || "").replace(/\\s+/g, " ").trim();
  const form = el.tagName === "A" ? null : (el.form || el.closest("form"));
  const formAction = form ? (el.getAttribute("formaction") !== null ? el.getAttribute("formaction") : (form.action || location.href)) : "";
  const formMethod = form ? (el.getAttribute("formmethod") !== null ? el.getAttribute("formmethod") : (form.method || "get")).toLowerCase() : "";
  let resolvedFormAction = "";
  let resolvedHref = "";
  try {
    if (form) resolvedFormAction = new URL(formAction, location.href).href;
    if (href) resolvedHref = new URL(href, location.href).href;
  } catch { return { ok: false, reason: "invalid_destination" }; }
  const destination = resolvedFormAction || resolvedHref || "unknown (JavaScript handler may navigate or mutate state)";
  const descriptor = { label, href, type, isSubmit, formAction: resolvedFormAction,
    formMethod, resolvedHref, destination, pageUrl: location.href };
  const approvals = window.__forgeAgentApprovalTargets || (window.__forgeAgentApprovalTargets = new Map());
  const requestedKind = ${JSON.stringify(kind)};
  const proof = ${JSON.stringify(approval)};
  const effectKind = requestedKind === "inspect" || requestedKind === "recheck"
    ? (proof && proof.kind || "click") : requestedKind;
  if (effectKind === "fill" || effectKind === "select") {
    if (effectKind === "fill" && ((el.tagName !== "INPUT" && el.tagName !== "TEXTAREA") ||
        el.readOnly || (el.tagName === "INPUT" &&
          !["text", "search", "email", "url", "tel", "number"].includes(type)))) {
      return { ok: false, reason: "not_editable" };
    }
    if (effectKind === "select" && el.tagName !== "SELECT") return { ok: false, reason: "not_a_select" };
    const field = domFieldInfo(el);
    if (classifyField(field).sensitive) return { ok: false, reason: "sensitive_field" };
    Object.assign(descriptor, { tag: el.tagName, fieldName: el.name || "", fieldId: el.id || "",
      autocomplete: el.autocomplete || "", ariaLabel: field.ariaLabel || "",
      associatedLabels: field.associatedLabels, ariaLabelledBy: field.ariaLabelledBy,
      effectiveFieldMetadata: field, placeholder: el.placeholder || "", testId: field.testId || "", readOnly: !!el.readOnly,
      options: effectKind === "select" ? [...el.options].map(o => [o.value, !!o.disabled, o.text || ""]) : null });
  }
  if (${JSON.stringify(kind)} === "inspect" || ${JSON.stringify(kind)} === "recheck") {
    const nonce = ${JSON.stringify(value)};
    if (typeof nonce !== "string" || !nonce) return { ok: false, reason: "invalid_proof" };
    if ((effectKind !== "click" && effectKind !== "fill" && effectKind !== "select") ||
        (${JSON.stringify(kind)} === "recheck" && approvals.get(nonce) !== el)) {
      return { ok: false, reason: "approval_required_or_stale" };
    }
    if (${JSON.stringify(kind)} === "inspect") approvals.set(nonce, el);
    // Display is a separate projection, never the identity/effect proof. The
    // raw descriptor is checked unchanged on recheck and action execution.
    if (${JSON.stringify(kind)} === "inspect") {
      const inventory = domFieldInventory();
      const values = new Set([...inventory.values, ...queryValues(location.href, location.href),
        ...queryValues(resolvedHref, location.href), ...queryValues(resolvedFormAction, location.href)]);
      for (const { el: field, info, classification } of inventory.entries) {
        if (classification.sensitive) {
          const fieldLabel = [info.associatedLabels, info.ariaLabel, info.ariaLabelledBy].filter(Boolean).join(' ');
          if (fieldLabel) {
            values.add(fieldLabel);
            for (const token of fieldLabel.split(/\\s+/)) if (token.length >= 8) values.add(token);
          }
          if (field.options) for (const option of field.options) {
            if (option.value) values.add(String(option.value));
            if (option.label) values.add(String(option.label));
          }
        }
      }
      const safe = (text) => scrubKnownValues(text, values);
      return { ok: true, descriptor, effectProof: currentEffect, display: {
        label: safe(label), pageUrl: sanitizeUrl(safe(location.href)),
        destination: sanitizeUrl(safe(destination)), formMethod: safe(formMethod),
        fieldName: safe(descriptor.fieldName || ""), fieldId: safe(descriptor.fieldId || ""),
      } };
    }
    return { ok: true, descriptor, effectProof: currentEffect };
  }
  if (proof && proof.nonce && (!/^[a-f0-9]{64}$/.test(proof.effectProofHash || "") ||
      forgeProofDigest(currentEffect) !== proof.effectProofHash))
    return { ok: false, reason: "approval_required_or_stale" };
  if (${JSON.stringify(kind)} === "click") {
    // Literal/private destinations cannot be approved by the agent dialog.
    for (const candidate of [resolvedHref, resolvedFormAction]) {
      if (!candidate) continue;
      const target = new URL(candidate);
      const host = target.hostname.toLowerCase().replace(/^\\[|\\]$/g, "");
      const octets = host.split('.').map(Number);
      const ipv4 = octets.length === 4 && octets.every(n => Number.isInteger(n) && n >= 0 && n <= 255);
      if (!["http:", "https:"].includes(target.protocol) || host === "localhost" || host.endsWith(".localhost") ||
          (ipv4 && (octets[0] === 0 || octets[0] === 10 || octets[0] === 127 ||
            (octets[0] === 169 && octets[1] === 254) || (octets[0] === 192 && octets[1] === 168) ||
            (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31))) ||
          host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80")) {
        return { ok: false, reason: "unsafe_destination" };
      }
    }
    // Only a same-document hash link can be automatic. Every other control
    // requires a proof issued by the main process after its native dialog.
    const hashOnly = !!href && href.startsWith("#") && resolvedHref &&
      new URL(resolvedHref).origin === location.origin &&
      new URL(resolvedHref).pathname === location.pathname &&
      new URL(resolvedHref).search === location.search && !form;
    if (!hashOnly) {
      if (!proof || !proof.nonce || approvals.get(proof.nonce) !== el) {
        return { ok: false, reason: "approval_required_or_stale" };
      }
      approvals.delete(proof.nonce); // consume even when the action has changed
      if (!proof.descriptor || Object.keys(descriptor).some(k => descriptor[k] !== proof.descriptor[k])) {
        return { ok: false, reason: "approval_required_or_stale" };
      }
    }
    // Validated and activated within a single page JS turn. A native mouse
    // dispatch after returning coordinates would introduce a mutation window.
    el.click();
    return { ok: true, done: true };
  }

  if (${JSON.stringify(kind)} === "select") {
    const wanted = ${JSON.stringify(value)};
    if (!proof || proof.kind !== "select" || proof.value !== wanted ||
        approvals.get(proof.nonce) !== el) return { ok: false, reason: "approval_required_or_stale" };
    approvals.delete(proof.nonce);
    if (!proof.descriptor || Object.keys(descriptor).some(k =>
        JSON.stringify(descriptor[k]) !== JSON.stringify(proof.descriptor[k])))
      return { ok: false, reason: "approval_required_or_stale" };
    const hasOption = [...el.options].some((o) => o.value === wanted && !o.disabled);
    if (!hasOption) return { ok: false, reason: "option_missing" };
    el.value = wanted;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, done: true };
  }

  if (${JSON.stringify(kind)} === "fill") {
    const wanted = ${JSON.stringify(value)};
    if (!proof || proof.kind !== "fill" || proof.value !== wanted ||
        approvals.get(proof.nonce) !== el) return { ok: false, reason: "approval_required_or_stale" };
    approvals.delete(proof.nonce);
    if (!proof.descriptor || Object.keys(descriptor).some(k =>
        JSON.stringify(descriptor[k]) !== JSON.stringify(proof.descriptor[k])))
      return { ok: false, reason: "approval_required_or_stale" };
    // Resolve, validate and write in one page turn. Returning focus coordinates
    // for a later insertText allowed the page to redirect focus before typing.
    const proto = el.tagName === "TEXTAREA"
      ? (typeof HTMLTextAreaElement !== "undefined" && HTMLTextAreaElement.prototype)
      : (typeof HTMLInputElement !== "undefined" && HTMLInputElement.prototype);
    const setter = proto && Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, wanted);
    else el.value = wanted;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, done: true };
  }
  return { ok: false, reason: "unsupported_action" };
})()`;
}

/** Scroll the page (no element involved). */
function forgeScrollScript(direction) {
  const dy = direction === 'up' ? -Math.round(600) : Math.round(600);
  return `(() => { window.scrollBy({ top: ${dy}, behavior: "instant" }); return { ok: true, y: window.scrollY }; })()`;
}

module.exports = { forgeActionScript, forgeScrollScript, forgeEffectProofSource, forgeProofDigestSource };
