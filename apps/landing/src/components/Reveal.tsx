"use client";

import { useEffect, useRef, type CSSProperties, type ElementType, type ReactNode, type RefObject } from "react";

type InViewOptions = {
  /** Attribute written on the element, e.g. "data-visible" or "data-motion". */
  attr: string;
  /** Value while waiting to enter the viewport (the hidden / undrawn state). */
  idle: string;
  /** Value once the element has entered the viewport. */
  active: string;
  /** Leave elements that are already on screen at mount untouched (no flash on load). */
  skipIfInView?: boolean;
  threshold?: number;
  rootMargin?: string;
};

/**
 * Progressive enhancement: the server markup is always the finished, visible state.
 * Only after mount (JS running, motion allowed) do we switch to the idle state and
 * wait for the element to scroll in. Unobserves after the first reveal.
 */
export function useInViewOnce(ref: RefObject<Element | null>, opts: InViewOptions) {
  const { attr, idle, active, skipIfInView = false, threshold = 0.15, rootMargin = "0px 0px -8% 0px" } = opts;

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    if (skipIfInView) {
      const r = el.getBoundingClientRect();
      if (r.top < window.innerHeight && r.bottom > 0) return;
    }

    el.setAttribute(attr, idle);
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          el.setAttribute(attr, active);
          io.disconnect();
        }
      },
      { threshold, rootMargin },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [ref, attr, idle, active, skipIfInView, threshold, rootMargin]);
}

type RevealProps = {
  as?: ElementType;
  /** Stagger in milliseconds, passed to CSS as --reveal-delay. */
  delay?: number;
  className?: string;
  children: ReactNode;
  id?: string;
};

export function Reveal({ as: Tag = "div", delay = 0, className = "", children, id }: RevealProps) {
  const ref = useRef<HTMLElement>(null);
  useInViewOnce(ref, { attr: "data-visible", idle: "false", active: "true", skipIfInView: true });

  const style = delay ? ({ "--reveal-delay": `${delay}ms` } as CSSProperties) : undefined;

  return (
    <Tag ref={ref} id={id} className={`reveal ${className}`.trim()} style={style}>
      {children}
    </Tag>
  );
}
