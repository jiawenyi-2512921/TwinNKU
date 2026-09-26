import type { ReactNode } from "react";

export function Icon({ name, size = 20 }: { name: string; size?: number }) {
  const paths: Record<string, ReactNode> = {
    check: (
      <>
        <rect x="3" y="3" width="18" height="18" rx="5" />
        <path d="m7 12 3 3 7-7" />
      </>
    ),
    shield: (
      <>
        <path d="m12 2 8 3v6c0 5-4 8-8 11-4-3-8-6-8-11V5l8-3Z" />
        <path d="m8 12 3 3 5-6" />
      </>
    ),
    edit: (
      <>
        <path d="m14 4 6 6M4 20l5-1L21 7a2 2 0 0 0-4-4L5 15l-1 5Z" />
      </>
    ),
    panorama: (
      <>
        <rect x="2" y="5" width="20" height="14" rx="4" />
        <path d="m3 16 5-5 4 4 4-7 6 8" />
        <circle cx="7" cy="9" r="1" />
      </>
    ),
    users: (
      <>
        <circle cx="9" cy="8" r="3" />
        <path d="M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6M18 15a4 4 0 0 1 3 4v2" />
      </>
    ),
    chat: (
      <>
        <path d="M20 11.5a8 8 0 0 1-8 8H5l-3 2v-8a9 9 0 1 1 18-2Z" />
        <path d="M7 10h8M7 14h5" />
      </>
    ),
    search: (
      <>
        <circle cx="10.5" cy="10.5" r="6.5" />
        <path d="m16 16 4.5 4.5" />
      </>
    ),
    refresh: (
      <path d="M20 7v5h-5M4 17v-5h5M5.2 7a8 8 0 0 1 13-1L20 9M4 15l1.8 3a8 8 0 0 0 13-1" />
    ),
    close: <path d="m6 6 12 12M18 6 6 18" />,
    bookmark: <path d="M6 21V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v17l-6-4-6 4Z" />,
    clock: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </>
    ),
    arrow: <path d="m9 5 7 7-7 7" />,
    pin: (
      <>
        <path d="M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 0 1 14 0Z" />
        <circle cx="12" cy="10" r="2.4" />
      </>
    ),
    building: (
      <>
        <path d="M4 21h16M6 21V4h12v17M10 21v-4h4v4M9 8h1m4 0h1M9 12h1m4 0h1" />
      </>
    ),
    leaf: (
      <>
        <path d="M20 3C7 1 2 10 7 16c5 5 14-1 13-13Z" />
        <path d="m4 21 11-12" />
      </>
    ),
    gate: (
      <>
        <path d="M3 20V9h4v11M17 20V9h4v11M2 5h20M5 5V3h14v2M7 11h10" />
      </>
    ),
    layers: (
      <>
        <path d="m12 3 10 6-10 6L2 9l10-6ZM2 13l10 6 10-6M2 17l10 6 10-6" />
      </>
    ),
    focus: (
      <>
        <path d="M8 3H3v5m13-5h5v5M3 16v5h5m8 0h5v-5" />
        <rect x="8" y="8" width="8" height="8" rx="1" />
      </>
    ),
    plus: <path d="M12 5v14M5 12h14" />,
    minus: <path d="M5 12h14" />,
    link: (
      <>
        <path d="m10 14 4-4M8 16l-1 1a3.5 3.5 0 0 1-5-5l5-5a3.5 3.5 0 0 1 5 0M16 8l1-1a3.5 3.5 0 0 1 5 5l-5 5a3.5 3.5 0 0 1-5 0" />
      </>
    ),
    help: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M9 9a3 3 0 1 1 4 3c-1 .4-1 1-1 2M12 17h.01" />
      </>
    ),
    list: (
      <>
        <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
      </>
    ),
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name] ?? paths.pin}
    </svg>
  );
}
