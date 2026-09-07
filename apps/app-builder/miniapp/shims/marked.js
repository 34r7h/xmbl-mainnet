// minimal markdown shim for slice-1 (bold, code, paragraphs only)
export const marked = {
  parse: (s) => String(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
}
export default marked
