import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const statusBadgeVariants = cva(
  "inline-flex items-center justify-center border px-2 py-0.5 text-xs font-body font-medium w-fit whitespace-nowrap shrink-0 [&>svg]:size-3 gap-1 [&>svg]:pointer-events-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive transition-[color,box-shadow] overflow-hidden",
  {
    variants: {
      color: {
        neutral: "",
        primary: "",
        warning: "",
        success: "",
        destructive: "",
        info: "",
      },
      variant: {
        solid: "",
        muted: "",
        outline: "",
      },
      rounded: {
        md: "rounded-md",
        full: "rounded-full",
      },
    },
    compoundVariants: [
      // Solid variants
      {
        color: "neutral",
        variant: "solid",
        class: "border-transparent bg-neutral text-neutral-foreground",
      },
      {
        color: "primary",
        variant: "solid",
        class: "border-transparent bg-primary text-primary-foreground",
      },
      {
        color: "warning",
        variant: "solid",
        class: "border-transparent bg-warning text-warning-foreground",
      },
      {
        color: "success",
        variant: "solid",
        class: "border-transparent bg-success text-success-foreground",
      },
      {
        color: "destructive",
        variant: "solid",
        class: "border-transparent bg-destructive text-destructive-foreground",
      },
      {
        color: "info",
        variant: "solid",
        class: "border-transparent bg-info text-info-foreground",
      },
      // Muted variants
      {
        color: "neutral",
        variant: "muted",
        class: "border-transparent bg-neutral-muted text-neutral-strong",
      },
      {
        color: "primary",
        variant: "muted",
        class: "border-transparent bg-primary-muted text-primary-strong",
      },
      {
        color: "warning",
        variant: "muted",
        class: "border-transparent bg-warning-muted text-warning-strong",
      },
      {
        color: "success",
        variant: "muted",
        class: "border-transparent bg-success-muted text-success-strong",
      },
      {
        color: "destructive",
        variant: "muted",
        class: "border-transparent bg-destructive-muted text-destructive-strong",
      },
      {
        color: "info",
        variant: "muted",
        class: "border-transparent bg-info-muted text-info-strong",
      },
      // Outline variants
      {
        color: "neutral",
        variant: "outline",
        class: "border-neutral/30 bg-neutral-muted text-neutral-strong",
      },
      {
        color: "primary",
        variant: "outline",
        class: "border-primary/30 bg-primary-muted text-primary-strong",
      },
      {
        color: "warning",
        variant: "outline",
        class: "border-warning/30 bg-warning-muted text-warning-strong",
      },
      {
        color: "success",
        variant: "outline",
        class: "border-success/30 bg-success-muted text-success-strong",
      },
      {
        color: "destructive",
        variant: "outline",
        class: "border-destructive/30 bg-destructive-muted text-destructive-strong",
      },
      {
        color: "info",
        variant: "outline",
        class: "border-info/30 bg-info-muted text-info-strong",
      },
    ],
    defaultVariants: {
      color: "neutral",
      variant: "solid",
      rounded: "md",
    },
  }
)

function StatusBadge({
  className,
  color,
  variant,
  rounded,
  asChild = false,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof statusBadgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : "span"

  return (
    <Comp
      data-slot="status-badge"
      className={cn(statusBadgeVariants({ color, variant, rounded }), className)}
      {...props}
    />
  )
}

export { StatusBadge, statusBadgeVariants }
