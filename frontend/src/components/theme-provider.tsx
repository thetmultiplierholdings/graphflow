"use client"

import * as React from "react"

type Theme = "light" | "dark" | "system"

interface ThemeContextValue {
  theme: Theme
  setTheme: (theme: Theme) => void
  resolvedTheme: "light" | "dark"
}

const ThemeContext = React.createContext<ThemeContextValue>({
  theme: "system",
  setTheme: () => {},
  resolvedTheme: "light",
})

export function ThemeProvider({
  children,
  defaultTheme = "system",
  attribute = "class",
  enableSystem = true,
  disableTransitionOnChange = false,
}: {
  children: React.ReactNode
  defaultTheme?: Theme
  attribute?: string
  enableSystem?: boolean
  disableTransitionOnChange?: boolean
}) {
  const [theme, setThemeState] = React.useState<Theme>(defaultTheme)
  const [resolvedTheme, setResolvedTheme] = React.useState<"light" | "dark">("light")

  React.useEffect(() => {
    const stored = localStorage.getItem("theme") as Theme | null
    if (stored) setThemeState(stored)
  }, [])

  React.useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)")

    const resolve = () => {
      const resolved =
        theme === "system"
          ? mediaQuery.matches ? "dark" : "light"
          : theme
      setResolvedTheme(resolved)

      if (disableTransitionOnChange) {
        document.documentElement.style.transition = "none"
        requestAnimationFrame(() => {
          document.documentElement.style.transition = ""
        })
      }

      if (attribute === "class") {
        document.documentElement.classList.toggle("dark", resolved === "dark")
      } else {
        document.documentElement.setAttribute(attribute, resolved)
      }
    }

    resolve()
    if (enableSystem) mediaQuery.addEventListener("change", resolve)
    return () => mediaQuery.removeEventListener("change", resolve)
  }, [theme, attribute, enableSystem, disableTransitionOnChange])

  const setTheme = React.useCallback((next: Theme) => {
    setThemeState(next)
    localStorage.setItem("theme", next)
  }, [])

  return (
    <ThemeContext.Provider value={{ theme, setTheme, resolvedTheme }}>
      {children}
    </ThemeContext.Provider>
  )
}

export function useTheme() {
  return React.useContext(ThemeContext)
}
