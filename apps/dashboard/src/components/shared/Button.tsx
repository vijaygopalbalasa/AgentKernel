"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";

type ButtonVariant = "primary" | "ghost" | "danger";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  children: ReactNode;
}

const variantStyles: Record<ButtonVariant, string> = {
  primary:
    "bg-ctp-blue text-ctp-crust font-medium hover:bg-ctp-lavender active:bg-ctp-sapphire",
  ghost:
    "bg-ctp-surface0 text-ctp-subtext1 hover:bg-ctp-surface1 hover:text-ctp-text active:bg-ctp-surface2",
  danger:
    "bg-ctp-red/15 text-ctp-red hover:bg-ctp-red/25 active:bg-ctp-red/35",
};

export function Button({
  variant = "primary",
  children,
  className = "",
  disabled,
  ...props
}: ButtonProps) {
  return (
    <button
      className={`px-4 py-2 rounded-input text-sm transition-colors duration-150 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${variantStyles[variant]} ${className}`}
      disabled={disabled}
      {...props}
    >
      {children}
    </button>
  );
}
