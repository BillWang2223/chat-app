'use strict'

const STATUS = {
  connecting: 'Connecting',
  wait_phone: 'Needs a login code',
  wait_code: 'Code sent',
  wait_password: 'Needs the password',
  wait_email: 'Needs an email',
  wait_email_code: 'Email code sent',
  wait_name: 'Needs a name',
  wait_other_device: 'Confirm on another device',
  ready: 'Connected',
  closed: 'Disconnected',
  error: 'Not connected',
}

const ui = {
  page: 'chat',
  open: new Set(),
  drafts: new Map(),
  cardErrors: new Map(),
  cardStatus: new Map(),
  configReady: false,
  localSending: new Set(),
  focusReply: '',
}

let current = null

function errorText(err) {
  return String(err?.message || err || 'Something went wrong')
    .replace(/^Error invoking remote method '[^']+': Error:\s*/, '')
    .replace(/^Error invoking remote method '[^']+':\s*/, '')
}

function el(tag, attrs, children) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value == null || value === false) continue
    if (key === 'class') node.className = value
    else if (key === 'text') node.textContent = value
    else node.setAttribute(key, String(value))
  }
  for (const child of children || []) {
    if (child != null) node.append(child)
  }
  return node
}

function hue(label) {
  let hash = 0
  for (let i = 0; i < label.length; i += 1) hash = (hash * 33 + label.charCodeAt(i)) >>> 0
  return hash % 360
}

function captureFocus() {
  const node = document.activeElement
  if (!node?.dataset?.draft) return null
  return {
    draft: node.dataset.draft,
    start: node.selectionStart,
    end: node.selectionEnd,
  }
}

function restoreFocus(saved, prefix) {
  if (!saved || !saved.draft.startsWith(prefix)) return
  const node = document.querySelector(`[data-draft="${CSS.escape(saved.draft)}"]`)
  if (!node) return
  node.focus()
  if (typeof saved.start === 'number' && node.setSelectionRange) {
    node.setSelectionRange(saved.start, saved.end)
  }
}

function snippet(text) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim()
  if (!flat) return '[empty]'
  if (flat.length <= 140) return flat
  return `${flat.slice(0, 139)}…`
}

function draftValue(key) {
  return ui.drafts.get(key) || ''
}

function watchDraft(input, key) {
  input.addEventListener('input', () => {
    ui.drafts.set(key, input.value)
  })
}

function summaryText(state) {
  const connected = state.accounts.filter((account) => account.status === 'ready').length
  const syncing = state.accounts.some((account) => account.syncing)
  const accounts = state.accounts.length === 1 ? '1 account' : `${state.accounts.length} accounts`
  const messages = state.messages.length === 1 ? '1 message' : `${state.messages.length} messages`
  return `${accounts} · ${connected} connected · ${messages}${syncing ? ' · loading' : ''}`
}

function emptyText(state) {
  if (state.accounts.length === 0) return 'Add a Telegram account in Settings.'
  if (state.accounts.some((account) => account.syncing || account.status === 'connecting')) {
    return 'Loading messages…'
  }
  if (!state.accounts.some((account) => account.status === 'ready')) {
    return 'Connect an account in Settings to load messages.'
  }
  return 'No messages yet.'
}

function renderChrome(state) {
  document.getElementById('chat-page').hidden = ui.page !== 'chat'
  document.getElementById('settings-page').hidden = ui.page !== 'settings'
  for (const button of document.querySelectorAll('.nav button')) {
    if (button.dataset.page === ui.page) button.setAttribute('aria-current', 'page')
    else button.removeAttribute('aria-current')
  }
  document.getElementById('top-status').textContent = state ? summaryText(state) : 'Starting'
}

function renderRow(row, state) {
  const sending = state.sending.includes(row.key) || ui.localSending.has(row.key)
  const article = el('article', { class: row.outgoing ? 'row out' : 'row' })
  const cells = el('div', { class: 'cells' })
  const dot = el('span', { class: 'dot' })
  dot.style.background = `hsl(${hue(row.account)} 55% 58%)`
  cells.append(
    el('div', { class: 'account-cell' }, [
      dot,
      el('span', { class: 'clip', text: row.account, title: row.account }),
    ]),
    el('div', {}, [el('span', { class: `type ${row.type}`, text: row.type })]),
    el('div', { class: 'clip', text: row.chat, title: row.chat }),
    el('div', { class: 'from-cell' }, [
      el('span', { class: 'clip', text: row.from, title: row.from }),
      row.outgoing ? el('span', { class: 'out-tag', text: 'out' }) : null,
    ]),
    el('div', { class: 'when', text: row.when }),
    el('div', { class: 'content', text: row.content, title: row.content }),
  )
  const button = el('button', {
    type: 'button',
    class: 'reply-btn',
    text: row.replied ? 'Replied' : 'Reply',
  })
  button.disabled = row.replied
  if (!row.replied) {
    button.addEventListener('click', () => {
      if (ui.open.has(row.key)) ui.open.delete(row.key)
      else {
        ui.open.add(row.key)
        ui.focusReply = row.key
      }
      render(current)
    })
  }
  cells.append(el('div', {}, [button]))
  article.append(cells)

  if (ui.open.has(row.key) && !row.replied) {
    const form = el('form', { class: 'composer' })
    const code = el('code')
    const draftKey = `reply:${row.key}`
    const input = el('input', {
      type: 'text',
      placeholder: 'Write a reply',
      'data-draft': draftKey,
      value: draftValue(draftKey),
    })
    const send = el('button', { type: 'submit', text: sending ? 'Sending…' : 'Send' })
    send.disabled = sending || input.value.trim() === ''
    watchDraft(input, draftKey)
    input.addEventListener('input', () => {
      send.disabled = sending || input.value.trim() === ''
    })
    code.textContent = snippet(row.content)
    form.append(
      el('p', { class: 'quote', text: 'reply of ' }, [code]),
      el('div', { class: 'composer-line' }, [input, send]),
    )
    const failure = state.replyErrors[row.key]
    if (failure) form.append(el('p', { class: 'send-error', text: failure }))
    form.addEventListener('submit', (event) => submitReply(event, row.key))
    article.append(form)
  }
  return article
}

async function submitReply(event, key) {
  event.preventDefault()
  const draftKey = `reply:${key}`
  const text = draftValue(draftKey)
  if (!text.trim() || ui.localSending.has(key)) return
  ui.localSending.add(key)
  render(current)
  try {
    current = await window.chatapp.sendReply({ key, text })
    ui.drafts.delete(draftKey)
    ui.open.delete(key)
  } catch (err) {
    if (current) current.replyErrors = { ...current.replyErrors, [key]: errorText(err) }
  } finally {
    ui.localSending.delete(key)
    render(current)
  }
}

function renderChat(state) {
  const page = document.getElementById('chat-page')
  const previous = page.querySelector('.list')
  const scrollTop = previous ? previous.scrollTop : 0
  const scrollLeft = previous ? previous.scrollLeft : 0
  const focus = captureFocus()
  for (const key of [...ui.open]) {
    const row = state.messages.find((item) => item.key === key)
    if (!row || row.replied) {
      ui.open.delete(key)
      ui.drafts.delete(`reply:${key}`)
    }
  }
  const list = el('div', { class: 'list' })
  const head = el('div', { class: 'cells head' })
  for (const label of ['Account', 'Type', 'Chat', 'From', 'DateTime', 'Content', 'Reply']) {
    head.append(el('div', { text: label }))
  }
  list.append(head)
  if (state.messages.length === 0) list.append(el('div', { class: 'empty', text: emptyText(state) }))
  for (const row of state.messages) list.append(renderRow(row, state))
  page.replaceChildren(list)
  list.scrollTop = scrollTop
  list.scrollLeft = scrollLeft
  if (ui.focusReply) {
    const key = ui.focusReply
    ui.focusReply = ''
    const node = document.querySelector(`[data-draft="${CSS.escape(`reply:${key}`)}"]`)
    if (node) node.focus()
  } else {
    restoreFocus(focus, 'reply:')
  }
}

function accountForm(account) {
  const error = ui.cardErrors.get(account.id)
  const draft = (name) => draftValue(`account:${account.id}:${name}`)
  const input = (name, type, placeholder) => {
    const key = `account:${account.id}:${name}`
    const node = el('input', {
      type,
      placeholder,
      'data-draft': key,
      value: draft(name),
    })
    watchDraft(node, key)
    return node
  }
  const button = (text) => el('button', { type: 'submit', class: 'primary', text })
  let form = null
  if (account.status === 'wait_phone') {
    form = el('form', { class: 'card-form' }, [button('Send code')])
    form.addEventListener('submit', (event) => submitAccount(event, account.id, () => (
      window.chatapp.sendLoginCode(account.id)
    )))
  } else if (account.status === 'wait_code') {
    form = el('form', { class: 'card-form' }, [input('code', 'text', 'Code'), button('Confirm')])
    form.addEventListener('submit', (event) => submitAccount(event, account.id, () => (
      window.chatapp.submitCode({ accountId: account.id, code: draft('code') })
    )))
  } else if (account.status === 'wait_password') {
    form = el('form', { class: 'card-form' }, [input('password', 'password', 'Password'), button('Confirm')])
    form.addEventListener('submit', (event) => submitAccount(event, account.id, () => (
      window.chatapp.submitPassword({ accountId: account.id, password: draft('password') })
    )))
  } else if (account.status === 'wait_email') {
    form = el('form', { class: 'card-form' }, [input('email', 'text', 'Email'), button('Send')])
    form.addEventListener('submit', (event) => submitAccount(event, account.id, () => (
      window.chatapp.submitEmail({ accountId: account.id, email: draft('email') })
    )))
  } else if (account.status === 'wait_email_code') {
    form = el('form', { class: 'card-form' }, [input('emailCode', 'text', 'Email code'), button('Confirm')])
    form.addEventListener('submit', (event) => submitAccount(event, account.id, () => (
      window.chatapp.submitEmailCode({ accountId: account.id, code: draft('emailCode') })
    )))
  } else if (account.status === 'wait_name') {
    form = el('form', { class: 'card-form' }, [
      input('first', 'text', 'First name'),
      input('last', 'text', 'Last name'),
      button('Create'),
    ])
    form.addEventListener('submit', (event) => submitAccount(event, account.id, () => (
      window.chatapp.submitName({
        accountId: account.id,
        firstName: draft('first'),
        lastName: draft('last'),
      })
    )))
  }
  const block = el('div')
  if (account.detail && account.status === 'wait_other_device') {
    block.append(
      el('p', { class: 'detail', text: 'Confirm this login on a device that is already signed in.' }),
      el('code', { class: 'link-box', text: account.detail }),
    )
  } else if (account.detail) {
    block.append(el('p', { class: 'detail', text: account.detail }))
  }
  if (form) block.append(form)
  if (error || account.error) block.append(el('p', { class: 'error', text: error || account.error }))
  return block
}

async function submitAccount(event, accountId, action) {
  event.preventDefault()
  ui.cardErrors.delete(accountId)
  try {
    render(await action())
  } catch (err) {
    ui.cardErrors.set(accountId, errorText(err))
    render(current)
  }
}

function renderAccounts(state) {
  const list = document.getElementById('account-list')
  const focus = captureFocus()
  list.replaceChildren()
  if (state.accounts.length === 0) {
    list.append(el('p', { class: 'note', text: 'No accounts yet.' }))
    restoreFocus(focus, 'account:')
    return
  }
  for (const account of state.accounts) {
    if (ui.cardStatus.get(account.id) !== account.status) {
      ui.cardErrors.delete(account.id)
      ui.cardStatus.set(account.id, account.status)
    }
    const remove = el('button', { type: 'button', text: 'Remove' })
    remove.addEventListener('click', () => removeAccount(account))
    const head = el('div', { class: 'account-head' }, [
      el('strong', { text: account.label }),
      el('span', { class: 'phone', text: account.phone }),
      el('span', { class: `status ${account.status}`, text: STATUS[account.status] || account.status }),
      remove,
    ])
    const card = el('article', { class: 'account' }, [head])
    if (account.profileName) card.append(el('p', { class: 'profile', text: account.profileName }))
    card.append(accountForm(account))
    list.append(card)
  }
  restoreFocus(focus, 'account:')
}

async function removeAccount(account) {
  if (!window.confirm(`Remove ${account.label}? Chatapp will log this account out.`)) return
  ui.cardErrors.delete(account.id)
  try {
    render(await window.chatapp.removeAccount(account.id))
  } catch (err) {
    ui.cardErrors.set(account.id, errorText(err))
    render(current)
  }
}

function syncConfig(state) {
  const hash = document.getElementById('api-hash')
  const note = document.getElementById('config-note')
  if (!ui.configReady) {
    document.getElementById('api-id').value = state.apiId || ''
    ui.configReady = true
  }
  if (document.activeElement !== hash) {
    hash.placeholder = state.apiHashSet ? 'Saved. Enter a new hash to replace it.' : 'API hash'
  }
  if (hash.value === '') {
    note.textContent = state.apiHashSet
      ? 'API hash is saved on this PC. Restart Chatapp after changing it if an account is already open.'
      : ''
  }
}

function render(state) {
  if (!state) return
  current = state
  renderChrome(state)
  syncConfig(state)
  if (ui.page === 'chat') renderChat(state)
  renderAccounts(state)
}

function bindStatic() {
  for (const button of document.querySelectorAll('.nav button')) {
    button.addEventListener('click', () => {
      ui.page = button.dataset.page
      if (current) render(current)
    })
  }

  document.getElementById('api-link').addEventListener('click', (event) => {
    event.preventDefault()
    window.chatapp.openExternal(event.currentTarget.href).catch((err) => {
      document.getElementById('config-error').textContent = errorText(err)
    })
  })

  document.getElementById('config-form').addEventListener('submit', async (event) => {
    event.preventDefault()
    const error = document.getElementById('config-error')
    error.textContent = ''
    try {
      const state = await window.chatapp.saveConfig({
        apiId: document.getElementById('api-id').value,
        apiHash: document.getElementById('api-hash').value,
      })
      document.getElementById('api-hash').value = ''
      render(state)
    } catch (err) {
      error.textContent = errorText(err)
    }
  })

  document.getElementById('add-form').addEventListener('submit', async (event) => {
    event.preventDefault()
    const error = document.getElementById('add-error')
    error.textContent = ''
    try {
      const state = await window.chatapp.addAccount({
        label: document.getElementById('account-label').value,
        phone: document.getElementById('account-phone').value,
      })
      document.getElementById('account-label').value = ''
      document.getElementById('account-phone').value = ''
      render(state)
    } catch (err) {
      error.textContent = errorText(err)
    }
  })
}

bindStatic()
if (!window.chatapp) {
  document.getElementById('top-status').textContent = 'Open this page from the Chatapp window.'
} else {
  window.chatapp.getState().then(render).catch((err) => {
    document.getElementById('top-status').textContent = errorText(err)
  })
  window.chatapp.onState(render)
}
