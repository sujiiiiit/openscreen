export const WALLPAPER_IDS = [
  "ipad-17-dark",
  "ipad-17-light",
  "sequoia-blue-orange",
  "sequoia-blue",
  "sonoma-clouds",
  "sonoma-dark",
  "sonoma-evening",
  "sonoma-from-above",
  "sonoma-horizon",
  "sonoma-light",
  "sonoma-river",
  "tahoe-dark",
  "tahoe-light",
  "ventura-dark",
  "ventura-semi-dark",
  "ventura",
] as const

export type WallpaperId = (typeof WALLPAPER_IDS)[number]

export function isWallpaperId(value: string): value is WallpaperId {
  return (WALLPAPER_IDS as readonly string[]).includes(value)
}

export function getWallpaperThumbUrl(id: WallpaperId): string {
  return `/assets/placeholder/${id}.jpg`
}

export function getWallpaperFullUrl(id: WallpaperId): string {
  return `/assets/backgrounds/${id}.jpg`
}
