import { join, resolve } from 'node:path'

import { PRODUCT } from '@deskwork/product-config'

export const DOCTOR_UNLOCK_COMMAND = `${PRODUCT.cliName} doctor --unlock`

export type LeaseBlockView = Readonly<{
  title: string
  body: readonly string[]
  doctorCommand: string
}>

/**
 * Human-readable, path-free summary of a refused home lease. The owner
 * summary line comes from `LeaseError.ownerSummary` and is already sanitized;
 * a custom home is described by the env variable both entrypoints must share.
 */
export function describeLeaseBlock(input: {
  code: string
  ownerSummary?: string | undefined
}): LeaseBlockView {
  const lines = [
    '另一个入口正在使用这份数据（' + input.code + '）。',
    '完全退出另一个入口后重试；不同 profile 不构成并发例外。',
  ]
  if (input.ownerSummary !== undefined) lines.push(`当前 owner：${input.ownerSummary}`)
  if (input.code === 'HOME_STALE' || input.code === 'LEASE_UNKNOWN') {
    lines.push('锁残留或无法识别 owner 时，可运行 doctor 清理：')
  } else {
    lines.push('如需诊断锁状态，可运行：')
  }
  lines.push('自定义 home 的入口必须使用相同的 DESKWORK_HOME。')
  return Object.freeze({
    title: `${PRODUCT.displayName} 无法独占数据目录`,
    body: Object.freeze(lines),
    doctorCommand: DOCTOR_UNLOCK_COMMAND,
  })
}

/**
 * Smoke runs must never fall back to the real default home: the home is
 * always derived from the dedicated smoke userData directory.
 */
export function resolveSmokeHome(input: {
  smokeMode: string | undefined
  userData: string
  osHome: string
}): string {
  if (input.smokeMode === undefined) throw new Error('smoke home requires an explicit smoke mode')
  const home = resolve(join(input.userData, 'home'))
  if (home === resolve(join(input.osHome, '.dsh'))) {
    throw new Error('smoke home must never be the real default DSH home')
  }
  return home
}
