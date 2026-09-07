// slice-1 sanitize shim: strip <script> and on* handlers (content is self-authored)
const sanitize = (s) => String(s)
  .replace(/<script[\s\S]*?<\/script>/gi, '')
  .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
export default { sanitize }
