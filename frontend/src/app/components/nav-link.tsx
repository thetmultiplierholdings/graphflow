"use client"

import Link from "next/link"
import { cn } from "@/lib/utils"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

export interface NavLinkProps {
  href: string
  title: string
  icon: React.ComponentType<{ className?: string }>
  isActive: boolean
  collapsed?: boolean
  badge?: number
  variant?: "main" | "admin"
}

export function NavLink({
  href,
  title,
  icon: Icon,
  isActive,
  collapsed = false,
  badge,
}: NavLinkProps) {
  const baseStyles = "flex items-center rounded-lg text-sm font-body font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring"
  const activeStyles = isActive
    ? "bg-sidebar-accent text-sidebar-accent-foreground"
    : "text-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"

  if (collapsed) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Link
            href={href}
            className={cn(baseStyles, "justify-center px-2 py-1.5 relative", activeStyles)}
          >
            <Icon className="size-5" />
            {badge && badge > 0 && (
              <span className="absolute -top-1 -right-1 flex items-center justify-center min-w-[18px] h-[18px] px-1 text-[10px] font-semibold rounded-full bg-destructive text-destructive-foreground">
                {badge > 99 ? '99+' : badge}
              </span>
            )}
          </Link>
        </TooltipTrigger>
        <TooltipContent side="right">
          <p>{title}</p>
          {badge && badge > 0 && (
            <p className="text-xs text-muted-foreground">{badge} unread</p>
          )}
        </TooltipContent>
      </Tooltip>
    )
  }

  return (
    <Link
      href={href}
      className={cn(baseStyles, "gap-3 px-3 py-1.5 justify-between", activeStyles)}
    >
      <div className="flex items-center gap-3">
        <Icon className="size-5" />
        <span className="font-body font-medium">{title}</span>
      </div>
      {badge && badge > 0 && (
        <span className="flex items-center justify-center size-5 text-[11px] font-semibold rounded-full bg-destructive text-destructive-foreground">
          {badge > 99 ? '99+' : badge}
        </span>
      )}
    </Link>
  )
}
