'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('chatapp', {
  getState: () => ipcRenderer.invoke('get-state'),
  saveConfig: (input) => ipcRenderer.invoke('save-config', input),
  addAccount: (input) => ipcRenderer.invoke('add-account', input),
  submitCode: (input) => ipcRenderer.invoke('submit-code', input),
  submitPassword: (input) => ipcRenderer.invoke('submit-password', input),
  submitEmail: (input) => ipcRenderer.invoke('submit-email', input),
  submitEmailCode: (input) => ipcRenderer.invoke('submit-email-code', input),
  submitName: (input) => ipcRenderer.invoke('submit-name', input),
  sendLoginCode: (accountId) => ipcRenderer.invoke('send-login-code', accountId),
  removeAccount: (accountId) => ipcRenderer.invoke('remove-account', accountId),
  sendReply: (input) => ipcRenderer.invoke('send-reply', input),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  onState: (callback) => {
    const listener = (_event, state) => callback(state)
    ipcRenderer.on('state', listener)
    return () => ipcRenderer.removeListener('state', listener)
  },
})
