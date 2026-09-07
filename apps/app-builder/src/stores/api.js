// stores/api.js
import { useAppState } from './state'
import _ from 'lodash'
import db from '@/utils/db.js'
// import compute from '@/utils/compute.js'
import * as git from '../utils/git.js'
import { Buffer } from 'buffer'
window.Buffer = Buffer

const methods = {
  async api({ args, commands, inputs, scope, xid, actions, $value }) {
    console.groupCollapsed('$api.api', { args, commands, inputs, scope, xid, actions, $value })
    console.groupCollapsed('Action Setup')
    let $xid = xid
    let $scope = scope || 'scopes.' + $xid.split('.').slice(0, -1).join('.')
    let proxyvalue = methods.get({ uri: $scope })
    $value = $value || proxyvalue ? JSON.parse(JSON.stringify(proxyvalue)) : null
    console.log({ $scope, proxyvalue, $value })

    const argarray = args && typeof args == 'string' ? [...args.split(',')] : args ? args : []

    const inputarray =
      inputs && typeof inputs == 'string' ? [...inputs.split(',')] : inputs ? inputs : []

    const $state = useAppState().state

    console.log('Setup Results', { $scope, $value, argarray, inputarray, $state })

    console.groupEnd('Action Setup')

    if (actions) {
      console.groupCollapsed('Action Stack', { actions })

      return new Promise(async (resolve, reject) => {
        const outputs = []

        for (const [xi, x] of actions.entries()) {
          console.log({ xi, x })

          try {
            let [fn, body] = [
              Object.keys(x)[0],
              $value || JSON.parse(JSON.stringify(x[Object.keys(x)[0]]))
            ]
            console.groupCollapsed(fn, body)
            console.info('Injecting', { fn, body, scope, $value })

            const output = await methods[fn]({
              ...body,
              scope: $scope,
              $value,
              xid
            })

            methods.set({ uri: [...scope, '$outputs', xi], value: output })
            console.log({ output })
            console.groupEnd(fn)
            outputs.push(output)
          } catch (err) {
            console.error('Error in action execution:', err)
            return reject(err) // Reject if any action fails
          }
        }

        console.log('All actions completed', { outputs })
        console.groupEnd('Action Stack')
        resolve(outputs) // Resolve with all outputs after completion
        console.groupEnd('$api.api')
        return outputs[outputs.length - 1]
      })
    }

    return new Promise((resolve, reject) => {
      // console.log('promise wrapped')
      console.groupCollapsed('Custom Action', { $state, $api: methods, $scope, $value })
      try {
        const result = Function(...[...argarray, '$state', '$api', '$scope', '$value'], commands)(
          ...[...inputarray],
          JSON.parse(JSON.stringify($state)),
          methods,
          $scope,
          $value
        )

        // methods.set({ uri: [...scope, '$outputs'], value: result })

        methods.set({ uri: 'scopes.' + xid, value: result })
        console.log({ result }, methods.get({ uri: 'scopes.' + xid }))
        console.groupEnd('Custom Action')
        console.groupEnd('$api.api')
        resolve(result)
      } catch (error) {
        reject(error)
      }
    })
  },
  get({ uri, provider }) {
    // console.log('get', { uri, provider })
    if (!provider) {
      // console.log('No Provider', uri)
      const $state = useAppState().state
      return _.get($state, uri)
    } else {
      if (provider == '@') {
        let rec = methods.get({ uri: 'db.data.' + uri })
        if (!rec || !rec.data) return undefined
        let x = rec.data
        if (!x || !x.to || !x.to[0]) return undefined
        return x.to[0].slice(0, 2) == '07'
          ? methods.get({ uri: x.to[0], provider: '@' })
          : methods.get({ uri: 'db.data.' + x.to[0] + '.data' })
      }
      if (provider == 'db') {
        console.log('looking for', uri)
        return db.get(uri)
      }
    }
  },
  remove({ uri, provider, type }) {
    // $api.remove({uri: '$state', provider: 'db'})
    // console.log('remove', { uri, provider, type })

    const $state = useAppState().state
    if (provider) {
      if (provider == 'db') return db.del(uri)
    }
    _.unset($state, uri)
    const parenturi =
      typeof uri == 'string'
        ? uri.split('.').slice(0, uri.split('.').length - 1)
        : uri.slice(0, uri.length - 1)
    if (
      utils({
        utype: 'type',
        udata: {
          val: methods.get({
            uri: parenturi
          })
        }
      }) == 'array'
    ) {
      methods.set({
        uri: parenturi,
        value: utils({
          utype: 'compact',
          udata: methods.get({
            uri: parenturi
          })
        })
      })
    }
  },
  // clone() ?
  async set({ uri, provider, value, type }) {
    // Example 1: save state to db
    // $api.set({uri: '$state', provider: 'db', value: $state})
    // type == model to use
    // console.log('set', { uri, provider, value, type })
    const $state = useAppState().state
    if (type) {
      console.info('setting type', { value, type })
      if (type === '0') {
        console.log('datum, datum')
      }
      // 1. make sure datum entries
      if (!value.data) return console.error('Datum value must contain a data property')
      if (type !== '0') {
        const includedprops = Object.keys(value.data).sort(),
          requiredprops = Object.keys($state.config.types[type]).sort()
        console.log(
          { includedprops, requiredprops },
          requiredprops.every((value) => includedprops.includes(value))
        )

        // requiredprops.forEach((x) => !includedprops.includes(x))
        console.log(requiredprops.every((value) => includedprops.includes(value)))
        const validprops = requiredprops.every((value) => includedprops.includes(value))

        if (!validprops)
          return console.error('Data keys do not match key requirements', {
            'data keys': Object.keys(value.data).sort(),
            'type requirements': Object.keys($state.config.types[type]).sort()
          })
        let proptypecheck = {}
        const proptypecheckarray = includedprops.map((prop) => {
          const proptype = utils({ utype: 'type', udata: { val: value.data[prop] } })
          const expectedtype = $state.config.types[type][prop]
          if (proptype !== expectedtype) {
            proptypecheck[prop] = {
              expecting: expectedtype,
              provided: proptype,
              data: value.data[prop]
            }
            return false
          }
        })
        if (proptypecheckarray.includes(false))
          return console.error('Property types do not match', proptypecheck)
      }
      const [oid, xid, nonce] = await utils({ utype: 'hash', udata: { content: value, type } })
      let datum = { oid, nonce, data: value.data }
      // console.log({ oid, xid, nonce, datum })
      // console.log({ datum })

      // console.log(
      //   'get type from config.types',
      //   { type },
      //   $state.config.lexicon[type],
      //   Object.keys($state.config.types[type])
      // )

      // console.log('validate data')
      // console.log('abort if type unfit')
      // console.log(await utils({ utype: 'hash', udata: { content: value, type } }))
      _.set($state, `db.data.${xid}_${nonce}`, datum)
      return xid
    }
    if (!provider) {
      // console.log('Setting state')
      _.set($state, uri, value)
      // console.log(uri, methods.get({ uri }))
      return [uri, value]
    } else {
      if (provider == 'db') return db.put(uri, value)
    }
  },
  async tx(payload = {}) {
    // Send a transaction: assemble a type-6 `tx` datum, content-address it via the
    // shared micromining (nonce iterated until the SHA-256 hash prefix == "06"), and
    // persist it awaiting validation.
    //
    // payload / tx body (type-6 — every field required, exact runtime types):
    //   chain  string  target chain id (e.g. "xmbl", "base-sepolia")
    //   from   array   PAYER party ref(s): the sender/debited party (agent/account id)
    //   to     array   PAYEE party ref(s): the recipient/credited party
    //   asset  string  asset / contract id being moved
    //   amount string  quantity moved (string to preserve chain-amount precision)
    //   seq    number  sender SEQUENCE (anti-replay) — distinct from datum.nonce (the
    //                  micromining PoW nonce)
    //   prev   string  POINTER to the sender's previous tx xid — the tx-chain link that
    //                  carries ordering + provenance + anti-replay; "" for genesis. A
    //                  settled record's prev -> the committed record's xid.
    //   unspent string the value UNIT's denomination at mint — IMMUTABLE. Splits type-6:
    //                  FUNGIBLE tokens (UTXO-style) carry their spendable value here and are
    //                  consumed by a type-7 SPEND-pointer that references this xid as input
    //                  (spent-ness is DERIVED from the spend graph, never by mutating this
    //                  datum — content-addressing forbids a mutable flag). NON-FUNGIBLE
    //                  assets are whole units (not divided into change), transferred by an
    //                  ownership pointer, not consumed UTXO-style. A pure RECORD of value
    //                  that moved on ANOTHER chain (e.g. a handoff USDC settlement on
    //                  Base/Arc) carries unspent="" — it records the movement, it does NOT
    //                  re-mint spendable xmbl value (unspent=amount there would be phantom
    //                  double-counted value). unspent=value is only a genuine xmbl-NATIVE mint.
    //
    // WHAT IS REQUIRED FOR VALIDATION:
    //   1. content-address proof: the datum's xid must carry the "06" type prefix, which
    //      only a correct nonce over oid=SHA-256(body) can produce (set()/hash() do this).
    //   2. `prev` must resolve to the payer's real prior tx xid (provenance + ordering +
    //      anti-replay chain); from/to name the payer/payee parties.
    //   3. a signature over `oid` and validator VOTES accumulating to `required` (quorum,
    //      3) are NOT part of the hashed body — content-addressing forbids mutating the
    //      body after mining. They are SEPARATE type-7 pointer datums that reference this
    //      tx's xid. Producing that quorum + sealing a cube is the chain side's lane.
    const $state = useAppState().state
    const type = '6'
    const required = Object.keys($state.config.types[type]) // exact-key contract
    const body = {
      chain: payload.chain,
      from: Array.isArray(payload.from) ? payload.from : [],
      to: Array.isArray(payload.to) ? payload.to : [],
      asset: payload.asset,
      amount: payload.amount == null ? '' : String(payload.amount),
      seq: Number(payload.seq) || 0,
      prev: payload.prev == null ? '' : String(payload.prev),
      unspent: payload.unspent == null ? '' : String(payload.unspent)
    }
    const missing = required.filter(
      (k) => body[k] === undefined || (body[k] === '' && k !== 'prev' && k !== 'unspent')
    )
    if (missing.length) return console.error('tx: missing required fields', { missing, body })
    // set() validates the exact-key + per-field type contract, micromines the "06" xid,
    // and persists db.data.${xid}_${nonce}. Returns the xid, or undefined on validation failure.
    const xid = await methods.set({ value: { data: body }, type })
    if (!xid) return console.error('tx: rejected by type validation', { body })
    // Validation seam — the tx datum now exists and is content-addressed. Next (chain side):
    //   sign(oid) -> type-7 pointer; validator votes -> type-7 pointers to xid until quorum
    //   (required=3) -> chain seals+persists a cube. This return is the signable handle.
    console.info('tx staged', { xid, type, body, awaiting: 'sign + validation votes -> xid' })
    return { xid, type: +type, data: body }
  },
  utils({ utype, udata }) {
    // console.log('utils', { utype, udata })
    // const $state = useAppState().state

    // sync(db, location) - set/get from network db, local storage/index, file
    // type(val) - get object/value type
    // hash(type, oid) - find/check micromining
    // validate(value, type, creds, actions)
    // json() - try/catch parse/stringify
    const u = {
      null() {
        return null
      },
      compact(val) {
        // remove null/nil from array
        // console.log('compacting:', { val }, _.compact(val))
        return _.compact(val)
      },
      db(dbdata) {
        console.log('writing to db', dbdata)
        // types: network, firebase, indexedDB
        // dbdata = { type, action, loc, data, creds }
        // i.e. methods.utils('db', {type: 'indexed', action: 'set', loc: 'testingindexedlocation', data: 'datatada'})
        let data = dbdata
        if (typeof dbdata == 'string') {
          data = JSON.parse(dbdata)
        }
        console.log('db', { data })
        const dbs = {
          indexed: {
            get: () => {
              let db
              // console.log({ indexedDB })
              const request = indexedDB.open('XMBL', 3)
              request.onerror = (event) => {
                console.log({ event })
                // Do something with request.errorCode!
              }
              request.onsuccess = (event) => {
                db = event.target.result
                console.log({ event, db })
                // Do something with request.result!
              }
            },
            set: () => {
              const dbName = 'XMBL'
              const dbVersion = 3

              const request = indexedDB.open(dbName, dbVersion)
              request.onsuccess = (event) => {
                const db = event.target.result

                const transaction = db.transaction([data.loc], 'readwrite')
                const objectStore = transaction.objectStore(data.loc)
                // console.log(JSON.parse(JSON.stringify($state)), { ...$state })

                // { id: 'safghany', $state: JSON.parse(JSON.stringify($state)) }
                // dbdata.value
                console.log(data.data, { objectStore })

                objectStore.add(data.data)

                transaction.oncomplete = (event) => {
                  console.log('All done!')
                }

                transaction.onerror = (event) => {
                  console.error('Error adding data:', event.target.errorCode, { event })
                }
              }
            }
          }
        }
        return dbs[data.type][data.action]()
      },
      git({ action, options }) {
        console.log({ action, options })
        const gitactions = {
          // Initializes a new repository.
          initRepo: async (opts) => await git({ action: 'initRepo', options: opts }),

          // Stages all changed files.
          stageAll: async (opts) => await git({ action: 'stageAll', options: opts }),

          // Commits staged changes.
          commit: async (opts) => await git({ action: 'commit', options: opts }),

          // Adds or updates a remote repository.
          addRemote: async (opts) => await git({ action: 'addRemote', options: opts }),

          // Pushes commits to the remote repository.
          push: async (opts) => await git({ action: 'push', options: opts }),

          // Writes the app state to a JSON file in the repo.
          updateState: async ({ state }) => {
            const filepath = 'state.json'
            await git({ action: 'stageAll', options: {} })
            await git({
              action: 'commit',
              options: {
                message: 'Update state',
                author: { name: 'User', email: 'user@example.com' }
              }
            })
            return await git({ action: 'push', options: {} })
          },

          // Reads the app state from the JSON file in the repo.
          readState: async () => {
            const filepath = 'state.json'
            return await git({ action: 'readFile', options: { filepath } })
          }
        }
        if (!gitactions[action]) {
          throw new Error(`Action "${action}" not found`)
        }
        return gitactions[action](options)
      },
      encode() {}, // infer, decode, encode (type, to) i.e. JSON, CSV, XML
      encrypt({ type, key, data }) {
        const encryptmethods = {
          sym: (prvkey, data) => {},
          asym: (pubkey, data) => {}
        }
        return encryptmethods[type](key, data)
      },
      decrypt({ type, key, encrypteddata }) {
        const decryptmethods = {
          sym: (prvkey, encrypteddata) => {},
          asym: (prvkey, encrypteddata) => {}
        }
        return decryptmethods[type](key, encrypteddata)
      }, // decrypt, encrypt (type, key) i.e. symetrcal, asym
      sync(db1, [...db2]) {
        // get db1
        // set to db2s
        // db2s can be ['state', 'db', 'git']
        console.log({ db1, db2 })
      },
      norm(string) {
        const disallowedChars = /[^a-zA-Z0-9_]/g
        return string.replace(disallowedChars, '_')
      },
      async hash({ content, type, algo }) {
        // console.log({ content, type, algo })
        // content = ['hello']
        // type = 'trait'
        // algo = '512'
        // default algo to 256
        // content && !type, return [hash]
        // content && type && !nonce ? return [hash, token, nonce]
        // micromining protocol: nonce = 0. if hash starts with type code, nonce == 0, else nonce++ until type code.

        let nonce = 0
        const micro = async (type, realhash) => {
          // console.log('micromining!', realhash, nonce)
          const temphash = await methods
            .utils({ utype: 'hash', udata: { content: realhash + String(nonce), algo: 256 } })
            .then((x) => x)
          // console.log({ temphash }, temphash.indexOf(type) == 0)
          return temphash.indexOf(type) == 0 ? [temphash, nonce] : (nonce++, micro(type, realhash))
        }
        let contentstring =
          typeof content == 'string'
            ? content
            : typeof content == 'object'
              ? JSON.stringify(content)
              : String(content)

        const msgUint8 = new TextEncoder().encode(contentstring) // encode as (utf-8) Uint8Array
        const hashBuffer = await window.crypto.subtle.digest(`SHA-${algo || 256}`, msgUint8) // hash the message
        const hashArray = Array.from(new Uint8Array(hashBuffer)) // convert buffer to byte array
        const hashHex = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('') // convert bytes to hex string
        const typecode = '0' + (type || '0')
        // if (hashHex.indexOf(typecode) == 0) {
        // console.log([hashHex, typecode])
        const returnable = !type
          ? hashHex
          : [hashHex, ...(await micro(typecode, hashHex).then((x) => x))]
        // returnable.length == 3 && console.log('Hashed: ', returnable)
        return returnable
      },
      type({ val, coerce }) {
        // val = `{
        //   type: 'indexed',
        //   action: 'set',
        //   loc: 'any',
        //   data: 'stuff',
        //   creds: 'me',
        //   jgfv: 'me',
        //   jhv: 'me'
        // }`
        // val = '[{ a: 1 }, { b: 2 }]'
        // val = undefined
        // coerce = 'object'
        // if coerce (type), return value as new type (i.e. string => number)
        // console.log({ val, coerce })

        const infer = () => {
          // console.log(typeof val, Array.isArray(val))
          return typeof val == 'object' && !Array.isArray(val)
            ? 'object'
            : Array.isArray(val)
              ? 'array'
              : typeof val
        }
        const basetype = infer()
        let mutate = {
          string: () => {
            console.log({ basetype }, typeof val)
            let xvalue =
              basetype == 'string' ? val : basetype == 'object' ? JSON.stringify(val) : String(val)
            console.log({ xvalue })
            return xvalue
          },
          number: () => {
            console.log('number', { basetype }, typeof val)
            let xvalue =
              +val == +val
                ? Number(val)
                : (basetype == 'number' || +val == +val) && val == val
                  ? val
                  : null
            console.log({ xvalue })

            return xvalue
          },
          boolean: () => (
            console.log(basetype == 'boolean' ? val : Boolean(val)),
            basetype == 'boolean' ? val : Boolean(val)
          ),
          array: () => {
            return basetype == 'array'
              ? val
              : basetype == 'string' &&
                  (() => {
                    try {
                      const parsed = JSON.parse(val)
                      if (Array.isArray(parsed)) return parsed
                      throw new Error('JSON is not an Array')
                    } catch (e) {
                      let arr = Function(`return Array.from(${val})`)()
                      console.log({ arr })
                      if (Array.isArray(arr) && typeof eval(val) == 'object') {
                        return arr
                      }
                      throw new Error('Unable to create list from ' + val)
                    }
                  })(val)
          },
          object: () => {
            console.log({ val })
            return basetype == 'object'
              ? val
              : basetype == 'string' &&
                  (() => {
                    try {
                      const parsed = JSON.parse(val)
                      // console.log({ parsed })
                      if (typeof parsed == 'object' && !Array.isArray(parsed)) {
                        return parsed
                      }
                      throw new Error('JSON is not an Object')
                    } catch (e) {
                      let obj = Function(`return Object(${val})`)()
                      // console.log({ obj })
                      if (typeof eval(obj) == 'object' && !Array.isArray(obj)) {
                        return obj
                      }
                      throw new Error('Unable to create object from ' + val)
                    }
                  })(val)
          },
          function: () => {
            console.log('f(x) value: ', val)
            return val
          }
        }
        // console.log('just before type fn', { val, coerce })
        let returnable = coerce ? mutate[coerce]() : infer()
        // console.log('Typed: ', returnable)
        return returnable
      },
      validate({ val }) {
        try {
          return val?.every((condition) => {
            if (typeof condition == 'string' && condition.indexOf('$state.') == 0) {
              // console.log('they want state!', condition.substring(7, condition.length))
              let thestatetheywant = methods.get({ uri: condition.substring(7, condition.length) })
              // console.log({ thestatetheywant })
            }
            const $state = useAppState().state

            // console.log('validating', { condition })

            const evalFunc = new Function('$state', '$api', 'return ' + condition)
            return evalFunc($state, methods)
          })
        } catch (error) {
          console.error('Error evaluating conditions:', error)
          return false
        }
      }
    }
    // console.log('just before util call', { utype, udata })

    return u[utype](udata)
  },
  async init({ options }) {
    setTimeout(() => {
      let $state = useAppState().state
      console.groupCollapsed('init()')
      // console.log(JSON.parse(JSON.stringify({ options, $state })))

      console.groupCollapsed('Database')
      console.log(db.data)
      console.groupEnd('Database')

      if (!db.data.$state) {
        console.groupCollapsed('Components', { $state })

        Object.entries($state.app.display).map((x) => {
          console.log({ x })
          x[1].components &&
            x[1].components.map((x) => {
              console.log({ x: JSON.parse(JSON.stringify(x)) })
              if (x.from && x.from == 'route') {
                console.log('approching routes', x)
              }
              methods.set({ value: { data: JSON.parse(JSON.stringify(x)) }, type: '2' })
            })
        })
        console.groupEnd('Components')

        console.groupCollapsed('Routes', $state.config.routes)
        $state.config.routes.map((x) => {
          console.log('getting routes', { x })
          methods.set({ value: { data: x }, type: '7' })
        })
        setTimeout(async () => {
          const index = JSON.parse(JSON.stringify($state.db.data))
          console.log({ index })

          Object.entries(await index).map(async (y) => {
            if (y[0].slice(0, 2) == '07' && y[1].data.how == 'route') {
              console.log('route detected', y[1].data.how == 'route', 'setting', y[1].data)
              methods.set({
                value: y[1],
                uri:
                  'routes.' +
                  (await methods.utils({
                    utype: 'hash',
                    udata: { content: y[1].data.from.join('/') }
                  }))
              })
            }
          })
          console.groupEnd('Routes')
          console.groupCollapsed('Actions', $state.actions)
          $state.actions.map((x) => {
            console.log('action', { x })
            methods.set({ value: { data: x }, type: '4' })
          })
          console.groupEnd('Actions')
          // console.log({ data: JSON.parse(JSON.stringify($state.db.data)) })
          console.groupEnd('init()')
        }, 1000)
      } else {
        console.log($state)
        console.groupEnd('init()')
      }
    }, 1000)
  }
}

export const init = methods.init
export const get = methods.get
export const remove = methods.remove
export const set = methods.set
export const utils = methods.utils
export const api = methods.api
