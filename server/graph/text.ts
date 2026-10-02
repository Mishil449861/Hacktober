/** Label normalization + fuzzy similarity shared by extraction cleanup and reconciliation. */

const ABBREV: Record<string, string> = {
  auth: 'authentication', authn: 'authentication', db: 'database', svc: 'service', srv: 'service',
  mgmt: 'management', mgr: 'manager', infra: 'infrastructure', config: 'configuration', env: 'environment',
  fe: 'frontend', be: 'backend', ui: 'frontend',
  k8s: 'kubernetes', msg: 'message', notif: 'notification', notifs: 'notifications', pmt: 'payment', pmts: 'payments',
}
const FILLER = new Set([
  'the', 'a', 'an', 'new', 'old', 'our', 'service', 'system', 'svc', 'module', 'layer', 'app', 'application',
  // connectives, so "Schedule the PCI audit with the assessor" ~ "Schedule PCI audit"
  'with', 'for', 'to', 'of', 'and', 'on', 'in', 'by',
])

export function normalize(label: string): string {
  return label
    .toLowerCase()
    .replace(/\b(front|back)[\s_-]+end\b/g, '$1end')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => ABBREV[t] ?? t)
    .map((t) => (t.length > 3 && t.endsWith('s') && !t.endsWith('ss') ? t.slice(0, -1) : t))
    .filter((t) => !FILLER.has(t))
    .join(' ')
}

function bigrams(s: string) {
  const g = new Set<string>()
  const t = s.replace(/\s/g, '')
  for (let i = 0; i < t.length - 1; i++) g.add(t.slice(i, i + 2))
  return g
}

/** Blend of token Jaccard and character-bigram Dice on normalized labels. */
export function similarity(a: string, b: string): number {
  const na = normalize(a), nb = normalize(b)
  if (!na || !nb) return 0
  if (na === nb) return 1
  const ta = new Set(na.split(' ')), tb = new Set(nb.split(' '))
  const inter = [...ta].filter((t) => tb.has(t)).length
  const jac = inter / new Set([...ta, ...tb]).size
  const ga = bigrams(na), gb = bigrams(nb)
  const gi = [...ga].filter((x) => gb.has(x)).length
  const dice = ga.size + gb.size ? (2 * gi) / (ga.size + gb.size) : 0
  return Math.max(jac, dice * 0.9)
}
