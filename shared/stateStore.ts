import fs from 'fs'
import path from 'path'

export function loadJsonState<T>(filePath: string, fallback: T): T {
  try {
    const raw = fs.readFileSync(filePath, 'utf8')
    return JSON.parse(raw) as T
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return fallback
    }

    console.error(`Failed to load state file at ${filePath}:`, error)
    return fallback
  }
}

export function saveJsonState(filePath: string, data: unknown) {
  const directory = path.dirname(filePath)
  fs.mkdirSync(directory, { recursive: true })

  const tempPath = `${filePath}.tmp`
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf8')
  fs.renameSync(tempPath, filePath)
}
