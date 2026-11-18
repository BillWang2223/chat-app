'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

function emptyAccount(account) {
  if (!account || !account.id || !account.label) return null
  return {
    id: String(account.id),
    label: String(account.label),
    phone: String(account.phone || ''),
  }
}

function normalize(data) {
  const source = data && typeof data === 'object' ? data : {}
  const replied = {}
  if (source.replied && typeof source.replied === 'object') {
    for (const [key, value] of Object.entries(source.replied)) {
      if (value) replied[key] = true
    }
  }
  return {
    apiId: source.apiId ? String(source.apiId) : '',
    apiHash: typeof source.apiHash === 'string' ? source.apiHash : '',
    encryptionKey: typeof source.encryptionKey === 'string' && source.encryptionKey
      ? source.encryptionKey
      : crypto.randomBytes(32).toString('base64'),
    accounts: Array.isArray(source.accounts)
      ? source.accounts.map(emptyAccount).filter(Boolean)
      : [],
    replied,
  }
}

function load(file) {
  let parsed = null
  let existed = false
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    existed = true
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }
  const hadKey = Boolean(parsed && typeof parsed.encryptionKey === 'string' && parsed.encryptionKey)
  return {
    data: normalize(parsed || {}),
    needsSave: !existed || !hadKey,
  }
}

function save(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(tmp, file)
}

module.exports = { load, save }
