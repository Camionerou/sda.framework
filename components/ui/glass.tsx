import type { ElementType, ReactNode } from "react";

import { cn } from "@/lib/utils";

type GlassVariant = "default" | "soft" | "strong";

type GlassProps<T extends ElementType> = {
  as?: T;
  variant?: GlassVariant;
  className?: string;
  children?: ReactNode;
} & Omit<React.ComponentPropsWithoutRef<T>, "as" | "className" | "children">;

const variantClass: Record<GlassVariant, string> = {
  default: "glass",
  soft: "glass-soft",
  strong: "glass-strong"
};

/**
 * Liquid-glass surface primitive for the workspace.
 * Relies on the `.glass*` classes defined in `app/workspace.css`
 * (scoped under `.ws`), so it only renders correctly inside the workspace shell.
 */
export function Glass<T extends ElementType = "div">({
  as,
  variant = "default",
  className,
  children,
  ...rest
}: GlassProps<T>) {
  const Component = (as ?? "div") as ElementType;

  return (
    <Component className={cn(variantClass[variant], className)} {...rest}>
      {children}
    </Component>
  );
}
