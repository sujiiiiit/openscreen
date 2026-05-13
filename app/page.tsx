'use client'

import { useState } from 'react'

export default function Page() {
  const [result, setResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function ping() {
    setError(null)
    try {
      if (!window.api?.recorder?.getState) {
        throw new Error('window.api.recorder is not available — preload not loaded?')
      }
      const state = await window.api.recorder.getState()
      setResult(`recorder status: ${state.status}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-8">
      <h1 className="text-2xl font-semibold">openscreen</h1>
      <button
        onClick={ping}
        className="rounded border px-4 py-2 hover:bg-neutral-100 dark:hover:bg-neutral-900"
      >
        Ping recorder bridge
      </button>
      {result && <pre className="text-sm">{result}</pre>}
      {error && <pre className="text-sm text-red-500">{error}</pre>}
    </main>
  )
}
