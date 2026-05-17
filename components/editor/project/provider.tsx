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

export function ProjectProvider({ children }: { children: ReactNode }) {
  const [project, setProject] = useState<ProjectSummary | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const latest = await window.api?.projects.getLatest()
      setProject(latest ?? null)
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
