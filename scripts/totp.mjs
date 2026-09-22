// Generate a TOTP code from a base32 secret — so removing 0.2.0 does not depend on having an
// authenticator app installed. `npm profile enable-2fa auth-only` prints an otpauth:// URL whose
// `secret=` parameter is what this takes.
//   node scripts/totp.mjs <BASE32SECRET>
import { createHmac } from 'node:crypto'

const b32 = (s) => {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = ''
  for (const c of s.toUpperCase().replace(/=+$/, '').replace(/\s/g, '')) {
    const i = A.indexOf(c)
    if (i < 0) throw new Error(`not base32: ${c}`)
    bits += i.toString(2).padStart(5, '0')
  }
  const out = Buffer.alloc(bits.length >> 3)
  for (let i = 0; i + 8 <= bits.length; i += 8) out[i >> 3] = parseInt(bits.slice(i, i + 8), 2)
  return out
}

const secret = process.argv[2]
if (!secret) { console.error('usage: node scripts/totp.mjs <BASE32SECRET>'); process.exit(2) }

const counter = Math.floor(Date.now() / 1000 / 30)
const buf = Buffer.alloc(8)
buf.writeBigUInt64BE(BigInt(counter))
const hmac = createHmac('sha1', b32(secret)).update(buf).digest()
const off = hmac[hmac.length - 1] & 0x0f
const code = ((hmac.readUInt32BE(off) & 0x7fffffff) % 1e6).toString().padStart(6, '0')
process.stdout.write(code)
