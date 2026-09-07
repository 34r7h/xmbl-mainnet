// db.js
const DB_STORAGE_KEY = 'xmbl_local_db'

class VirtualLMDB {
  constructor() {
    this.data = this._load()
  }

  _load() {
    const stored = localStorage.getItem(DB_STORAGE_KEY)
    return stored ? JSON.parse(stored) : {}
  }

  _sync() {
    localStorage.setItem(DB_STORAGE_KEY, JSON.stringify(this.data))
  }

  _resolveKey(key) {
    return key.split('.')
  }

  get(key) {
    const keys = this._resolveKey(key)
    return keys.reduce((obj, k) => (obj ? obj[k] : undefined), this.data)
  }

  put(key, value) {
    const keys = this._resolveKey(key)
    let obj = this.data
    keys.slice(0, -1).forEach((k) => {
      if (typeof obj[k] !== 'object' || obj[k] === null) {
        obj[k] = {}
      }
      obj = obj[k]
    })
    obj[keys[keys.length - 1]] = value
    this._sync()
    return value
  }

  del(key) {
    const keys = this._resolveKey(key)
    let obj = this.data
    for (let i = 0; i < keys.length - 1; i++) {
      if (!(keys[i] in obj)) return false
      obj = obj[keys[i]]
    }
    const lastKey = keys[keys.length - 1]
    if (lastKey in obj) {
      delete obj[lastKey]
      this._sync()
      return true
    }
    return false
  }
}

const db = new VirtualLMDB()
export default db
