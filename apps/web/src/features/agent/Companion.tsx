import {
  useEffect,
  useState,
  type ButtonHTMLAttributes,
  type Ref,
} from "react";
import poses from "./assets/xiaokai-poses.webp";
import "./companion.css";

export type CompanionPhase =
  | "idle"
  | "listening"
  | "thinking"
  | "speaking"
  | "acting"
  | "error";

type Props = {
  phase: CompanionPhase;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  expanded?: boolean;
  controls?: string;
  className?: string;
  buttonRef?: Ref<HTMLButtonElement>;
  buttonProps?: ButtonHTMLAttributes<HTMLButtonElement>;
  quiet?: boolean;
};

const cells: Record<CompanionPhase, [number, number]> = {
  idle: [0, 0],
  listening: [1, 0],
  thinking: [2, 0],
  speaking: [0, 1],
  acting: [1, 1],
  error: [2, 1],
};

/** The approved 2D character; poses reflect real controller state, never a model guess. */
export function Companion({
  phase,
  label,
  onClick,
  disabled = false,
  expanded,
  controls,
  className = "",
  buttonRef,
  buttonProps,
  quiet = false,
}: Props) {
  const [hidden, setHidden] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const update = () => setHidden(document.visibilityState === "hidden");
    update();
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  const [column, row] = cells[phase];
  return (
    <button
      {...buttonProps}
      ref={buttonRef}
      type="button"
      className={`guide-companion is-${phase}${hidden || quiet ? " is-quiet" : ""} ${className}`.trim()}
      aria-label={label}
      aria-expanded={expanded}
      aria-controls={controls}
      disabled={disabled}
      onClick={onClick}
    >
      <span className="companion-scene" aria-hidden="true">
        <span className="companion-ground" />
        <span className="companion-aura" />
        <span
          className="companion-character"
          style={{ marginTop: row === 0 ? "-6.83594%" : undefined }}
        >
          {failed ? (
            <svg
              className="companion-fallback"
              viewBox="0 0 80 80"
              focusable="false"
            >
              <path d="M40 63C8 53 14 19 35 17c2 13 5 22 5 22s3-9 5-22c21 2 27 36-5 46Z" />
              <path d="M40 39v32M26 33l14 17 14-17" />
            </svg>
          ) : (
            <img
              className="companion-atlas"
              src={poses}
              alt=""
              width="1536"
              height="1024"
              loading="lazy"
              decoding="async"
              fetchPriority="low"
              draggable={false}
              style={{ left: `${-column * 100}%`, top: `${-row * 100}%` }}
              onError={() => setFailed(true)}
            />
          )}
        </span>
        <svg className="companion-cues" viewBox="0 0 164 185" focusable="false">
          {phase === "listening" && (
            <g className="companion-listen-cue">
              <path d="M135 48q8 8 0 16M141 43q12 13 0 26" />
            </g>
          )}
          {phase === "thinking" && (
            <g className="companion-thought-cue">
              <circle cx="128" cy="43" r="2" />
              <circle cx="137" cy="37" r="2.5" />
              <circle cx="148" cy="33" r="3" />
            </g>
          )}
          {phase === "acting" && (
            <g className="companion-guide-cue">
              <path d="M135 68V48m-7 7 7-7 7 7" />
              <path d="M130 81c-8-1-7-10 2-10 2 5 1 8-2 10Z" />
            </g>
          )}
        </svg>
        {phase === "speaking" && (
          <span className="companion-speaking-cue">
            <i />
            <i />
            <i />
            <i />
          </span>
        )}
        <span className="companion-state-dot" />
      </span>
    </button>
  );
}
