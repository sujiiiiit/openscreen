import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

// Crash-safe write: render the JSON next to its target, then `rename` it on
// top. POSIX `rename` is atomic on the same filesystem, so even an unplugged
// laptop will see either the previous good file or the new one — never a
// half-flushed file. Any failure path unlinks the tmp so we don't accumulate
// orphan `.tmp` files on a disk that's full or read-only.
export async function writeJsonAtomic(
  target: string,
  payload: unknown
): Promise<void> {
  const dir = path.dirname(target)
  await fs.mkdir(dir, { recursive: true })
  const tmpName = `.${path.basename(target)}.${process.pid}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}.tmp`
  const tmp = path.join(dir, tmpName)
  const serialized = JSON.stringify(payload, null, 2) + os.EOL
  try {
    await fs.writeFile(tmp, serialized, "utf8")
    await fs.rename(tmp, target)
  } catch (error) {
    try {
      await fs.unlink(tmp)
    } catch {
      // best-effort cleanup — tmp may not exist if writeFile threw before
      // the file descriptor was created.
    }
    throw error
  }
}
