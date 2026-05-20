import type { ButtonHTMLAttributes, ReactNode } from "react";

import { cn } from "@/lib/utils";

type ButtonVariant = "primary" | "secondary" | "ghost";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  full?: boolean;
  leftIcon?: ReactNode;
  variant?: ButtonVariant;
};

export function Button({
  children,
  className,
  full = false,
  leftIcon,
  type = "button",
  variant = "secondary",
  ...props
}: ButtonProps) {
  return (
    <button
      className={cn("button", `button-${variant}`, full && "button-full", className)}
      type={type}
      {...props}
    >
      {leftIcon}
      {children}
    </button>
  );
}
