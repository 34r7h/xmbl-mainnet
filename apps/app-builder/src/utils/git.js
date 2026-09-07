import * as git from 'isomorphic-git'
import http from 'isomorphic-git/http/web'
import LightningFS from '@isomorphic-git/lightning-fs'

const fs = new LightningFS('git-fs', { wipe: false })
const dir = '/repo'
const defaultRemote = 'origin'

const log = (action, details) => console.log(`[Git] ${action}:`, details)

const ensureRepoInitialized = async () => {
  try {
    const branches = await git.listBranches({ fs, dir })
    if (!branches.includes('main')) {
      log('Initializing Repo', {})
      await git.init({ fs, dir })
      await git.commit({
        fs,
        dir,
        message: 'Initial commit',
        author: { name: 'AutoBot', email: 'bot@example.com' }
      })
      await git.branch({ fs, dir, ref: 'main' })
    }
  } catch (error) {
    log('Error Initializing Repo', error)
  }
}

export default async function gitHandler({ action, options }) {
  log('Action Called', { action, options })

  const gitActions = {
    async initRepo() {
      return await git.init({ fs, dir })
    },
    async listBranches() {
      return await git.listBranches({ fs, dir })
    },
    async checkout({ branch }) {
      return await git.checkout({ fs, dir, ref: branch })
    },
    async createBranch({ branch }) {
      return await git.branch({ fs, dir, ref: branch })
    },
    async addRemote({ remoteUrl, remoteName = defaultRemote }) {
      return await git.addRemote({ fs, dir, remote: remoteName, url: remoteUrl })
    },
    async listRemotes() {
      return await git.listRemotes({ fs, dir })
    },
    async stageAll() {
      const status = await git.statusMatrix({ fs, dir })
      for (const [filepath] of status) {
        await git.add({ fs, dir, filepath })
      }
    },
    async commit({ message, author }) {
      return await git.commit({ fs, dir, message, author })
    },
    async push({ branch = 'main', remoteName = defaultRemote }) {
      await ensureRepoInitialized()
      return await git.push({ fs, http, dir, remote: remoteName, ref: branch, force: true })
    }
  }

  if (!gitActions[action]) {
    throw new Error(`Invalid Git action: ${action}`)
  }

  try {
    return await gitActions[action](options)
  } catch (error) {
    log('Git Error', error)
    throw error
  }
}
