"use client";

type TagVariant = "default" | "success" | "warning" | "danger" | "info";

interface TagProps {
  children: React.ReactNode;
  variant?: TagVariant;
  className?: string;
}

const variantStyles: Record<TagVariant, string> = {
  default:
    "bg-ctp-surface1 text-ctp-subtext1",
  success:
    "bg-ctp-green/15 text-ctp-green",
  warning:
    "bg-ctp-yellow/15 text-ctp-yellow",
  danger:
    "bg-ctp-red/15 text-ctp-red",
  info:
    "bg-ctp-blue/15 text-ctp-blue",
};

export function Tag({ children, variant = "default", className = "" }: TagProps) {
  return (
    <span
      className={`inline-flex items-center px-2.5 py-0.5 text-xs font-mono font-medium rounded-pill ${variantStyles[variant]} ${className}`}
    >
      {children}
    </span>
  );
}
