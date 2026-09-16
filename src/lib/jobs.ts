import {
  autoOutputName,
  baseName,
  classifyDropName,
  displayLabel,
} from '@/lib/paths'
import { useAppStore } from '@/store/app-store'
import { useSettingsStore } from '@/store/settings-store'
import type { Job, PathInfo, PathKind } from '@/types'

export function newJob(patch: Partial<Job> = {}): Job {
  const s = useSettingsStore.getState()
  return {
    id: crypto.randomUUID(),
    hdrPath: '',
    hdrKind: 'unknown',
    dvPath: '',
    dvKind: 'unknown',
    hdr10plusPath: '',
    outputPath: '',
    outputKind: 'unknown',
    dvDelayMs: s.defaultDvDelayMs,
    hdr10plusDelayMs: s.defaultHdr10plusDelayMs,
    selected: true,
    status: 'queued',
    progress: 0,
    ...patch,
  }
}

export const isFolderPair = (j: Job) =>
  j.hdrKind === 'folder' && j.dvKind === 'folder'
export const isComplete = (j: Job) => Boolean(j.hdrPath && j.dvPath)
/** Both slots filled but one is a file and the other a folder. */
export const isMixed = (j: Job) =>
  isComplete(j) &&
  j.hdrKind !== 'unknown' &&
  j.dvKind !== 'unknown' &&
  j.hdrKind !== j.dvKind
export const canRun = (j: Job) =>
  j.selected &&
  isComplete(j) &&
  !isMixed(j) &&
  j.status !== 'completed' &&
  j.status !== 'running'

/** Card title: the output name for files, the folder name for folder pairs. */
export function jobTitle(j: Job): string {
  if (j.hdrPath) {
    if (j.hdrKind === 'folder') return baseName(j.hdrPath)
    if (j.outputKind === 'file' && j.outputPath) return baseName(j.outputPath)
    return autoOutputName(j.hdrPath)
  }
  if (j.dvPath) return displayLabel(j.dvPath)
  return 'New pair'
}

// ---- Drop handling ---------------------------------------------------------

/**
 * Assign dropped paths to the sidebar form. Names are classified by whole
 * tokens (HDR10+ / DV / HDR); anything unrecognised fills the first empty slot
 * in the order HDR → DV → Output.
 */
export function assignDroppedPaths(infos: PathInfo[]) {
  const store = useAppStore.getState()
  const next = { ...store.setup }
  let placed = 0
  for (const info of infos) {
    if (!info.exists) continue
    const kind: PathKind = info.isDir ? 'folder' : 'file'
    let slot = classifyDropName(info.path)
    if (slot === 'hdr10plus' && !next.hdrPath) slot = 'hdr'
    if (!slot) {
      if (!next.hdrPath) slot = 'hdr'
      else if (!next.dvPath) slot = 'dv'
      else if (!next.outputPath) slot = 'output'
    }
    if (!slot) {
      store.addLog(
        'warning',
        `Ignored dropped path (all inputs are filled): ${info.path}`
      )
      continue
    }
    if (slot === 'hdr')
      Object.assign(next, { hdrPath: info.path, hdrKind: kind })
    else if (slot === 'dv')
      Object.assign(next, { dvPath: info.path, dvKind: kind })
    else if (slot === 'hdr10plus') next.hdr10plusPath = info.path
    else Object.assign(next, { outputPath: info.path, outputKind: kind })
    placed++
  }
  if (placed) store.setSetup(next)
}

// ---- Automatic pairing ----------------------------------------------------

const ROLE_TOKENS =
  /^(dv|dovi|dolby|dolbyvision|hdr|hdr10|hdr10\+|hdr10p|hdr10plus|web-dl|webdl|bluray|blu-ray|uhd|remux|hybrid)$/i

/** Name tokens that identify the title, with role/source words stripped. */
function stemTokens(path: string): Set<string> {
  const label = displayLabel(path).toLowerCase()
  return new Set(
    label.split(/[ .\-_[\]()+]+/).filter(t => t && !ROLE_TOKENS.test(t))
  )
}

function similarity(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0
  let common = 0
  for (const t of a) if (b.has(t)) common++
  return common / Math.max(a.size, b.size)
}

type Role = 'base' | 'donor' | 'unknown'
interface Item {
  path: string
  kind: PathKind
  role: Role
  tokens: Set<string>
}

function roleOf(path: string): Role {
  const slot = classifyDropName(path)
  if (slot === 'dv') return 'donor'
  if (slot === 'hdr' || slot === 'hdr10plus') return 'base'
  return 'unknown'
}

/**
 * Turn dropped/picked paths into pair cards. Existing cards with an empty
 * slot are filled first (same kind, best name match), then the rest are
 * paired with each other by name; anything left over becomes a half-filled
 * card the user can complete.
 */
export function addPaths(infos: PathInfo[]) {
  const store = useAppStore.getState()
  const items: Item[] = infos
    .filter(i => i.exists)
    .map(i => ({
      path: i.path,
      kind: i.isDir ? 'folder' : 'file',
      role: roleOf(i.path),
      tokens: stemTokens(i.path),
    }))
  if (!items.length) return

  const jobs = [...store.jobs]
  const used = new Set<Item>()
  const known = new Set(
    jobs.flatMap(j => [j.hdrPath, j.dvPath]).filter(Boolean)
  )
  const fresh = items.filter(i => !known.has(i.path))

  // 1. Complete half-filled cards.
  for (const job of jobs) {
    if (job.status === 'running') continue
    const missing: 'base' | 'donor' | null =
      !job.hdrPath && job.dvPath
        ? 'base'
        : job.hdrPath && !job.dvPath
          ? 'donor'
          : null
    if (!missing) continue
    const kind = missing === 'base' ? job.dvKind : job.hdrKind
    const ref = stemTokens(missing === 'base' ? job.dvPath : job.hdrPath)
    let best: Item | null = null
    let bestScore = -1
    for (const it of fresh) {
      if (
        used.has(it) ||
        it.kind !== kind ||
        (it.role !== 'unknown' && it.role !== missing)
      )
        continue
      const score = similarity(ref, it.tokens) + (it.role === missing ? 0.5 : 0)
      if (score > bestScore) {
        best = it
        bestScore = score
      }
    }
    if (best) {
      used.add(best)
      store.updateJob(
        job.id,
        missing === 'base'
          ? { hdrPath: best.path, hdrKind: best.kind }
          : { dvPath: best.path, dvKind: best.kind }
      )
    }
  }

  // 2. Pair the rest among themselves: every base (or unknown) looks for the
  //    closest donor of the same kind.
  const rest = fresh.filter(i => !used.has(i))
  const donors = rest.filter(i => i.role === 'donor')
  const bases = rest.filter(i => i.role === 'base')
  const unknown = rest.filter(i => i.role === 'unknown')
  const pairWith = (base: Item, pool: Item[]) => {
    let best: Item | null = null
    let bestScore = 0
    for (const d of pool) {
      if (used.has(d) || d.kind !== base.kind) continue
      const score = similarity(base.tokens, d.tokens)
      if (score > bestScore) {
        best = d
        bestScore = score
      }
    }
    return best
  }
  const created: Job[] = []
  for (const base of bases) {
    used.add(base)
    const donor = pairWith(base, donors) ?? pairWith(base, unknown)
    if (donor) used.add(donor)
    created.push(
      newJob({
        hdrPath: base.path,
        hdrKind: base.kind,
        dvPath: donor?.path ?? '',
        dvKind: donor?.kind ?? 'unknown',
      })
    )
  }
  for (const donor of donors) {
    if (used.has(donor)) continue
    used.add(donor)
    const base = pairWith(donor, unknown)
    if (base) used.add(base)
    created.push(
      newJob({
        hdrPath: base?.path ?? '',
        hdrKind: base?.kind ?? 'unknown',
        dvPath: donor.path,
        dvKind: donor.kind,
      })
    )
  }
  // Unclassified leftovers: two of the same kind become a pair in drop order.
  const left = unknown.filter(i => !used.has(i))
  for (let i = 0; i < left.length; i++) {
    const a = left[i]
    if (!a || used.has(a)) continue
    used.add(a)
    const b = left.slice(i + 1).find(x => !used.has(x) && x.kind === a.kind)
    if (b) used.add(b)
    created.push(
      newJob({
        hdrPath: a.path,
        hdrKind: a.kind,
        dvPath: b?.path ?? '',
        dvKind: b?.kind ?? 'unknown',
      })
    )
  }
  for (const job of created) {
    store.addJob(job)
    store.setExpanded(job.id, true)
  }
  if (created.length)
    store.addLog(
      'info',
      `Added ${created.length} pair${created.length === 1 ? '' : 's'}`
    )
}

/**
 * Entry point for Import and drops. A single pair (up to two paths) goes into
 * the sidebar so it can be checked and adjusted; anything larger is paired by
 * name and queued directly.
 */
export function importPaths(infos: PathInfo[]) {
  const existing = infos.filter(i => i.exists)
  if (existing.length === 0) return
  const setup = useAppStore.getState().setup
  const sidebarFree = !setup.hdrPath && !setup.dvPath
  if (existing.length <= 2 && (sidebarFree || existing.length === 1)) {
    assignDroppedPaths(existing)
    return
  }
  addPaths(existing)
}
