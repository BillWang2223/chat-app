# Chatapp 0.1.0

Windows inbox for several of your own Telegram accounts. One window has two pages:

- **Chat** lists every direct message, group, and channel, incoming and outgoing. Each row shows Account, Type, Chat, From, DateTime, Content, and Reply. Reply opens inside that row. Send posts one text from that row's account into that row's chat, then that Reply button stays disabled.
- **Settings** stores one Telegram API ID and API hash, then adds or removes accounts.

The built program is `dist/Chatapp-0.1.0-windows.exe`. Copy it to a 64-bit Windows PC and open it. Node.js is not required to run that file. Windows may warn that it is unsigned the first time.

Logins are stored in `%APPDATA%\Chatapp`. Replacing the exe does not log the accounts out. Telegram lists this session as **Chatapp**.

## Sign in

1. Open https://my.telegram.org and log in with any of your Telegram accounts.
2. Open https://my.telegram.org/apps. If the page says "Too many attempts", stop and try again later, or create the application from a different Telegram account. One application covers every phone number.
3. Create a **Desktop** application. The URL can stay empty. Do not put the word "Telegram" in the title or short name.
4. Copy **App api_id** and **App api_hash** into Chatapp → Settings → Save.
5. Add each account with a label and a phone number that includes the country code, such as `+15551234567`. Enter the login code, then the two-step password if Telegram asks for one.

## Build

Rebuild only when the code changes. On 64-bit Windows, install Node.js 22 or newer, then from this folder:

```bat
npm install
npm start
```

`npm start` opens the app. `npm install` downloads the Windows Telegram library. A C++ compiler is not required.

To produce the exe:

```bat
npm run pack:win
```

The result is `dist\Chatapp-0.1.0-windows.exe`.

`npm test` runs the local checks and does not contact Telegram.
