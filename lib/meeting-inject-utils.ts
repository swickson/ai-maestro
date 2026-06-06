/**
 * Meeting injection utilities — helpers shared by the meeting-chat route
 * and its tests.
 */

/**
 * Strip avatar image paths from text before it enters an agent's context.
 *
 * Gemini CLI treats local-looking paths as files to read, burning tokens and
 * causing unnecessary I/O on every turn. We only target image-extension paths
 * in the shapes seen in the wild (../… relative paths, /mnt/agents/… absolute)
 * so legitimate file references in conversation are left intact.
 *
 * @param text - Raw message text that may contain avatar path references
 * @returns The same text with avatar paths replaced by the literal "[avatar]"
 */
export function stripAvatarPaths(text: string): string {
  // Character class covers real avatar filenames (spaces, dots, hyphens) while
  // the non-greedy quantifier stops at the first image extension so adjacent
  // paths like "a.png b.jpg" each match separately.
  return text
    .replace(/(?:\.\.\/)+[\w .\-/]+?\.(?:png|jpg|jpeg|gif|webp|svg)/gi, '[avatar]')
    .replace(/\/mnt\/agents\/[\w .\-/]+?\.(?:png|jpg|jpeg|gif|webp|svg)/gi, '[avatar]')
}
