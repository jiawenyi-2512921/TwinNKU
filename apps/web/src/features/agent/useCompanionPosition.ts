import { useEffect, useRef } from "react";
import type {
  ButtonHTMLAttributes,
  CSSProperties,
  PointerEvent as ReactPointerEvent,
} from "react";
import {
  companionBounds,
  companionSubtitleLayout,
  createCompanionDrag,
  keyboardCompanionPosition,
  normalizeCompanionPosition,
  readCompanionPosition,
  restoreCompanionPosition,
  saveCompanionPosition,
} from "./companionPosition";
import type { CompanionPointer } from "./companionPosition";

const initialStyle: CSSProperties = {
  position: "fixed",
  right: 16,
  bottom: 16,
};
type PointerLike = CompanionPointer & {
  stopPropagation: () => void;
  preventDefault: () => void;
};
type Runtime = {
  down: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  move: (event: PointerLike) => void;
  end: (event: PointerLike) => void;
  cancel: (event: PointerLike) => void;
  click: (detail: number) => boolean;
  key: (key: string, shift: boolean) => boolean;
  reset: () => void;
  subtitle: (element: HTMLDivElement | null) => void;
};

/** Attach the ref/style to the cluster and buttonProps only to its character button.
 * Pointer movement writes one transform per frame, never a React/map state update.
 */
export function useCompanionPosition() {
  const containerRef = useRef<HTMLDivElement>(null);
  const runtime = useRef<Runtime | null>(null);
  const subtitleElement = useRef<HTMLDivElement | null>(null);
  const subtitleRef = useRef((element: HTMLDivElement | null) => {
    subtitleElement.current = element;
    runtime.current?.subtitle(element);
  }).current;
  useEffect(() => {
    const element = containerRef.current;
    if (!element || typeof window === "undefined") return;
    let disposed = false;
    let frame: number | null = null;
    let captured: HTMLButtonElement | null = null;
    let fallback = false;
    let storage: Storage | null = null;
    try {
      storage = window.localStorage;
    } catch {
      /* Position is optional. */
    }
    const viewport = () => {
      const visual = window.visualViewport;
      return {
        width: visual?.width ?? window.innerWidth,
        height: visual?.height ?? window.innerHeight,
        offsetLeft: visual?.offsetLeft ?? 0,
        offsetTop: visual?.offsetTop ?? 0,
      };
    };
    let visible = viewport();
    let dimensions = element.getBoundingClientRect();
    let subtitle = subtitleElement.current;
    let subtitleDimensions = { width: 320, height: 48 };
    let observer: ResizeObserver | null = null;
    const measureSubtitle = () => {
      if (subtitle) subtitleDimensions = subtitle.getBoundingClientRect();
    };
    const measure = () => {
      visible = viewport();
      dimensions = element.getBoundingClientRect();
      measureSubtitle();
      return companionBounds(visible, dimensions);
    };
    measureSubtitle();
    let bounds = companionBounds(visible, dimensions);
    let normalized = readCompanionPosition(storage) ?? { x: 1, y: 1 };
    let position = restoreCompanionPosition(normalized, bounds);
    const gesture = createCompanionDrag();
    const paint = () => {
      frame = null;
      if (disposed) return;
      element.style.left = "0px";
      element.style.top = "0px";
      element.style.right = "auto";
      element.style.bottom = "auto";
      element.style.transform = `translate3d(${position.x}px, ${position.y}px, 0)`;
      if (subtitle) {
        const layout = companionSubtitleLayout(
          visible,
          position,
          dimensions,
          subtitleDimensions,
        );
        subtitle.style.left = `${layout.x}px`;
        subtitle.style.top = `${layout.y}px`;
        subtitle.style.width = `${layout.width}px`;
        subtitle.style.maxHeight = `${layout.maxHeight}px`;
        subtitle.style.bottom = "auto";
        subtitle.style.setProperty(
          "--native-caption-max-height",
          `${layout.maxHeight}px`,
        );
        subtitle.style.setProperty(
          "--native-caption-pointer",
          `${layout.pointer}px`,
        );
        subtitle.dataset.side = layout.side;
      }
    };
    const schedule = () => {
      if (frame === null) frame = window.requestAnimationFrame(paint);
    };
    const remember = () => {
      normalized = normalizeCompanionPosition(position, bounds);
      saveCompanionPosition(storage, normalized);
    };
    const move = (event: PointerLike) => {
      if (gesture.activePointerId !== event.pointerId) return;
      event.stopPropagation();
      const next = gesture.move(event, bounds);
      if (!next) return;
      event.preventDefault();
      position = next;
      element.dataset.dragging = "true";
      schedule();
    };
    const removeFallback = () => {
      if (!fallback) return;
      fallback = false;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", cancel);
    };
    const release = (pointerId: number) => {
      const target = captured;
      captured = null;
      removeFallback();
      try {
        if (target?.hasPointerCapture(pointerId))
          target.releasePointerCapture(pointerId);
      } catch {
        /* Capture may already be lost during a viewport change. */
      }
      delete element.dataset.dragging;
    };
    const finish = (event: PointerLike, cancelled: boolean) => {
      if (gesture.activePointerId !== event.pointerId) return;
      if (!cancelled) move(event);
      const result = gesture.end(event.pointerId);
      if (!result) return;
      event.stopPropagation();
      if (result.dragged) {
        event.preventDefault();
        remember();
      }
      release(result.pointerId);
    };
    function end(event: PointerLike) {
      finish(event, false);
    }
    function cancel(event: PointerLike) {
      finish(event, true);
    }
    const refresh = () => {
      const pending = gesture.cancel();
      if (pending) {
        if (pending.dragged) remember();
        release(pending.pointerId);
      }
      bounds = measure();
      position = restoreCompanionPosition(normalized, bounds);
      schedule();
    };
    runtime.current = {
      down(event) {
        if (!gesture.start(event, position)) return;
        event.stopPropagation();
        captured = event.currentTarget;
        try {
          captured.setPointerCapture(event.pointerId);
        } catch {
          fallback = true;
          window.addEventListener("pointermove", move);
          window.addEventListener("pointerup", end);
          window.addEventListener("pointercancel", cancel);
        }
      },
      move,
      end,
      cancel,
      click: (detail) => gesture.consumeClick(detail),
      key(key, shift) {
        if (gesture.activePointerId !== null) return false;
        const next = keyboardCompanionPosition(key, shift, position, bounds);
        if (!next) return false;
        position = next;
        remember();
        schedule();
        return true;
      },
      reset() {
        const pending = gesture.cancel();
        if (pending) release(pending.pointerId);
        normalized = { x: 1, y: 1 };
        bounds = measure();
        position = restoreCompanionPosition(normalized, bounds);
        saveCompanionPosition(storage, normalized);
        schedule();
      },
      subtitle(next) {
        if (subtitle === next) return;
        if (subtitle) observer?.unobserve(subtitle);
        subtitle = next;
        if (subtitle) {
          measureSubtitle();
          observer?.observe(subtitle);
          schedule();
        }
      },
    };
    paint();
    const visual = window.visualViewport;
    window.addEventListener("resize", refresh);
    window.addEventListener("orientationchange", refresh);
    visual?.addEventListener("resize", refresh);
    visual?.addEventListener("scroll", refresh);
    observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver((entries) => {
            if (entries.some((entry) => entry.target === element)) refresh();
            else {
              measureSubtitle();
              schedule();
            }
          });
    observer?.observe(element);
    if (subtitle) observer?.observe(subtitle);
    return () => {
      disposed = true;
      runtime.current = null;
      if (frame !== null) window.cancelAnimationFrame(frame);
      const pending = gesture.cancel();
      if (pending) release(pending.pointerId);
      removeFallback();
      window.removeEventListener("resize", refresh);
      window.removeEventListener("orientationchange", refresh);
      visual?.removeEventListener("resize", refresh);
      visual?.removeEventListener("scroll", refresh);
      observer?.disconnect();
    };
  }, []);
  const buttonProps: ButtonHTMLAttributes<HTMLButtonElement> = {
    onPointerDown: (event) => runtime.current?.down(event),
    onPointerMove: (event) => runtime.current?.move(event),
    onPointerUp: (event) => runtime.current?.end(event),
    onPointerCancel: (event) => runtime.current?.cancel(event),
    onLostPointerCapture: (event) => runtime.current?.cancel(event),
    onClickCapture: (event) => {
      if (runtime.current?.click(event.detail)) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
    onKeyDown: (event) => {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      if (runtime.current?.key(event.key, event.shiftKey)) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
    style: { touchAction: "none" },
  };
  return {
    containerRef,
    subtitleRef,
    style: initialStyle,
    buttonProps,
    resetPosition: () => runtime.current?.reset(),
  };
}
