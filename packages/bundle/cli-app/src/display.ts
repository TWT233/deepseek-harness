import { wrapTextWithAnsi } from '@mariozechner/pi-tui'

const CONTROL_BYTE = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/g

/**
 * Replace terminal control bytes with visible hexadecimal escapes.
 * @param text - Untrusted text that must not control the terminal.
 * @returns Text safe to place inside renderer-owned ANSI sequences.
 */
export function displayText(text: string): string {
  return text.replace(CONTROL_BYTE, character => (
    `\\x${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`
  ))
}

/**
 * Wrap display text to terminal columns while preserving ANSI styling.
 * @param text - Display text, including renderer-owned ANSI sequences.
 * @param width - Available terminal columns.
 * @returns Unpadded display lines.
 */
export function wrapDisplayLines(text: string, width: number): string[] {
  return wrapTextWithAnsi(text, Math.max(1, Math.floor(width)))
}
