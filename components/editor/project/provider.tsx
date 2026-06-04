"use client"

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react"

import type { ProjectSummary } from "@/types/api"

type ProjectContextValue = {
  project: ProjectSummary | null
  isLoading: boolean
  error: string | null
  reload: () => Promise<void>
  openPicker: () => Promise<void>
}

const ProjectContext = createContext<ProjectContextValue | null>(null)

function projectPathFromUrl(): string | null {
  if (typeof window === "undefined") return null
  try {
    const value = new URL(window.location.href).searchParams.get("projectPath")
    return value && value.length > 0 ? value : null
  } catch {
    return null
  }
}

function pinProjectPathToUrl(projectPath: string): void {
  if (typeof window === "undefined" || !projectPath) return
  try {
    const url = new URL(window.location.href)
    if (url.searchParams.get("projectPath") === projectPath) return
    url.searchParams.set("projectPath", projectPath)
    window.history.replaceState(
      null,
      "",
      `${url.pathname}${url.search}${url.hash}`
    )
  } catch {
    // The app still works if the history update fails; the sticky active
    // project in main remains the fallback for refresh / restart.
  }
}

function editorWindowTitle(projectName: string | null | undefined): string {
  const name = projectName?.trim()
  return name ? `${name}-openscreen` : "openscreen"
}

export function ProjectProvider({ children }: { children: ReactNode }) {
  const [project, setProject] = useState<ProjectSummary | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const pinnedProjectPath = projectPathFromUrl()
      const next = pinnedProjectPath
        ? await window.api?.projects.open(pinnedProjectPath)
        : await window.api?.projects.getLatest()
      if (next) pinProjectPathToUrl(next.path)
      setProject(next ?? null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to load project")
    } finally {
      setIsLoading(false)
    }
  }, [])

  const openPicker = useCallback(async () => {
    try {
      const next = await window.api?.projects.pickAndOpen()
      if (next) {
        pinProjectPathToUrl(next.path)
        setProject(next)
        setError(null)
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to open project")
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  useEffect(() => {
    document.title = editorWindowTitle(project?.name)
  }, [project?.name])

  const value = useMemo<ProjectContextValue>(
    () => ({ project, isLoading, error, reload, openPicker }),
    [project, isLoading, error, reload, openPicker],
  )

  return <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>
}

export function useProject(): ProjectContextValue {
  const value = useContext(ProjectContext)
  if (!value) {
    throw new Error("useProject must be used within ProjectProvider.")
  }
  return value
}
