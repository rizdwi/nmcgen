import React from "react";
import type { NodeKind } from "@/lib/types";

interface IconProps {
  size?: number;
}

export function NodeKindIcon({ kind, size = 15 }: { kind: NodeKind; size?: number }) {
  switch (kind) {
    case "script":
      return (
        <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <rect x="2.5" y="1.75" width="11" height="12.5" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
          <path d="M5 5.25h6M5 8h6M5 10.75h4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="square" />
        </svg>
      );
    case "asset":
      return (
        <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <rect x="2" y="2.5" width="12" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
          <circle cx="5.75" cy="6.25" r="1.35" stroke="currentColor" strokeWidth="1.3" />
          <path d="M2.5 11.5l3.2-3 2.5 2.2 2.2-2 3.1 2.8" stroke="currentColor" strokeWidth="1.3" />
        </svg>
      );
    case "segment":
      return (
        <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <rect x="1.75" y="3" width="12.5" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
          <path d="M6.5 5.75l4 2.25-4 2.25V5.75z" fill="currentColor" />
        </svg>
      );
    case "audio":
      return (
        <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M2.5 9.5v-3M5.25 12V4M8 13.5v-11M10.75 11V5M13.5 9.5v-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      );
    case "assembly":
      return (
        <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <rect x="1.75" y="2.5" width="5.5" height="3.25" rx="0.8" stroke="currentColor" strokeWidth="1.3" />
          <rect x="8.75" y="2.5" width="5.5" height="3.25" rx="0.8" stroke="currentColor" strokeWidth="1.3" />
          <rect x="3.5" y="7.25" width="9" height="2.75" rx="0.8" stroke="currentColor" strokeWidth="1.3" />
          <path d="M2 12.75h12" stroke="currentColor" strokeWidth="1.4" />
        </svg>
      );
    case "export":
      return (
        <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M8 2.25v7.5M5 6.75l3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" />
          <path d="M2.5 11.5v1.75h11V11.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" />
        </svg>
      );
  }
}

export function PlusIcon({ size = 15 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="square" />
    </svg>
  );
}

export function CheckIcon({ size = 15 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M3 8.5l3.2 3.2L13 4.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="square" />
    </svg>
  );
}

export function SlidersIcon({ size = 15 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="5.5" cy="4.5" r="1.7" fill="#15181e" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="10.5" cy="8" r="1.7" fill="#15181e" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="7" cy="11.5" r="1.7" fill="#15181e" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

export function CloseIcon({ size = 15 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="square" />
    </svg>
  );
}

export function LayoutIcon({ size = 15 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2" y="2.5" width="4" height="11" rx="1" stroke="currentColor" strokeWidth="1.35" />
      <rect x="8" y="2.5" width="6" height="4.5" rx="1" stroke="currentColor" strokeWidth="1.35" />
      <rect x="8" y="9" width="6" height="4.5" rx="1" stroke="currentColor" strokeWidth="1.35" />
    </svg>
  );
}
