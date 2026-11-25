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

export function DashboardIcon({ size = 15 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2" y="2" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.4" />
      <rect x="9" y="2" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.4" />
      <rect x="2" y="9" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.4" />
      <rect x="9" y="9" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

export function EditIcon({ size = 15 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M11.2 2.4l2.4 2.4-7.8 7.8-3.1.7.7-3.1 7.8-7.8z"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinejoin="round"
      />
      <path d="M9.6 4l2.4 2.4" stroke="currentColor" strokeWidth="1.35" />
    </svg>
  );
}

export function TrashIcon({ size = 15 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2.5 4.25h11" stroke="currentColor" strokeWidth="1.4" strokeLinecap="square" />
      <path d="M6 4.25V2.75h4v1.5" stroke="currentColor" strokeWidth="1.35" />
      <path d="M4.25 4.25l.6 9h6.3l.6-9" stroke="currentColor" strokeWidth="1.35" strokeLinejoin="round" />
      <path d="M6.75 7v4M9.25 7v4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="square" />
    </svg>
  );
}

export function ArrowRightIcon({ size = 15 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M3 8h9.5M8.75 4.25L12.5 8l-3.75 3.75" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" />
    </svg>
  );
}

export function ChevronLeftIcon({ size = 15 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M10 3.5L5.5 8 10 12.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="square" />
    </svg>
  );
}

export function ChevronRightIcon({ size = 15 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M6 3.5L10.5 8 6 12.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="square" />
    </svg>
  );
}

export function SparklesIcon({ size = 15 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M8 1.75l1.45 4.05L13.5 7.25l-4.05 1.45L8 12.75l-1.45-4.05L2.5 7.25l4.05-1.45L8 1.75z"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function RefreshIcon({ size = 15 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M13 8a5 5 0 11-1.3-3.35" stroke="currentColor" strokeWidth="1.45" strokeLinecap="square" />
      <path d="M13 2.5v2.75h-2.75" stroke="currentColor" strokeWidth="1.45" strokeLinecap="square" />
    </svg>
  );
}

export function UploadIcon({ size = 15 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M8 10.75v-7.5M5 6.25l3-3 3 3" stroke="currentColor" strokeWidth="1.45" strokeLinecap="square" />
      <path d="M2.5 11.25v2h11v-2" stroke="currentColor" strokeWidth="1.45" strokeLinecap="square" />
    </svg>
  );
}

export function GridIcon({ size = 15 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2" y="2.25" width="5" height="4.5" rx="1" stroke="currentColor" strokeWidth="1.35" />
      <rect x="9" y="2.25" width="5" height="4.5" rx="1" stroke="currentColor" strokeWidth="1.35" />
      <rect x="2" y="9.25" width="5" height="4.5" rx="1" stroke="currentColor" strokeWidth="1.35" />
      <rect x="9" y="9.25" width="5" height="4.5" rx="1" stroke="currentColor" strokeWidth="1.35" />
    </svg>
  );
}

export function FilmIcon({ size = 15 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.4" stroke="currentColor" strokeWidth="1.35" />
      <path d="M4.5 2.75v10.5M11.5 2.75v10.5M1.75 6h2.75M1.75 10h2.75M11.5 6h2.75M11.5 10h2.75" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

export function PlayIcon({ size = 15 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M4.5 3.25L12.75 8L4.5 12.75V3.25Z" fill="currentColor" />
    </svg>
  );
}

export function CopyIcon({ size = 15 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="5.25" y="5.25" width="8.25" height="8.25" rx="1.2" stroke="currentColor" strokeWidth="1.35" />
      <path d="M10.75 5.25V3.5a1 1 0 00-1-1h-6.25a1 1 0 00-1 1v6.25a1 1 0 001 1h1.75" stroke="currentColor" strokeWidth="1.35" />
    </svg>
  );
}

export function DownloadIcon({ size = 15 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M8 2.5v7.5M5 7l3 3 3-3" stroke="currentColor" strokeWidth="1.45" strokeLinecap="square" />
      <path d="M2.5 11.75v1.75h11v-1.75" stroke="currentColor" strokeWidth="1.45" strokeLinecap="square" />
    </svg>
  );
}

export function ExternalLinkIcon({ size = 15 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M9.5 2.5h4v4M13.25 2.75L7.5 8.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="square" />
      <path d="M12.5 9.25v3.25a1 1 0 01-1 1h-8a1 1 0 01-1-1v-8a1 1 0 011-1h3.25" stroke="currentColor" strokeWidth="1.35" />
    </svg>
  );
}
