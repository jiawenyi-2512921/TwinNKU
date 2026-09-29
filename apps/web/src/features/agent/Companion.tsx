import type { Ref } from "react";
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
};

/** Original, decorative guide. The caller owns every action and real status. */
export function Companion({
  phase,
  label,
  onClick,
  disabled = false,
  expanded,
  controls,
  className = "",
  buttonRef,
}: Props) {
  return (
    <button
      ref={buttonRef}
      type="button"
      className={`guide-companion is-${phase} ${className}`.trim()}
      aria-label={label}
      aria-expanded={expanded}
      aria-controls={controls}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      <svg
        className="companion-figure"
        viewBox="0 0 88 106"
        width="80"
        height="96"
        aria-hidden="true"
        focusable="false"
      >
        <ellipse className="companion-shadow" cx="44" cy="99" rx="25" ry="4" />
        <g className="companion-body">
          <path
            className="companion-boot"
            d="M29 87h12v9H26q-2-6 3-9Zm18 0h12q5 3 3 9H47Z"
          />
          <path className="companion-sleeve" d="M26 61q-8 3-10 17l9 3 11-14Z" />
          <circle className="companion-skin" cx="20" cy="80" r="5" />
          <g className="companion-wave-hand">
            <path
              className="companion-sleeve"
              d="m58 60 12 5 4-14 7 2q0 20-9 23L55 69Z"
            />
            <path
              className="companion-skin"
              d="M74 53q-6-7-2-9 2-1 4 3l1-9q2-3 4 0l1 8q5 0 3 5l-3 5Z"
            />
          </g>
          <path
            className="companion-jacket"
            d="M31 57h26q8 6 9 29-20 9-44 0 1-23 9-29Z"
          />
          <path
            className="companion-collar"
            d="m32 58 12 10 12-10-4 16-8-6-8 6Z"
          />
          <path className="companion-seam" d="M44 69v18" />
          <rect
            className="companion-guide-card"
            x="25"
            y="71"
            width="13"
            height="15"
            rx="3"
            transform="rotate(-12 25 71)"
          />
          <path className="companion-card-lines" d="m29 75 5-1m-4 5 5-1" />
          <g className="companion-head">
            <path className="companion-antenna" d="M44 21v-8" />
            <circle className="companion-light" cx="44" cy="10" r="4" />
            <rect
              className="companion-ear"
              x="14"
              y="33"
              width="8"
              height="16"
              rx="4"
            />
            <rect
              className="companion-ear"
              x="66"
              y="33"
              width="8"
              height="16"
              rx="4"
            />
            <rect
              className="companion-shell"
              x="19"
              y="20"
              width="50"
              height="44"
              rx="18"
            />
            <rect
              className="companion-face"
              x="24"
              y="27"
              width="40"
              height="31"
              rx="13"
            />
            <path
              className="companion-hair"
              d="M30 26q11-11 27-2l-9 6-5-5-6 5Z"
            />
            <g className="companion-eyes">
              <ellipse
                cx="35"
                cy={phase === "thinking" ? 39 : 41}
                rx="2.8"
                ry="4"
              />
              <ellipse
                cx="53"
                cy={phase === "thinking" ? 39 : 41}
                rx="2.8"
                ry="4"
              />
            </g>
            <circle className="companion-cheek" cx="30" cy="48" r="3" />
            <circle className="companion-cheek" cx="58" cy="48" r="3" />
            {phase === "speaking" ? (
              <ellipse
                className="companion-mouth-open"
                cx="44"
                cy="50"
                rx="4"
                ry="3.5"
              />
            ) : (
              <path
                className="companion-mouth"
                d={phase === "error" ? "M40 51q4-4 8 0" : "M40 49q4 4 8 0"}
              />
            )}
          </g>
        </g>
        {phase === "listening" && (
          <g className="companion-signal" key="listening">
            <path d="M10 34q-4 7 0 14M6 30q-7 11 0 22" />
          </g>
        )}
        {phase === "speaking" && (
          <g className="companion-signal" key="speaking">
            <path d="M74 32q6 6 0 12M79 28q10 10 0 20" />
          </g>
        )}
        {phase === "thinking" && (
          <g className="companion-thought" key="thinking">
            <circle cx="61" cy="15" r="2" />
            <circle cx="68" cy="10" r="2.5" />
            <circle cx="77" cy="7" r="3" />
          </g>
        )}
        <g className="companion-state" transform="translate(67 86)">
          <circle className="companion-state-background" r="10" />
          {phase === "listening" || phase === "speaking" ? (
            <path
              className="companion-state-icon"
              d="M-5-2v4m3-7V5m3-9v8m3-6v4"
            />
          ) : phase === "acting" ? (
            <path
              className="companion-state-icon"
              d="m-5 2 4-5v4h6m-3-3 3 3-3 3"
            />
          ) : phase === "thinking" ? (
            <g className="companion-state-dots">
              <circle cx="-4" r="1.3" />
              <circle r="1.3" />
              <circle cx="4" r="1.3" />
            </g>
          ) : phase === "error" ? (
            <path className="companion-state-icon" d="M0-5v6m0 3v1" />
          ) : (
            <path className="companion-state-icon" d="M-5 0h10M0-5v10" />
          )}
        </g>
      </svg>
    </button>
  );
}
