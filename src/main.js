'use strict'

const { app, BrowserWindow, Menu, ipcMain, shell } = require('electron')
const fs = require('fs')
const path = require('path')
const { Hub } = require('./telegram')

app.setName('Chatapp')
if (process.platform === 'win32') app.setAppUserModelId('com.chatapp.desktop')
if (process.env.CHATAPP_USER_DATA) app.setPath('userData', process.env.CHATAPP_USER_DATA)

let windowRef = null
let hub = null
let quitting = false

function broadcast(state) {
  if (windowRef && !windowRef.isDestroyed()) windowRef.webContents.send('state', state)
}

function allowedExternal(url) {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' && parsed.hostname === 'my.telegram.org'
  } catch {
    return false
  }
}

function createWindow() {
  windowRef = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#141311',
    title: 'Chatapp',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  windowRef.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  windowRef.webContents.on('will-navigate', (event) => event.preventDefault())
  windowRef.loadFile(path.join(__dirname, '../renderer/index.html'))
  windowRef.webContents.on('did-finish-load', () => {
    if (hub) broadcast(hub.snapshot())
    if (process.env.CHATAPP_SMOKE === '1') runSmoke()
  })
}

function bindIpc() {
  const handles = {
    'get-state': () => hub.snapshot(),
    'save-config': (_event, input) => hub.saveConfig(input || {}),
    'add-account': (_event, input) => hub.addAccount(input || {}),
    'submit-code': (_event, input) => hub.submitCode(input || {}),
    'submit-password': (_event, input) => hub.submitPassword(input || {}),
    'submit-email': (_event, input) => hub.submitEmail(input || {}),
    'submit-email-code': (_event, input) => hub.submitEmailCode(input || {}),
    'submit-name': (_event, input) => hub.submitName(input || {}),
    'send-login-code': (_event, accountId) => hub.sendLoginCode(accountId),
    'remove-account': (_event, accountId) => hub.removeAccount(accountId),
    'send-reply': (_event, input) => hub.sendReply(input || {}),
    'open-external': (_event, url) => {
      if (!allowedExternal(url)) throw new Error('That link stays inside Chatapp')
      return shell.openExternal(url)
    },
  }
  for (const [channel, handler] of Object.entries(handles)) {
    ipcMain.handle(channel, handler)
  }
}

function smokeShot(name) {
  return windowRef.webContents.capturePage().then((image) => {
    fs.writeFileSync(path.join(__dirname, '../.test-tmp', name), image.toPNG())
  })
}

function runSmoke() {
  if (runSmoke.started) return
  runSmoke.started = true
  const openReply = `
    (async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
      for (let i = 0; i < 40; i += 1) {
        if (document.body.innerText.includes('ship it?')) break
        await wait(50)
      }
      const chatText = document.getElementById('chat-page').innerText
      const reply = [...document.querySelectorAll('.reply-btn')].find((button) => button.textContent === 'Reply')
      reply.click()
      const code = document.querySelector('.quote code')
      const before = code ? getComputedStyle(code, '::before').content : ''
      const after = code ? getComputedStyle(code, '::after').content : ''
      const width = document.documentElement.clientWidth
      const box = (node) => node ? node.getBoundingClientRect().right : 0
      return {
        chatText,
        quote: document.querySelector('.quote') ? document.querySelector('.quote').innerText : '',
        before,
        after,
        hasInput: Boolean(document.querySelector('.composer input')),
        sendText: document.querySelector('.composer button') ? document.querySelector('.composer button').textContent : '',
        composerInsideRow: Boolean(document.querySelector('.row .composer')),
        width,
        scrollWidth: document.documentElement.scrollWidth,
        replyRight: box(document.querySelector('.reply-btn')),
        sendRight: box(document.querySelector('.composer button')),
      }
    })()
  `
  windowRef.webContents.executeJavaScript(openReply).then(async (chat) => {
    await windowRef.webContents.executeJavaScript('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    await smokeShot('chat.png')
    await windowRef.webContents.executeJavaScript(`(async () => {
      document.getElementById('nav-settings').click()
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    })()`)
    await new Promise((resolve) => setTimeout(resolve, 400))
    await smokeShot('settings.png')
    const pages = await windowRef.webContents.executeJavaScript(`({
      settingsText: document.getElementById('settings-page').innerText,
      chatHidden: document.getElementById('chat-page').hidden,
      settingsHidden: document.getElementById('settings-page').hidden,
    })`)
    const result = { ...chat, ...pages }
    const haystack = result.chatText.toLowerCase()
    const problems = []
    for (const needle of ['account', 'type', 'chat', 'from', 'datetime', 'content', 'reply', 'work', 'group', 'ops', 'sam lee', 'ship it?', 'channel', 'dm', 'out']) {
      if (!haystack.includes(needle)) problems.push(`chat list missing ${needle}`)
    }
    if (!result.quote.toLowerCase().startsWith('reply of ')) problems.push(`quote was ${JSON.stringify(result.quote)}`)
    if (!result.quote.includes('ship it?')) problems.push('quote missing the message')
    if (result.before !== '"`"' && result.before !== '"\`"') {
      if (!(result.before.includes('`'))) problems.push(`opening quote mark was ${result.before}`)
    }
    if (!(result.after || '').includes('`')) problems.push(`closing quote mark was ${result.after}`)
    if (!result.hasInput || !result.composerInsideRow) problems.push('reply input did not open inside the row')
    if (result.scrollWidth > result.width + 1) problems.push(`page scrolls sideways ${result.scrollWidth} > ${result.width}`)
    if (result.replyRight > result.width + 1) problems.push('Reply button is outside the window')
    if (result.sendRight > result.width + 1) problems.push('Send button is outside the window')
    if (result.sendText !== 'Send') problems.push(`send button was ${JSON.stringify(result.sendText)}`)
    if (!result.settingsText.includes('API ID') || !result.settingsText.includes('work')) {
      problems.push('settings page is missing the account form')
    }
    if (!result.chatHidden || result.settingsHidden) problems.push('pages did not switch')
    if (problems.length) {
      console.error(problems.join('\n'))
      console.error(JSON.stringify(result, null, 2))
      process.exitCode = 1
    } else {
      console.log('smoke ok')
    }
    app.quit()
  }).catch((err) => {
    console.error(err)
    process.exitCode = 1
    app.quit()
  })
}

function boot() {
  app.on('second-instance', () => {
    if (!windowRef) return
    if (windowRef.isMinimized()) windowRef.restore()
    windowRef.focus()
  })

  app.on('before-quit', (event) => {
    if (quitting || !hub) return
    event.preventDefault()
    quitting = true
    hub.shutdown().finally(() => app.quit())
  })

  app.on('window-all-closed', () => app.quit())

  app.whenReady().then(() => {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      {
        label: 'Edit',
        submenu: [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'selectAll' },
        ],
      },
    ]))
    hub = new Hub({
      userData: app.getPath('userData'),
      broadcast,
    })
    bindIpc()
    if (process.env.CHATAPP_SMOKE === '1') hub.seedPreview()
    else hub.start()
    createWindow()
  }).catch((err) => {
    console.error('[chatapp] failed to start', err)
    app.quit()
  })
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  boot()
}
