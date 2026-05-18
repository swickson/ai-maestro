// Diagnostic logging for terminal fit/resize lifecycle.
//
// DEBUG-ONLY. Gated behind localStorage.terminalDebug === "1" so production
// users see nothing. PR #140 (kanban eb3e705c) — the chained refits from PR
// #138 compute correct cols momentarily then something overwrites and the
// terminal reverts to broken state. This module instruments every fit() call
// site + every terminal.onResize + every outbound resize message so the event
// sequence around the flicker is visible in browser devtools.
//
// REVERT AFTER EMPIRICAL. This file + every call site is intended to be
// reverted once we have identified the overwriter and shipped the real fix.
//
// Activation:
//   localStorage.setItem('terminalDebug', '1')
//   then reload the page.
//
// Output format (grep with [TERM-DIAG]):
//   [TERM-DIAG] {"tMs":1234,"event":"fit","source":"chained-500","sessionId":"...","parentW":1480,...}

import type { Terminal } from '@xterm/xterm'
import type { FitAddon } from '@xterm/addon-fit'

export function termDiagEnabled(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem('terminalDebug') === '1'
  } catch {
    return false
  }
}

export function termDiag(event: string, payload: Record<string, unknown> = {}): void {
  if (!termDiagEnabled()) return
  try {
    // eslint-disable-next-line no-console
    console.log(
      '[TERM-DIAG]',
      JSON.stringify({ tMs: Math.round(performance.now()), event, ...payload }),
    )
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[TERM-DIAG] log serialization failed:', e)
  }
}

// Wraps a fitAddon.fit() call and emits a structured log including parent
// width/height, xterm root width, .xterm-screen width, before/after cols/rows,
// and fitAddon.proposeDimensions() — the value the addon WOULD have computed.
// If logging is disabled, fits silently (no measurement overhead).
export function diagFit(
  source: string,
  sessionId: string,
  fitAddon: FitAddon | null,
  terminal: Terminal | null,
  container: HTMLElement | null,
): void {
  if (!fitAddon || !terminal) return
  if (!termDiagEnabled()) {
    try {
      fitAddon.fit()
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[Terminal] Fit failed:', e)
    }
    return
  }

  const before = { cols: terminal.cols, rows: terminal.rows }
  let proposed: { cols: number; rows: number } | undefined
  try {
    proposed = fitAddon.proposeDimensions()
  } catch {
    /* ignore — addon may not have settled */
  }
  const termEl = (terminal as unknown as { element?: HTMLElement }).element
  const screen = termEl?.querySelector('.xterm-screen') as HTMLElement | null

  const dims = {
    source,
    sessionId,
    parentW: container?.clientWidth ?? null,
    parentH: container?.clientHeight ?? null,
    termElW: termEl?.clientWidth ?? null,
    termElH: termEl?.clientHeight ?? null,
    screenW: screen?.clientWidth ?? null,
    screenH: screen?.clientHeight ?? null,
    beforeCols: before.cols,
    beforeRows: before.rows,
    proposedCols: proposed?.cols ?? null,
    proposedRows: proposed?.rows ?? null,
  }

  try {
    fitAddon.fit()
  } catch (e) {
    termDiag('fit-failed', { ...dims, err: String(e) })
    return
  }

  termDiag('fit', {
    ...dims,
    afterCols: terminal.cols,
    afterRows: terminal.rows,
  })
}
