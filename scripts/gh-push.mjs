#!/usr/bin/env node
// Push the working tree to GitHub through the Git Data API.
//
// `git push` over HTTPS does not survive this network (HTTP/2 framing errors,
// then connection timeouts), which is why DDDMUC's repositories are committed
// through the API instead. This script builds a complete tree from the files
// Git tracks and creates one commit on top of the current remote head, so
// repeated runs append history rather than restarting it.
//
// Usage: GH_TOKEN=... node scripts/gh-push.mjs [--message "..."]

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const OWNER = 'DDDMUC'
const REPO = 'dsh-chat-export'
const BRANCH = 'main'
const API = 'https://api.github.com'

const token = process.env.GH_TOKEN
if (token === undefined || token === '') {
  console.error('GH_TOKEN is required')
  process.exit(1)
}

/** One API call, with the handful of headers GitHub insists on. */
async function api(path, init = {}) {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
  const text = await response.text()
  let body
  try {
    body = text === '' ? {} : JSON.parse(text)
  } catch {
    body = { raw: text }
  }
  if (!response.ok) {
    throw new Error(`${init.method ?? 'GET'} ${path} -> ${response.status}: ${JSON.stringify(body).slice(0, 400)}`)
  }
  return body
}

/** Every file Git tracks, so nothing untracked or ignored leaks into the repo. */
function trackedFiles() {
  return execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter((name) => name !== '')
}

/** The commit message: the last local commit's, unless one is passed. */
function defaultMessage() {
  return execFileSync('git', ['log', '-1', '--pretty=%B'], { encoding: 'utf8' }).trimEnd()
}

const messageIndex = process.argv.indexOf('--message')
const message = messageIndex === -1 ? defaultMessage() : process.argv[messageIndex + 1]

const files = trackedFiles()
console.log(`仓库 ${OWNER}/${REPO} · 分支 ${BRANCH} · ${files.length} 个文件`)

// 1. Upload every file as a blob. Text is sent as UTF-8, binaries as base64.
const tree = []
for (const path of files) {
  const bytes = readFileSync(path)
  const isBinary = bytes.includes(0)
  const blob = await api(`/repos/${OWNER}/${REPO}/git/blobs`, {
    method: 'POST',
    body: JSON.stringify(
      isBinary
        ? { content: bytes.toString('base64'), encoding: 'base64' }
        : { content: bytes.toString('utf8'), encoding: 'utf-8' },
    ),
  })
  tree.push({ path, mode: '100644', type: 'blob', sha: blob.sha })
  console.log(`  ${isBinary ? 'base64' : 'utf-8 '} ${path}`)
}

// 2. Lay the blobs out as a tree. `base_tree` keeps the previous tree's other
//    entries, so a file deleted locally still has to be removed explicitly.
const created = await api(`/repos/${OWNER}/${REPO}/git/trees`, {
  method: 'POST',
  body: JSON.stringify({ tree }),
})
console.log(`tree: ${created.sha}`)

// 3. Commit on top of the remote head when there is one.
let parents = []
try {
  const head = await api(`/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`)
  parents = [head.object.sha]
} catch (error) {
  if (!String(error.message).includes('404')) throw error
  console.log('远端还没有 main，本次是首个提交')
}

const commit = await api(`/repos/${OWNER}/${REPO}/git/commits`, {
  method: 'POST',
  body: JSON.stringify({ message, tree: created.sha, parents }),
})
console.log(`commit: ${commit.sha}`)

// 4. Point the branch at it (create the ref the first time, move it after).
if (parents.length === 0) {
  await api(`/repos/${OWNER}/${REPO}/git/refs`, {
    method: 'POST',
    body: JSON.stringify({ ref: `refs/heads/${BRANCH}`, sha: commit.sha }),
  })
} else {
  await api(`/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`, {
    method: 'PATCH',
    body: JSON.stringify({ sha: commit.sha, force: false }),
  })
}
console.log(`已推送 → https://github.com/${OWNER}/${REPO}/commit/${commit.sha}`)
