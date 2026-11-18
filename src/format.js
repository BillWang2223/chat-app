'use strict'

function textOf(value) {
  if (!value) return ''
  if (typeof value === 'string') return value
  if (typeof value.text === 'string') return value.text
  return ''
}

function fallbackLabel(type) {
  const raw = String(type || 'message').replace(/^message/, '')
  const spaced = raw.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase()
  return `[${spaced || 'message'}]`
}

function contentText(content) {
  if (!content || typeof content !== 'object') return ''
  const caption = textOf(content.caption)
  switch (content._) {
    case 'messageText':
      return textOf(content.text)
    case 'messagePhoto':
      return caption ? `[photo] ${caption}` : '[photo]'
    case 'messageVideo':
      return caption ? `[video] ${caption}` : '[video]'
    case 'messageAnimation':
      return caption ? `[gif] ${caption}` : '[gif]'
    case 'messageDocument': {
      const name = content.document?.file_name || 'file'
      return caption ? `[file] ${name} — ${caption}` : `[file] ${name}`
    }
    case 'messageAudio': {
      const name = content.audio?.title || content.audio?.file_name || 'audio'
      return caption ? `[audio] ${name} — ${caption}` : `[audio] ${name}`
    }
    case 'messageVoiceNote':
      return caption ? `[voice] ${caption}` : '[voice]'
    case 'messageVideoNote':
      return '[video note]'
    case 'messageSticker':
      return content.sticker?.emoji ? `[sticker ${content.sticker.emoji}]` : '[sticker]'
    case 'messageAnimatedEmoji':
      return content.emoji || '[emoji]'
    case 'messageDice':
      return content.emoji ? `[dice ${content.emoji}]` : '[dice]'
    case 'messagePoll': {
      const question = textOf(content.poll?.question)
      return question ? `[poll] ${question}` : '[poll]'
    }
    case 'messageContact': {
      const contact = content.contact || {}
      const name = [contact.first_name, contact.last_name].filter(Boolean).join(' ')
      return name ? `[contact] ${name}` : '[contact]'
    }
    case 'messageLocation':
      return '[location]'
    case 'messageVenue':
      return content.venue?.title ? `[location] ${content.venue.title}` : '[location]'
    case 'messageGame':
      return content.game?.title ? `[game] ${content.game.title}` : '[game]'
    default:
      return fallbackLabel(content._)
  }
}

function chatKind(chat) {
  const type = chat?.type?._
  if (type === 'chatTypePrivate' || type === 'chatTypeSecret') return 'DM'
  if (type === 'chatTypeBasicGroup') return 'Group'
  if (type === 'chatTypeSupergroup') return chat.type.is_channel ? 'Channel' : 'Group'
  return 'Group'
}

function personName(user) {
  if (!user) return ''
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ').trim()
  const handle = user.usernames?.editable_username || user.usernames?.active_usernames?.[0] || ''
  if (name && handle) return `${name} (@${handle})`
  if (name) return name
  if (handle) return `@${handle}`
  if (user.phone_number) return `+${user.phone_number}`
  if (user.id != null) return `user ${user.id}`
  return ''
}

function formatWhen(unixSeconds) {
  const date = new Date(Number(unixSeconds) * 1000)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function messageKey(accountId, chatId, messageId) {
  return `${accountId}:${chatId}:${messageId}`
}

function compareRows(a, b) {
  const left = Number(a.date) || 0
  const right = Number(b.date) || 0
  if (left !== right) return right - left
  if (a.key < b.key) return 1
  if (a.key > b.key) return -1
  return 0
}

function quoteSnippet(text, max = 140) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim()
  if (!flat) return ''
  if (flat.length <= max) return flat
  return `${flat.slice(0, max - 1)}…`
}

function describeCode(codeInfo) {
  const type = codeInfo?.type?._ || ''
  const labels = {
    authenticationCodeTypeTelegramMessage: 'Telegram sent a code to your other devices',
    authenticationCodeTypeSms: 'Telegram sent a code by SMS',
    authenticationCodeTypeCall: 'Telegram will call you with the code',
    authenticationCodeTypeFlashCall: 'Telegram will flash-call you with the code',
    authenticationCodeTypeMissedCall: 'The code is the last digits of a missed call',
    authenticationCodeTypeFragment: 'Telegram sent a code through Fragment',
    authenticationCodeTypeFirebaseAndroid: 'Telegram sent a code to this device',
    authenticationCodeTypeFirebaseIos: 'Telegram sent a code to this device',
  }
  const base = labels[type] || 'Enter the login code'
  const length = codeInfo?.type?.length
  return length ? `${base}. ${length} digits.` : `${base}.`
}

function authView(state) {
  const kind = state?._ || ''
  switch (kind) {
    case 'authorizationStateWaitTdlibParameters':
      return { status: 'connecting', detail: 'Starting Telegram.' }
    case 'authorizationStateWaitPhoneNumber':
      return { status: 'wait_phone', detail: 'Send a login code to this phone.' }
    case 'authorizationStateWaitCode':
      return { status: 'wait_code', detail: describeCode(state.code_info) }
    case 'authorizationStateWaitPassword':
      return {
        status: 'wait_password',
        detail: state.password_hint
          ? `Enter the two-step password. Hint: ${state.password_hint}`
          : 'Enter the two-step password.',
      }
    case 'authorizationStateWaitEmailAddress':
      return { status: 'wait_email', detail: 'Telegram wants an email address for this login.' }
    case 'authorizationStateWaitEmailCode': {
      const pattern = state.code_info?.email_address_pattern
      const length = state.code_info?.length
      const bits = ['Enter the email code']
      if (pattern) bits.push(`sent to ${pattern}`)
      if (length) bits.push(`${length} characters`)
      return { status: 'wait_email_code', detail: `${bits.join(', ')}.` }
    }
    case 'authorizationStateWaitOtherDeviceConfirmation':
      return { status: 'wait_other_device', detail: state.link || '' }
    case 'authorizationStateWaitRegistration': {
      const terms = textOf(state.terms_of_service?.text)
      const excerpt = terms ? ` ${terms.slice(0, 280)}` : ''
      return {
        status: 'wait_name',
        detail: `This phone is not registered yet. Enter a name to create the account.${excerpt}`,
      }
    }
    case 'authorizationStateWaitPremiumPurchase':
      return {
        status: 'error',
        detail: 'Telegram is asking for a Premium purchase before this login can continue.',
      }
    case 'authorizationStateReady':
      return { status: 'ready', detail: '' }
    case 'authorizationStateLoggingOut':
      return { status: 'connecting', detail: 'Logging out.' }
    case 'authorizationStateClosing':
      return { status: 'closed', detail: 'Closing.' }
    case 'authorizationStateClosed':
      return { status: 'closed', detail: '' }
    default:
      return { status: 'error', detail: kind ? `Unsupported login step: ${kind}` : 'Unknown authorization state' }
  }
}

function topicInput(topic) {
  if (!topic || typeof topic !== 'object') return null
  switch (topic._) {
    case 'messageTopicForum':
      return { _: 'messageTopicForum', forum_topic_id: topic.forum_topic_id }
    case 'messageTopicThread':
      return { _: 'messageTopicThread', message_thread_id: topic.message_thread_id }
    case 'messageTopicDirectMessages':
      return { _: 'messageTopicDirectMessages', direct_messages_chat_topic_id: topic.direct_messages_chat_topic_id }
    case 'messageTopicSavedMessages':
      return { _: 'messageTopicSavedMessages', saved_messages_topic_id: topic.saved_messages_topic_id }
    default:
      return null
  }
}

function unpackedLibraryPath(resolved) {
  return String(resolved).replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')
}

function replyTargetError(err) {
  return Number(err?.code) === 400 && /repl/i.test(String(err?.message || ''))
}

module.exports = {
  contentText,
  chatKind,
  personName,
  formatWhen,
  messageKey,
  compareRows,
  quoteSnippet,
  describeCode,
  authView,
  topicInput,
  unpackedLibraryPath,
  replyTargetError,
}
