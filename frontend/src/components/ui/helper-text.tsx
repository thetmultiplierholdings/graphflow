"use client"

import { cn } from "@/lib/utils"
import {
  Info,
  CircleCheck,
  AlertTriangle,
  CircleAlert,
  CircleDot,
  Sparkles,
  type LucideIcon,
} from "lucide-react"

type HelperTextVariant = "default" | "info" | "success" | "warning" | "error"

interface HelperTextProps {
  children: React.ReactNode
  variant?: HelperTextVariant
  icon?: LucideIcon
  hideIcon?: boolean
  className?: string
}

const variantConfig: Record<
  HelperTextVariant,
  { icon: LucideIcon; iconClass: string; textClass: string }
> = {
  default: {
    icon: CircleDot,
    iconClass: "text-muted-foreground",
    textClass: "text-muted-foreground",
  },
  info: {
    icon: Info,
    iconClass: "text-info",
    textClass: "text-info-strong",
  },
  success: {
    icon: CircleCheck,
    iconClass: "text-success",
    textClass: "text-success-strong",
  },
  warning: {
    icon: AlertTriangle,
    iconClass: "text-warning",
    textClass: "text-warning-strong",
  },
  error: {
    icon: CircleAlert,
    iconClass: "text-destructive",
    textClass: "text-destructive-strong",
  },
}

export function HelperText({
  children,
  variant = "default",
  icon,
  hideIcon = false,
  className,
}: HelperTextProps) {
  const config = variantConfig[variant]
  const Icon = icon || config.icon

  return (
    <div className={cn("flex items-start gap-1.5 text-sm", className)}>
      {!hideIcon && (
        <Icon className={cn("size-4 shrink-0 mt-0.5", config.iconClass)} />
      )}
      <span className={config.textClass}>{children}</span>
    </div>
  )
}

export { type HelperTextVariant }
