"use client"

import { useEffect, useState, useSyncExternalStore } from "react"
import { usePathname } from "next/navigation"
import { useTheme } from "@/components/theme-provider"
import { cn } from "@/lib/utils"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { TooltipProvider } from "@/components/ui/tooltip"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import {
  Briefcase,
  ChevronLeft,
  ChevronRight,
  Inbox,
  Moon,
  Sun,
  Workflow,
} from "lucide-react"
import { NavLink } from "./nav-link"
import { useHumanTaskStore, openTasks } from "@/lib/stores/human-task-store"

interface SidebarProps {
  forceCollapsed?: boolean
}

const subscribeNoop = () => () => {}

export function Sidebar({ forceCollapsed = false }: SidebarProps) {
  const [isCollapsed, setIsCollapsed] = useState(forceCollapsed)
  const [prevForced, setPrevForced] = useState(forceCollapsed)
  const { resolvedTheme, setTheme } = useTheme()
  // Hydration-safe mounted flag: false on the server render, true on the client.
  const mounted = useSyncExternalStore(subscribeNoop, () => true, () => false)
  const pathname = usePathname()

  const tasks = useHumanTaskStore((s) => s.tasks)
  const refreshTasks = useHumanTaskStore((s) => s.refreshTasks)
  const openCount = openTasks(tasks).length

  // The badge is Temporal visibility, polled (~5s) like the real system.
  useEffect(() => {
    const refresh = () => {
      void refreshTasks().catch(() => {})
    }
    refresh()
    const timer = setInterval(refresh, 5000)
    return () => clearInterval(timer)
  }, [refreshTasks])

  if (prevForced !== forceCollapsed) {
    setPrevForced(forceCollapsed)
    setIsCollapsed(forceCollapsed)
  }

  const collapsed = isCollapsed

  const navItems = [
    {
      title: "Engagements",
      href: "/engagements",
      icon: Briefcase,
      isActive: pathname === "/engagements" || pathname.startsWith("/engagements/") || pathname.startsWith("/workspaces/"),
    },
    {
      title: "Inbox",
      href: "/inbox",
      icon: Inbox,
      isActive: pathname === "/inbox" || pathname.startsWith("/inbox/"),
      badge: openCount,
    },
    {
      title: "Workflow Catalogue",
      href: "/catalog",
      icon: Workflow,
      isActive: pathname === "/catalog" || pathname.startsWith("/catalog/"),
    },
  ]

  return (
    <TooltipProvider delayDuration={0}>
      <aside
        className={cn(
          "flex h-full flex-col bg-sidebar rounded-xl transition-all duration-300 relative",
          collapsed ? "w-20" : "w-60"
        )}
      >
        {/* Logo */}
        <div className={cn("flex h-16 items-center mt-2 px-4 relative", collapsed ? "justify-center" : "justify-start px-7")}>
          {collapsed ? (
            <h1 className="text-2xl font-heading font-semibold text-foreground">D</h1>
          ) : (
            <h1 className="text-2xl font-heading font-semibold text-foreground">Graphflow</h1>
          )}
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setIsCollapsed(!isCollapsed)}
            className="absolute -right-3 top-[calc(50%+32px)] -translate-y-1/2 z-50 h-6 w-6 rounded-full border border-border bg-background shadow-md hover:bg-background"
          >
            {collapsed ? <ChevronRight className="size-4" /> : <ChevronLeft className="size-4" />}
          </Button>
        </div>

        {!collapsed && (
          <p className="px-7 mb-4 text-xs text-muted-foreground">
            Memoised workflows for professional-service firms
          </p>
        )}

        {/* Navigation */}
        <nav className="flex-1 p-4 overflow-y-auto scrollbar-none">
          <div className="space-y-1">
            {navItems.map((item) => (
              <NavLink
                key={item.href}
                href={item.href}
                title={item.title}
                icon={item.icon}
                isActive={item.isActive}
                collapsed={collapsed}
                badge={item.badge}
              />
            ))}
          </div>
        </nav>

        <div className="mx-4 border-t" />

        {/* User Profile */}
        <div className="p-4 pb-6">
          <Popover>
            <PopoverTrigger asChild>
              {collapsed ? (
                <Button variant="ghost" className="w-full p-0 h-auto hover:bg-sidebar-accent">
                  <div className="flex items-center justify-center p-2">
                    <Avatar className="size-10">
                      <AvatarFallback>T</AvatarFallback>
                    </Avatar>
                  </div>
                </Button>
              ) : (
                <Button variant="ghost" className="w-full justify-start p-0 h-auto hover:bg-sidebar-accent">
                  <div className="flex items-center gap-3 p-2 w-full">
                    <Avatar className="size-10">
                      <AvatarFallback>T</AvatarFallback>
                    </Avatar>
                    <div className="flex flex-col overflow-hidden text-left">
                      <span className="text-sm font-medium truncate">Thet</span>
                      <span className="text-xs text-muted-foreground truncate">thet@multiplierholdings.com</span>
                    </div>
                  </div>
                </Button>
              )}
            </PopoverTrigger>
            <PopoverContent className="w-64 p-3" side="right" align="end">
              <div className="py-1">
                <div className="flex items-center justify-between px-3 py-2 hover:bg-sidebar-accent rounded-md cursor-pointer">
                  <div className="flex items-center gap-3">
                    {mounted && resolvedTheme === "dark" ? <Moon className="size-4" /> : <Sun className="size-4" />}
                    <Label htmlFor="sidebar-dark-mode" className="text-sm cursor-pointer font-normal">Dark Mode</Label>
                  </div>
                  <Switch
                    id="sidebar-dark-mode"
                    checked={mounted && resolvedTheme === "dark"}
                    onCheckedChange={(checked) => setTheme(checked ? "dark" : "light")}
                  />
                </div>
              </div>
            </PopoverContent>
          </Popover>
        </div>
      </aside>
    </TooltipProvider>
  )
}
