const videoExtension = /\.(mkv|mp4|m4v|mov|hevc|h265|ts|m2ts)$/i

/** Last segment of a path, split on both `/` and `\`. */
export function baseName(value: string): string {
  return value.split(/[\\/]/).filter(Boolean).pop() || value
}

/** Everything before the last segment, for the muted path line. */
export function dirName(value: string): string {
  const parts = value.split(/[\\/]/).filter(Boolean)
  parts.pop()
  const sep = value.includes('\\') ? '\\' : '/'
  const prefix = value.startsWith('/') ? '/' : ''
  return prefix + parts.join(sep)
}

/** File/folder name without a trailing video extension, for display only. */
export function displayLabel(value: string): string {
  return baseName(value).replace(videoExtension, '')
}

/** Windows drive (`C:\`), UNC (`\\server`) or POSIX (`/`) absolute path. */
export function isAbsolutePath(value: string): boolean {
  return (
    /^[a-zA-Z]:[\\/]/.test(value) ||
    value.startsWith('/') ||
    value.startsWith('\\\\')
  )
}

export function hasPathSeparator(value: string): boolean {
  return /[\\/]/.test(value)
}

export type DropSlot = 'hdr' | 'hdr10plus' | 'dv' | 'output'

/**
 * Classify a dropped file/folder by its name using whole-token matching, so
 * "Movie.2019.DV.mkv" is Dolby Vision but "Advent.mkv" is not.
 */
export function classifyDropName(name: string): DropSlot | null {
  const label = baseName(name)
  const tokens = label.split(/[ .\-_[\]()+]+/).filter(Boolean)
  if (
    label.toLowerCase().includes('hdr10+') ||
    tokens.some(t => /^hdr10(\+|p|plus)$/i.test(t))
  ) {
    return 'hdr10plus'
  }
  if (tokens.some(t => /^(dv|dovi|dolby|dolbyvision)$/i.test(t))) return 'dv'
  if (tokens.some(t => /^(hdr|hdr10)$/i.test(t))) return 'hdr'
  return null
}

/**
 * Output file name the backend derives for a pair (mirrors
 * `derive_output_base`): the stem is cut before the last dot-delimited token
 * that starts with "HDR", then the release suffix is appended.
 */
export function autoOutputName(hdrPath: string): string {
  const stem = displayLabel(hdrPath)
  const tokens = stem.split('.')
  let cut = -1
  for (let i = 1; i < tokens.length; i++) {
    if (tokens[i]?.slice(0, 3).toLowerCase() === 'hdr') cut = i
  }
  const base = cut > 0 ? tokens.slice(0, cut).join('.') : stem
  return `${base}.DV.HDR.H.265-NOGRP.mkv`
}
