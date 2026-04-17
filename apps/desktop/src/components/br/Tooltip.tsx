/**
 * Global tooltip portal — port of BR's components/tooltip.ts.
 *
 * A single element in document.body is moved + shown/hidden as the mouse
 * hovers [data-tooltip] elements anywhere in the tree. Using a portal
 * (rather than a CSS pseudo-element) sidesteps two failure modes:
 *   1. Ancestor overflow: hidden clipping the tooltip.
 *   2. Right-edge elements pushing the tooltip off-screen.
 *
 * Call `useGlobalTooltip()` once at app root. Any descendant with
 * data-tooltip="..." then gets a tooltip on hover/focus, no per-element
 * wiring. Clamp-to-viewport keeps it in-frame even near edges.
 */

import { useEffect } from "react";

const MARGIN = 8;
const OFFSET = 8;
const MAX_WIDTH = 280;

type TooltipState = {
  el: HTMLElement;
  activeTarget: Element | null;
};

let state: TooltipState | null = null;
let initialized = false;

function ensureTooltip(): TooltipState {
  if (state) return state;
  const el = document.createElement("div");
  el.className = "global-tooltip";
  el.setAttribute("role", "tooltip");
  el.setAttribute("aria-hidden", "true");
  document.body.appendChild(el);
  state = { el, activeTarget: null };
  return state;
}

function findAncestor(node: EventTarget | null): Element | null {
  if (!(node instanceof Element)) return null;
  return node.closest("[data-tooltip]");
}

function show(target: Element) {
  const s = ensureTooltip();
  const text = target.getAttribute("data-tooltip") ?? "";
  if (!text) {
    hide();
    return;
  }
  s.activeTarget = target;
  s.el.textContent = text;
  s.el.style.visibility = "hidden";
  s.el.style.opacity = "0";
  s.el.style.left = "0px";
  s.el.style.top = "0px";
  s.el.style.maxWidth = `${MAX_WIDTH}px`;
  s.el.setAttribute("aria-hidden", "false");

  requestAnimationFrame(() => {
    if (state?.activeTarget !== target) return;
    const targetRect = target.getBoundingClientRect();
    const tipRect = s.el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let top = targetRect.top - tipRect.height - OFFSET;
    let placement: "above" | "below" = "above";
    if (top < MARGIN) {
      top = targetRect.bottom + OFFSET;
      placement = "below";
    }
    if (top + tipRect.height > vh - MARGIN) {
      top = Math.max(MARGIN, vh - tipRect.height - MARGIN);
    }

    const targetCenter = targetRect.left + targetRect.width / 2;
    let left = targetCenter - tipRect.width / 2;
    if (left < MARGIN) left = MARGIN;
    if (left + tipRect.width > vw - MARGIN) {
      left = vw - tipRect.width - MARGIN;
    }

    s.el.style.left = `${Math.round(left)}px`;
    s.el.style.top = `${Math.round(top)}px`;
    s.el.setAttribute("data-placement", placement);
    s.el.style.visibility = "visible";
    s.el.style.opacity = "1";
  });
}

function hide() {
  if (!state) return;
  state.activeTarget = null;
  state.el.style.opacity = "0";
  state.el.setAttribute("aria-hidden", "true");
}

export function initGlobalTooltip(): () => void {
  if (initialized) return () => {};
  initialized = true;

  const onOver = (e: MouseEvent) => {
    const target = findAncestor(e.target);
    if (target && target !== state?.activeTarget) show(target);
  };
  const onOut = (e: MouseEvent) => {
    const target = findAncestor(e.target);
    if (!target) return;
    const related = findAncestor(e.relatedTarget);
    if (related === target) return;
    if (target === state?.activeTarget) hide();
  };
  const onFocusIn = (e: FocusEvent) => {
    const target = findAncestor(e.target);
    if (target) show(target);
  };
  const onFocusOut = (e: FocusEvent) => {
    const target = findAncestor(e.target);
    if (target === state?.activeTarget) hide();
  };
  const onScroll = () => {
    if (state?.activeTarget) hide();
  };

  document.addEventListener("mouseover", onOver);
  document.addEventListener("mouseout", onOut);
  document.addEventListener("focusin", onFocusIn);
  document.addEventListener("focusout", onFocusOut);
  window.addEventListener("scroll", onScroll, { passive: true, capture: true });

  return () => {
    document.removeEventListener("mouseover", onOver);
    document.removeEventListener("mouseout", onOut);
    document.removeEventListener("focusin", onFocusIn);
    document.removeEventListener("focusout", onFocusOut);
    window.removeEventListener("scroll", onScroll, {
      capture: true,
    } as EventListenerOptions);
    if (state) {
      state.el.remove();
      state = null;
    }
    initialized = false;
  };
}

/** Mount the portal once at app root. */
export function useGlobalTooltip() {
  useEffect(() => initGlobalTooltip(), []);
}
