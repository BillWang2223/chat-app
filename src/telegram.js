'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const tdl = require('tdl')
const { getTdjson } = require('prebuilt-tdlib')
const store = require('./store')
const {
  authView,
  chatKind,
  compareRows,
  contentText,
  formatWhen,
  messageKey,
  personName,
  replyTargetError,
  topicInput,
  unpackedLibraryPath,
} = require('./format')

const CHAT_LIMIT = 40
const HISTORY_LIMIT = 25
const ROW_LIMIT = 1000
const SEND_TIMEOUT_MS = 45000

let tdlibReady = false

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function floodSeconds(err) {
  const match = /FLOOD_WAIT_(\d+)/.exec(String(err?.message || ''))
  return match ? Number(match[1]) : 0
}

function chatListDone(err) {
  return String(err?.message || '').includes('404')
}

function osLabel() {
  if (process.platform === 'win32') return 'Windows'
  if (process.platform === 'darwin') return 'macOS'
  return 'Linux'
}

function ensureTdlib() {
  if (tdlibReady) return
  tdl.configure({
    tdjson: unpackedLibraryPath(getTdjson()),
    verbosityLevel: 1,
  })
  tdlibReady = true
}

async function invoke(client, request) {
  try {
    return await client.invoke(request)
  } catch (err) {
    const wait = floodSeconds(err)
    if (!wait) throw err
    await sleep(Math.min(wait, 20) * 1000)
    return client.invoke(request)
  }
}

function blankSession(account, sendPhone) {
  return {
    id: account.id,
    label: account.label,
    phone: account.phone,
    client: null,
    status: 'connecting',
    detail: '',
    error: '',
    profileName: '',
    sendPhone: Boolean(sendPhone),
    phoneRequest: null,
    synced: false,
    syncing: false,
    removed: false,
    chats: new Map(),
    users: new Map(),
    messages: new Map(),
    sendWaiters: new Map(),
  }
}

class Hub {
  constructor({ userData, broadcast }) {
    this.userData = userData
    this.broadcast = broadcast
    this.file = path.join(userData, 'chatapp.json')
    const loaded = store.load(this.file)
    this.store = loaded.data
    this.needsSave = loaded.needsSave
    this.sessions = new Map()
    this.pending = new Set()
    this.replyErrors = new Map()
    this.timer = null
  }

  seedPreview() {
    const account = { id: 'acc-work', label: 'work', phone: '+15551110000' }
    this.store.accounts = [account]
    const session = blankSession(account, false)
    session.status = 'ready'
    session.profileName = 'Ada (@ada)'
    const rows = [
      ['acc-work:10:3', 10, 3, 'Group', 'Ops', 'Sam Lee', 1763488860, 'ship it?', false],
      ['acc-work:11:2', 11, 2, 'Channel', 'Announcements', 'Ada', 1763488800, 'office is closed', true],
      ['acc-work:12:1', 12, 1, 'DM', 'Sam Lee', 'Sam Lee', 1763488700, 'hey', false],
    ]
    for (const [key, chatId, messageId, type, chat, from, date, content, outgoing] of rows) {
      session.messages.set(key, {
        key,
        accountId: account.id,
        accountLabel: account.label,
        chatId,
        messageId,
        topic: null,
        type,
        chat,
        from,
        date,
        content,
        outgoing,
      })
    }
    this.sessions.set(account.id, session)
    this.broadcastNow()
  }

  start() {
    if (this.needsSave) this.save()
    if (!this.store.apiId || !this.store.apiHash) return
    for (const account of this.store.accounts) {
      this.openAccount(account, { sendPhone: false })
    }
  }

  save() {
    store.save(this.file, this.store)
    this.needsSave = false
  }

  saveConfig({ apiId, apiHash }) {
    const id = String(apiId || '').trim()
    if (!/^\d+$/.test(id)) throw new Error('API ID should be the number from my.telegram.org')
    const hash = String(apiHash || '').trim()
    if (!hash && !this.store.apiHash) throw new Error('API hash is required')
    const credentialsChanged = id !== this.store.apiId || (hash && hash !== this.store.apiHash)
    this.store.apiId = id
    if (hash) this.store.apiHash = hash
    this.save()
    if (credentialsChanged && this.sessions.size === 0) {
      for (const account of this.store.accounts) {
        this.openAccount(account, { sendPhone: false })
      }
    }
    this.broadcastNow()
    return this.snapshot()
  }

  async addAccount({ label, phone }) {
    const name = String(label || '').trim()
    const number = String(phone || '').trim().replace(/[\s()-]/g, '')
    if (!name) throw new Error('Give the account a label')
    if (!/^\+\d{6,15}$/.test(number)) {
      throw new Error('Phone number needs a country code, like +15551234567')
    }
    if (!this.store.apiId || !this.store.apiHash) throw new Error('Save an API ID and API hash first')
    if (this.store.accounts.some((account) => account.phone === number)) {
      throw new Error('That phone number is already added')
    }
    const account = { id: crypto.randomUUID(), label: name, phone: number }
    this.store.accounts.push(account)
    this.save()
    this.openAccount(account, { sendPhone: true })
    this.broadcastNow()
    return this.snapshot()
  }

  async submitCode({ accountId, code }) {
    const session = this.must(accountId)
    const trimmed = String(code || '').replace(/\s+/g, '')
    if (!trimmed) throw new Error('Enter the code')
    session.error = ''
    await session.client.invoke({ _: 'checkAuthenticationCode', code: trimmed })
    this.broadcastNow()
    return this.snapshot()
  }

  async submitPassword({ accountId, password }) {
    const session = this.must(accountId)
    if (!password) throw new Error('Enter the password')
    session.error = ''
    await session.client.invoke({ _: 'checkAuthenticationPassword', password: String(password) })
    this.broadcastNow()
    return this.snapshot()
  }

  async submitEmail({ accountId, email }) {
    const session = this.must(accountId)
    const address = String(email || '').trim()
    if (!address.includes('@')) throw new Error('Enter an email address')
    session.error = ''
    await session.client.invoke({ _: 'setAuthenticationEmailAddress', email_address: address })
    this.broadcastNow()
    return this.snapshot()
  }

  async submitEmailCode({ accountId, code }) {
    const session = this.must(accountId)
    const trimmed = String(code || '').replace(/\s+/g, '')
    if (!trimmed) throw new Error('Enter the email code')
    session.error = ''
    await session.client.invoke({
      _: 'checkAuthenticationEmailCode',
      code: { _: 'emailAddressAuthenticationCode', code: trimmed },
    })
    this.broadcastNow()
    return this.snapshot()
  }

  async submitName({ accountId, firstName, lastName }) {
    const session = this.must(accountId)
    const first = String(firstName || '').trim()
    const last = String(lastName || '').trim()
    if (!first) throw new Error('Enter a first name')
    session.error = ''
    await session.client.invoke({
      _: 'registerUser',
      first_name: first,
      last_name: last,
      disable_notification: false,
    })
    this.broadcastNow()
    return this.snapshot()
  }

  async sendLoginCode(accountId) {
    const session = this.must(accountId)
    session.error = ''
    session.sendPhone = false
    await this.requestCode(session)
    this.broadcastNow()
    return this.snapshot()
  }

  async removeAccount(accountId) {
    const account = this.store.accounts.find((item) => item.id === accountId)
    if (!account) throw new Error('Account not found')
    this.store.accounts = this.store.accounts.filter((item) => item.id !== accountId)
    for (const key of Object.keys(this.store.replied)) {
      if (key.startsWith(`${accountId}:`)) delete this.store.replied[key]
    }
    this.save()
    const session = this.sessions.get(accountId)
    if (session) {
      session.removed = true
      this.sessions.delete(accountId)
      for (const key of [...this.pending]) {
        if (key.startsWith(`${accountId}:`)) this.pending.delete(key)
      }
      if (session.client && !session.client.isClosed()) {
        await Promise.race([this.logout(session), sleep(15000)])
      }
    }
    fs.rmSync(path.join(this.userData, 'accounts', accountId), { recursive: true, force: true })
    this.broadcastNow()
    return this.snapshot()
  }

  async sendReply({ key, text }) {
    const body = String(text || '').trim()
    if (!body) throw new Error('Write a reply first')
    if (this.store.replied[key]) throw new Error('Already replied')
    const found = this.findRow(key)
    if (!found) throw new Error('That message is no longer in the list')
    const { session, row } = found
    if (session.status !== 'ready') throw new Error(`${session.label} is not connected`)
    if (this.pending.has(key)) throw new Error('Sending')
    this.pending.add(key)
    this.replyErrors.delete(key)
    this.broadcastNow()
    try {
      const sent = await this.deliver(session, row, body)
      if (sent.sending_state?._ === 'messageSendingStatePending') {
        await this.waitUntilSent(session, sent.id)
      } else if (sent.sending_state?._ === 'messageSendingStateFailed') {
        throw new Error(sent.sending_state.error?.message || 'Send failed')
      }
      this.store.replied[key] = true
      this.save()
      this.replyErrors.delete(key)
    } catch (err) {
      this.replyErrors.set(key, err.message || 'Send failed')
      throw err
    } finally {
      this.pending.delete(key)
      this.broadcastNow()
    }
    return this.snapshot()
  }

  async shutdown() {
    clearTimeout(this.timer)
    this.timer = null
    await Promise.all([...this.sessions.values()].map(async (session) => {
      session.removed = true
      if (session.client && !session.client.isClosed()) {
        await session.client.close().catch(() => {})
      }
    }))
  }

  snapshot() {
    const messages = []
    for (const session of this.sessions.values()) {
      for (const row of session.messages.values()) {
        messages.push({
          key: row.key,
          accountId: row.accountId,
          account: row.accountLabel,
          type: row.type,
          chat: row.chat,
          from: row.from,
          date: row.date,
          when: formatWhen(row.date),
          content: row.content,
          outgoing: row.outgoing,
          replied: Boolean(this.store.replied[row.key]),
        })
      }
    }
    messages.sort(compareRows)
    const missingCredentials = !this.store.apiId || !this.store.apiHash
    return {
      apiId: this.store.apiId,
      apiHashSet: Boolean(this.store.apiHash),
      accounts: this.store.accounts.map((account) => {
        const session = this.sessions.get(account.id)
        return {
          id: account.id,
          label: account.label,
          phone: account.phone,
          status: session?.status || (missingCredentials ? 'error' : 'closed'),
          detail: session?.detail || '',
          error: session?.error || (missingCredentials ? 'Save an API ID and API hash.' : ''),
          profileName: session?.profileName || '',
          syncing: Boolean(session?.syncing),
        }
      }),
      messages: messages.slice(0, ROW_LIMIT),
      sending: [...this.pending],
      replyErrors: Object.fromEntries(this.replyErrors),
    }
  }

  openAccount(account, { sendPhone }) {
    if (this.sessions.has(account.id)) return
    const session = blankSession(account, sendPhone)
    this.sessions.set(account.id, session)
    try {
      ensureTdlib()
      const directory = path.join(this.userData, 'accounts', account.id)
      fs.mkdirSync(directory, { recursive: true })
      const client = tdl.createClient({
        apiId: Number(this.store.apiId),
        apiHash: this.store.apiHash,
        databaseDirectory: path.join(directory, 'db'),
        filesDirectory: path.join(directory, 'files'),
        databaseEncryptionKey: this.store.encryptionKey,
        skipOldUpdates: true,
        tdlibParameters: {
          use_message_database: true,
          use_secret_chats: false,
          system_language_code: 'en',
          device_model: 'Chatapp',
          system_version: osLabel(),
          application_version: '0.1.0',
        },
      })
      session.client = client
      client.on('error', (err) => {
        session.error = err.message || 'Telegram error'
        this.scheduleBroadcast()
      })
      client.on('update', (update) => {
        this.onUpdate(session, update).catch((err) => {
          session.error = err.message || 'Telegram error'
          this.scheduleBroadcast()
        })
      })
      client.on('close', () => {
        if (session.removed) return
        session.status = 'closed'
        session.detail = 'Telegram closed this session. Restart Chatapp to reconnect.'
        this.broadcastNow()
      })
    } catch (err) {
      session.status = 'error'
      session.error = err.message || 'Could not start Telegram'
    }
    this.scheduleBroadcast()
  }

  async onUpdate(session, update) {
    if (session.removed) return
    if (update._ === 'updateAuthorizationState') {
      this.onAuth(session, update.authorization_state)
      return
    }
    if (update._ === 'updateNewMessage') {
      await this.rememberMessage(session, update.message)
      this.scheduleBroadcast()
      return
    }
    if (update._ === 'updateMessageContent') {
      const key = messageKey(session.id, update.chat_id, update.message_id)
      const row = session.messages.get(key)
      if (row) {
        row.content = contentText(update.new_content)
        this.scheduleBroadcast()
      }
      return
    }
    if (update._ === 'updateMessageSendSucceeded') {
      const oldKey = messageKey(session.id, update.message.chat_id, update.old_message_id)
      session.messages.delete(oldKey)
      await this.rememberMessage(session, update.message)
      this.settleSend(session, update.old_message_id, null)
      this.scheduleBroadcast()
      return
    }
    if (update._ === 'updateMessageSendFailed') {
      const oldKey = messageKey(session.id, update.message.chat_id, update.old_message_id)
      session.messages.delete(oldKey)
      const reason = update.error?.message || 'Send failed'
      this.settleSend(session, update.old_message_id, reason)
      this.scheduleBroadcast()
    }
  }

  onAuth(session, state) {
    const view = authView(state)
    if (session.status !== view.status) {
      console.log(`[chatapp] ${session.label}: ${view.status}`)
    }
    session.status = view.status
    session.detail = view.detail
    if (view.status === 'ready' && !session.synced) {
      session.synced = true
      session.error = ''
      this.sync(session)
    }
    if (view.status === 'wait_phone' && session.sendPhone) {
      session.sendPhone = false
      this.requestCode(session).catch((err) => {
        session.error = err.message || 'Could not send the login code'
        this.broadcastNow()
      })
    }
    this.scheduleBroadcast()
  }

  requestCode(session) {
    if (session.phoneRequest) return session.phoneRequest
    session.detail = 'Sending the login code…'
    this.scheduleBroadcast()
    session.phoneRequest = session.client.invoke({
      _: 'setAuthenticationPhoneNumber',
      phone_number: session.phone,
    }).finally(() => {
      session.phoneRequest = null
    })
    return session.phoneRequest
  }

  async sync(session) {
    if (session.syncing || session.removed) return
    session.syncing = true
    session.detail = 'Loading chats…'
    this.scheduleBroadcast()
    try {
      const me = await invoke(session.client, { _: 'getMe' })
      session.users.set(String(me.id), me)
      session.profileName = personName(me)
      try {
        await invoke(session.client, {
          _: 'loadChats',
          chat_list: { _: 'chatListMain' },
          limit: CHAT_LIMIT,
        })
      } catch (err) {
        if (!chatListDone(err)) throw err
      }
      const chats = await invoke(session.client, {
        _: 'getChats',
        chat_list: { _: 'chatListMain' },
        limit: CHAT_LIMIT,
      })
      const ids = chats.chat_ids || []
      let loaded = 0
      for (const chatId of ids) {
        if (session.removed) return
        try {
          await this.loadChat(session, chatId)
        } catch (err) {
          console.error(`[chatapp] ${session.label} chat ${chatId}: ${err.message}`)
        }
        loaded += 1
        if (loaded % 5 === 0) this.scheduleBroadcast()
      }
      session.detail = ''
      session.error = ''
    } catch (err) {
      session.error = err.message || 'Could not load chats'
    } finally {
      session.syncing = false
      this.broadcastNow()
    }
  }

  async loadChat(session, chatId) {
    const chat = await invoke(session.client, { _: 'getChat', chat_id: chatId })
    session.chats.set(String(chatId), chat)
    const history = await invoke(session.client, {
      _: 'getChatHistory',
      chat_id: chatId,
      from_message_id: 0,
      offset: 0,
      limit: HISTORY_LIMIT,
      only_local: false,
    })
    for (const message of history.messages || []) {
      if (!message || !message.date) continue
      const row = await this.toRow(session, chat, message)
      session.messages.set(row.key, row)
    }
  }

  async rememberMessage(session, message) {
    if (!message || !message.date || session.removed) return
    const chat = await this.chatFor(session, message.chat_id)
    const row = await this.toRow(session, chat, message)
    session.messages.set(row.key, row)
    this.trim(session)
  }

  async toRow(session, chat, message) {
    const from = await this.senderName(session, message)
    return {
      key: messageKey(session.id, message.chat_id, message.id),
      accountId: session.id,
      accountLabel: session.label,
      chatId: message.chat_id,
      messageId: message.id,
      topic: topicInput(message.topic_id),
      type: chatKind(chat),
      chat: chat?.title || 'Chat',
      from: from || (message.is_outgoing ? session.label : 'Unknown'),
      date: message.date || 0,
      content: contentText(message.content),
      outgoing: Boolean(message.is_outgoing),
    }
  }

  async senderName(session, message) {
    const sender = message.sender_id
    if (!sender) return ''
    if (sender._ === 'messageSenderUser') {
      return personName(await this.userFor(session, sender.user_id))
    }
    if (sender._ === 'messageSenderChat') {
      const chat = await this.chatFor(session, sender.chat_id)
      return chat?.title || ''
    }
    return ''
  }

  async userFor(session, userId) {
    const key = String(userId)
    if (session.users.has(key)) return session.users.get(key)
    const user = await invoke(session.client, { _: 'getUser', user_id: userId })
    session.users.set(key, user)
    return user
  }

  async chatFor(session, chatId) {
    const key = String(chatId)
    if (session.chats.has(key)) return session.chats.get(key)
    const chat = await invoke(session.client, { _: 'getChat', chat_id: chatId })
    session.chats.set(key, chat)
    return chat
  }

  trim(session) {
    if (session.messages.size <= ROW_LIMIT) return
    const rows = [...session.messages.values()].sort(compareRows)
    session.messages = new Map(rows.slice(0, ROW_LIMIT).map((row) => [row.key, row]))
  }

  async deliver(session, row, text) {
    const content = {
      _: 'inputMessageText',
      text: { _: 'formattedText', text },
      clear_draft: false,
    }
    try {
      return await session.client.invoke(this.sendRequest(row, content, true))
    } catch (err) {
      if (!replyTargetError(err)) throw err
      return session.client.invoke(this.sendRequest(row, content, false))
    }
  }

  sendRequest(row, content, withReply) {
    const request = {
      _: 'sendMessage',
      chat_id: row.chatId,
      input_message_content: content,
    }
    if (row.topic) request.topic_id = row.topic
    if (withReply) {
      request.reply_to = {
        _: 'inputMessageReplyToMessage',
        message_id: row.messageId,
      }
    }
    return request
  }

  waitUntilSent(session, tempId) {
    const id = String(tempId)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        session.sendWaiters.delete(id)
        reject(new Error('Telegram did not confirm the send'))
      }, SEND_TIMEOUT_MS)
      session.sendWaiters.set(id, {
        resolve: () => {
          clearTimeout(timer)
          resolve()
        },
        reject: (message) => {
          clearTimeout(timer)
          reject(new Error(message))
        },
      })
    })
  }

  settleSend(session, tempId, errorMessage) {
    const waiter = session.sendWaiters.get(String(tempId))
    if (!waiter) return
    session.sendWaiters.delete(String(tempId))
    if (errorMessage) waiter.reject(errorMessage)
    else waiter.resolve()
  }

  findRow(key) {
    for (const session of this.sessions.values()) {
      const row = session.messages.get(key)
      if (row) return { session, row }
    }
    return null
  }

  must(accountId) {
    const session = this.sessions.get(accountId)
    if (!session?.client) throw new Error('That account is not running')
    return session
  }

  async logout(session) {
    await new Promise((resolve) => {
      if (!session.client || session.client.isClosed()) {
        resolve()
        return
      }
      session.client.once('close', resolve)
      const job = session.status === 'ready'
        ? session.client.invoke({ _: 'logOut' })
        : session.client.close()
      job.catch(() => {
        session.client.close().catch(() => resolve())
      })
    })
  }

  scheduleBroadcast() {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.emit(), 80)
  }

  broadcastNow() {
    clearTimeout(this.timer)
    this.timer = null
    this.emit()
  }

  emit() {
    try {
      this.broadcast(this.snapshot())
    } catch (err) {
      console.error('[chatapp] broadcast failed', err)
    }
  }
}

module.exports = { Hub, unpackedLibraryPath }
