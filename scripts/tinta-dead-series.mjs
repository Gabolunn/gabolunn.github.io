// Revisión diaria de obras de ManhwaWeb con las imágenes borradas.
//
// ImageShack eliminó los archivos de muchas obras: la ficha y la lista de
// capítulos existen, pero ninguna página carga. La app Tinta Manga lee
// tinta-dead-series.json y deja de mostrar esas obras.
//
// Una obra se marca muerta SOLO si su primer y su último capítulo están muertos
// (404 en la lista de páginas o en la imagen). Un fallo de red o un 5xx no marca
// nada: se vuelve a intentar en la siguiente ejecución.
//
//   node scripts/tinta-dead-series.mjs            # una tanda (~40 min)
//   node scripts/tinta-dead-series.mjs --limit 20  # prueba corta
//   node scripts/tinta-dead-series.mjs --ids a,b   # revisar obras concretas
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

const API = 'https://manhwawebbackend-production.up.railway.app'
const HEADERS = { Referer: 'https://manhwaweb.com/', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36' }
const STATE = 'tinta-dead-series-state.json'
const OUTPUT = 'tinta-dead-series.json'
const DAY = 86400000
const RECHECK_ALIVE = 14 * DAY
const RECHECK_DEAD = 7 * DAY
const args = process.argv.slice(2)
const LIMIT = Number(args[args.indexOf('--limit') + 1]) || 700
const BUDGET_MS = Number(process.env.AUDIT_BUDGET_MS) || 40 * 60_000
const started = Date.now()

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let lastApi = 0
async function api(path) {
  const wait = lastApi + 500 - Date.now()
  if (wait > 0) await sleep(wait)
  lastApi = Date.now()
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(API + path, { headers: HEADERS, signal: AbortSignal.timeout(20000) })
      if (res.status === 404) return { status: 404 }
      if (!res.ok) throw new Error('HTTP ' + res.status)
      return { status: 200, body: await res.json() }
    } catch (error) {
      if (attempt) return { status: 0, error }
      await sleep(3000)
    }
  }
}

async function imageStatus(url) {
  try {
    const res = await fetch(url, { headers: { ...HEADERS, Range: 'bytes=0-1023' }, signal: AbortSignal.timeout(20000) })
    const type = res.headers.get('content-type') || ''
    await res.arrayBuffer().catch(() => {})
    if ((res.ok || res.status === 206) && /^image\//i.test(type)) return 'ok'
    // Solo «no existe» cuenta como muerta. Un 403 o una página HTML pueden ser
    // un bloqueo hacia el servidor de GitHub, no una imagen borrada.
    if (res.status === 404 || res.status === 410) return 'dead'
    return 'unknown'
  } catch { return 'unknown' }
}

const slugOf = (link) => String(link || '').split('/').filter(Boolean).at(-1) || ''

// 'ok' | 'dead' | 'unknown'
// Igual que la app: los enlaces de muchas obras llevan el `_id` antiguo y solo
// funcionan con el `real_id` (sin esto, Solo Leveling salía como muerta).
async function chapterState(chapter, fix) {
  const slugs = [...new Set([chapter.link, ...(chapter.versions || []).map((v) => v?.link)].map((link) => slugOf(fix(link))).filter(Boolean))]
  let unknown = false
  for (const slug of slugs) {
    const res = await api('/chapters/see/' + encodeURIComponent(slug))
    if (res.status === 404) continue
    if (res.status !== 200) { unknown = true; continue }
    const imgs = Array.isArray(res.body?.chapter?.img) ? res.body.chapter.img : []
    if (!imgs.length || String(res.body?.roto || '').toLowerCase() === 'si') continue
    const state = await imageStatus(imgs[Math.min(1, imgs.length - 1)])
    if (state === 'ok') return 'ok'
    if (state === 'unknown') unknown = true
  }
  return unknown ? 'unknown' : 'dead'
}

async function seriesState(id) {
  const res = await api('/manhwa/see/' + encodeURIComponent(id))
  if (res.status !== 200) return 'unknown'
  const chapters = (Array.isArray(res.body?.chapters) ? res.body.chapters : [])
    .filter((c) => c?.link || c?.versions?.some((v) => v?.link))
    .sort((a, b) => Number(a.chapter) - Number(b.chapter))
  if (!chapters.length) return 'unknown'
  const oldId = String(res.body?._id || '').trim()
  const realId = String(res.body?.real_id || '').trim()
  const fix = (link) => oldId && realId && oldId !== realId ? String(link || '').replace(oldId, realId) : link
  const picks = chapters.length === 1 ? [chapters[0]] : [chapters[0], chapters.at(-1)]
  const states = []
  for (const chapter of picks) {
    const state = await chapterState(chapter, fix)
    if (state === 'ok') return 'alive'
    states.push(state)
  }
  return states.every((s) => s === 'dead') ? 'dead' : 'unknown'
}

async function catalogIds() {
  const ids = []
  const seen = new Set()
  for (let page = 0; page < 400; page++) {
    const res = await api(`/manhwa/library?buscar=&page=${page}&order_item=popularidad&order_dir=desc`)
    if (res.status !== 200) break
    for (const item of res.body?.data || []) {
      const id = String(item?.real_id || '').trim()
      if (id && !seen.has(id)) { seen.add(id); ids.push(id) }
    }
    if (!res.body?.next) break
  }
  return ids
}

const ONLY = args.includes('--ids') ? String(args[args.indexOf('--ids') + 1] || '').split(',').filter(Boolean) : null
if (ONLY) {
  for (const id of ONLY) console.log(id, await seriesState(id))
  process.exit(0)
}

const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {}
const ids = await catalogIds()
console.log(`catálogo: ${ids.length} obras`)
const now = Date.now()
const due = (id) => {
  const entry = state[id]
  if (!entry) return true
  return now - entry.at > (entry.dead ? RECHECK_DEAD : RECHECK_ALIVE)
}
// Primero las nunca revisadas (en orden de popularidad), después las más viejas.
const queue = [
  ...ids.filter((id) => !state[id]),
  ...ids.filter((id) => state[id] && due(id)).sort((a, b) => state[a].at - state[b].at)
].slice(0, LIMIT)

const counts = { alive: 0, dead: 0, unknown: 0 }
for (const id of queue) {
  if (Date.now() - started > BUDGET_MS) break
  const result = await seriesState(id)
  counts[result]++
  if (result !== 'unknown') state[id] = { at: Date.now(), dead: result === 'dead' }
}
// Obras que ya no están en el catálogo salen del estado.
const live = new Set(ids)
if (ids.length > 100) for (const id of Object.keys(state)) if (!live.has(id)) delete state[id]

const deadIds = Object.keys(state).filter((id) => state[id].dead).sort()
writeFileSync(STATE, JSON.stringify(state))
writeFileSync(OUTPUT, JSON.stringify({ updatedAt: new Date().toISOString(), checked: Object.keys(state).length, ids: deadIds }))
console.log(`revisadas ahora: vivas ${counts.alive} · muertas ${counts.dead} · sin respuesta ${counts.unknown}`)
console.log(`total revisadas ${Object.keys(state).length}/${ids.length} · muertas ${deadIds.length}`)
