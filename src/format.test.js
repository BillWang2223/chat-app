'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const {
  authView,
  chatKind,
  compareRows,
  contentText,
  describeCode,
  formatWhen,
  messageKey,
  personName,
  quoteSnippet,
  replyTargetError,
  topicInput,
  unpackedLibraryPath,
} = require('./format')

test('contentText reads text, media, and unknown messages', () => {
  assert.equal(contentText({ _: 'messageText', text: { _: 'formattedText', text: 'ship it?' } }), 'ship it?')
  assert.equal(contentText({ _: 'messagePhoto', caption: { text: 'look' } }), '[photo] look')
  assert.equal(contentText({ _: 'messagePhoto' }), '[photo]')
  assert.equal(contentText({ _: 'messageSticker', sticker: { emoji: '🔥' } }), '[sticker 🔥]')
  assert.equal(contentText({
    _: 'messageDocument',
    document: { file_name: 'a.pdf' },
    caption: { text: 'signed' },
  }), '[file] a.pdf — signed')
  assert.equal(contentText({ _: 'messageAnimatedEmoji', emoji: '👍' }), '👍')
  assert.equal(contentText({ _: 'messageChatJoinByLink' }), '[chat join by link]')
})

test('chatKind maps private chats, groups, and channels', () => {
  assert.equal(chatKind({ type: { _: 'chatTypePrivate' } }), 'DM')
  assert.equal(chatKind({ type: { _: 'chatTypeSecret' } }), 'DM')
  assert.equal(chatKind({ type: { _: 'chatTypeBasicGroup' } }), 'Group')
  assert.equal(chatKind({ type: { _: 'chatTypeSupergroup', is_channel: false } }), 'Group')
  assert.equal(chatKind({ type: { _: 'chatTypeSupergroup', is_channel: true } }), 'Channel')
})

test('personName prefers the visible name and username', () => {
  assert.equal(personName({
    first_name: 'Sam',
    last_name: 'Lee',
    usernames: { editable_username: 'samlee', active_usernames: ['samlee'] },
  }), 'Sam Lee (@samlee)')
  assert.equal(personName({ first_name: 'Sam', last_name: '', phone_number: '1555' }), 'Sam')
  assert.equal(personName({ first_name: '', last_name: '', phone_number: '15551212' }), '+15551212')
})

test('formatWhen uses the local clock', () => {
  const unix = Math.floor(new Date(2026, 10, 18, 22, 1, 30).getTime() / 1000)
  assert.equal(formatWhen(unix), '2026-11-18 22:01')
  assert.equal(formatWhen(Number.NaN), '')
})

test('rows sort newest first and keys stay stable', () => {
  assert.equal(messageKey('acc', -100, 42), 'acc:-100:42')
  const rows = [
    { key: 'b', date: 10 },
    { key: 'a', date: 30 },
    { key: 'c', date: 10 },
  ]
  rows.sort(compareRows)
  assert.deepEqual(rows.map((row) => row.key), ['a', 'c', 'b'])
})

test('quoteSnippet flattens and truncates', () => {
  assert.equal(quoteSnippet('  ship\nit?  '), 'ship it?')
  assert.equal(quoteSnippet('a'.repeat(20), 10), `${'a'.repeat(9)}…`)
  assert.equal(quoteSnippet('   '), '')
})

test('authView describes each login step', () => {
  assert.equal(authView({ _: 'authorizationStateReady' }).status, 'ready')
  assert.equal(authView({
    _: 'authorizationStateWaitCode',
    code_info: { type: { _: 'authenticationCodeTypeSms', length: 5 } },
  }).detail, 'Telegram sent a code by SMS. 5 digits.')
  assert.equal(authView({
    _: 'authorizationStateWaitPassword',
    password_hint: 'pet',
  }).detail, 'Enter the two-step password. Hint: pet')
  assert.equal(authView({
    _: 'authorizationStateWaitOtherDeviceConfirmation',
    link: 'tg://login?token=abc',
  }).detail, 'tg://login?token=abc')
  assert.match(describeCode(null), /login code/)
})

test('topicInput keeps the topic a reply must land in', () => {
  assert.deepEqual(topicInput({ _: 'messageTopicForum', forum_topic_id: 7 }), {
    _: 'messageTopicForum',
    forum_topic_id: 7,
  })
  assert.equal(topicInput(null), null)
  assert.equal(topicInput({ _: 'messageTopicOther' }), null)
})

test('reply failures that are about the quoted message can be retried plain', () => {
  assert.equal(replyTargetError({ code: 400, message: "Message can't be replied" }), true)
  assert.equal(replyTargetError({ code: 400, message: 'Chat not found' }), false)
  assert.equal(replyTargetError({ code: 403, message: 'Not enough rights to reply' }), false)
})

test('packaged TDLib libraries resolve outside the asar archive', () => {
  assert.equal(
    unpackedLibraryPath('C:\\app\\app.asar\\node_modules\\tdjson.dll'),
    'C:\\app\\app.asar.unpacked\\node_modules\\tdjson.dll',
  )
  assert.equal(
    unpackedLibraryPath('/app/app.asar/node_modules/libtdjson.so'),
    '/app/app.asar.unpacked/node_modules/libtdjson.so',
  )
  assert.equal(unpackedLibraryPath('/usr/lib/libtdjson.so'), '/usr/lib/libtdjson.so')
})
