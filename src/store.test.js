'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { load, save } = require('./store')

function tempDir() {
  const root = path.join(__dirname, '../.test-tmp')
  fs.mkdirSync(root, { recursive: true })
  return fs.mkdtempSync(path.join(root, 'store-'))
}

test('the encryption key and replied rows survive a restart', () => {
  const dir = tempDir()
  const file = path.join(dir, 'chatapp.json')
  const first = load(file)
  assert.equal(first.needsSave, true)
  assert.ok(first.data.encryptionKey.length > 20)
  first.data.apiId = '2222'
  first.data.apiHash = 'hash'
  first.data.accounts.push({ id: 'acc', label: 'work', phone: '+1555' })
  first.data.replied['acc:1:2'] = true
  save(file, first.data)
  const second = load(file)
  assert.equal(second.needsSave, false)
  assert.equal(second.data.encryptionKey, first.data.encryptionKey)
  assert.equal(second.data.apiHash, 'hash')
  assert.deepEqual(second.data.accounts, [{ id: 'acc', label: 'work', phone: '+1555' }])
  assert.equal(second.data.replied['acc:1:2'], true)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('a broken store file is left untouched', () => {
  const dir = tempDir()
  const file = path.join(dir, 'chatapp.json')
  fs.writeFileSync(file, '{')
  assert.throws(() => load(file))
  assert.equal(fs.readFileSync(file, 'utf8'), '{')
  fs.rmSync(dir, { recursive: true, force: true })
})
