# Breaker 40 CB

A 40-channel CB radio for Windows. Pick a channel, hold the mic button (or the Space bar), and talk to everyone else on that channel who is running the app.

![radio](build/icon.png)

## What's on the radio

| Control | What it does |
|---|---|
| **CHANNEL** knob | Channels 1–40, with the real CB frequencies. Drag it, scroll it, or use the arrow keys. |
| **VOLUME** | Speaker volume. |
| **SQUELCH** | Turn it all the way down to hear open-band static. Turn it up for silence between transmissions. |
| **PUSH TO TALK** | Hold to talk. Holding **Space** does the same. Like a real rig, you can't hear while you're keyed up, and the mic unkeys after 3 minutes. |
| **CH 9 / CH 19** | Jump to the emergency channel or the highway channel. |
| **SCAN** | Sweeps the band and stops on any channel where someone is talking. |
| **ROGER** | Sends a roger beep when you let go of the mic. |
| Meter | S-meter on receive, RF power on transmit. |
| Band strip | All 40 channels: green means people are listening, red means someone is talking. Click one to tune to it. |
| **SETUP** | Everything you can change. See below. |

## SETUP

Each PC keeps its own settings, and they're still there after a restart.

- **Your handle:** the name others see when you talk.
- **Saved base stations:** type an address, give it a name ("My server", "Home LAN") and click **Save to list**. Picking a station from the list connects to it straight away. **Delete** removes the selected one.
- **Base station address:** `ws://ip:port`, `wss://domain`, or just an IP (the app fills in port 7140). Click **Connect** to switch.
- **Be the base station:** run the relay on this PC, on any port.
- **Microphone / Speaker:** choose devices, or leave them on Windows default. If a chosen device is unplugged, the app falls back to the default.
- **Mic level and Mic gain:** talk normally and adjust the gain until the level bar sits in the green, below the dashed line. That's the level other people will hear.
- **Push-to-talk key:** click **Change…** and press any key. Esc cancels. Tab and Enter can't be used because they move around the window.

## How people find each other

Every copy of the app connects to one **base station** (a small relay server). Everyone using the same base-station address can hear each other.

**On the same Wi-Fi or LAN:** one person opens SETUP and ticks **Host on port 7140**. The app lists addresses such as `ws://192.168.1.20:7140`. Everyone else enters that address and clicks **Connect**. Allow the app through the Windows Firewall if Windows asks.

**Over the internet, from your own PC:** host as above, then forward TCP port 7140 on your router to that PC. Friends connect to `ws://YOUR-PUBLIC-IP:7140`.

**On your own Windows server: Breaker40-BaseStation.exe.** This is the relay as one file that needs nothing installed. Copy it to the server and double-click it. A console window opens showing the addresses people should enter, plus a line each time someone joins, leaves or changes channel. See [The base station exe](#the-base-station-exe).

**Over the internet, always on, without a Windows server:** deploy the `server/` folder to any Node host that supports WebSockets, such as Render, Railway, Fly.io or a small VPS.
- Render: create a new **Web Service** from a repo containing this project, set the root directory to `server`, the build command to `npm install`, and the start command to `npm start`. It gives you an address like `https://my-cb.onrender.com`. Everyone enters `wss://my-cb.onrender.com` in SETUP.
- On Linux, run `npm install` in the `server` folder, then `node relay.js`. It uses the same settings file, flags and typed menu as the exe.

To make that the address every new install starts with, change `server:` in `DEFAULTS` at the top of `renderer/app.js` and rebuild.

## The base station exe

`Breaker40-BaseStation.exe` listens on **port 7140** on **every network of the machine** (`0.0.0.0`) unless you change it. There are three ways to change the settings:

1. **While it's running:** type `s` and press Enter. It asks for the port (Enter keeps the current one), then lists the IP choices:
   - `0.0.0.0`: every network on the machine. This is the usual choice.
   - `127.0.0.1`: this machine only, for testing.
   - Each of the machine's own addresses, to listen on just that network.

   It saves your choices and restarts on the new settings. Other commands: `r` restarts, `i` shows the addresses again, `q` quits.
2. **The settings file:** `relay-settings.json` sits next to the exe and is created on first run:
   ```json
   { "port": 7140, "ip": "0.0.0.0" }
   ```
   Edit it and restart the exe. If the exe's folder is read-only, the file goes in `%APPDATA%\Breaker40BaseStation\` instead.
3. **Command-line flags,** handy for a shortcut or a scheduled task:
   ```powershell
   .\Breaker40-BaseStation.exe --port 7155 --ip 0.0.0.0
   .\Breaker40-BaseStation.exe --port 7155 --save    # also write it to the settings file
   ```
   The `PORT` and `HOST` environment variables work too. Flags win over environment variables, and environment variables win over the file.

If the port is taken, or the IP isn't one of the machine's own, the exe explains what's wrong and asks for new settings.

The first time it runs, Windows Firewall asks whether to allow it. Allow it on the networks people will connect from. For people outside your network, forward the port on your router to the server.

To run it with no one logged in, start it at boot with Task Scheduler ("Run whether user is logged on or not") using the flags above. With no console attached it skips the typed menu and just runs.

## Building

```powershell
npm install
npm start          # run it
npm test           # relay server checks
npm run dist       # builds dist\Breaker40-CB-Portable-1.0.0.exe and dist\Breaker40-CB-Setup-1.0.0.exe
npm run dist:relay # builds dist\Breaker40-BaseStation.exe
npm run dist:all   # all three
npm run test:exe   # checks the base station exe (build it first)
npm run server     # run a base station without the radio window
```

Notes:
- If `npm start` says Electron failed to install, unpack `%LOCALAPPDATA%\electron\Cache\...\electron-v33.4.11-win32-x64.zip` into `node_modules\electron\dist` and create `node_modules\electron\path.txt` containing `electron.exe`.
- If `npm run dist` fails with "Cannot create symbolic link", run it once from an Administrator terminal, or turn on Windows Developer Mode.

## How it works

- `main.js`: the Electron window, plus the built-in base station when you host.
- `server/server.js`: the relay. It tracks who is on which channel, passes audio only to people on the same channel, and broadcasts the band activity.
- `server/relay.js`: the stand-alone base station around it: the settings file, flags, console status and typed menu.
- `build/build-relay.js`: bundles `relay.js` with esbuild and wraps it in Node's single-executable format to make the base station exe.
- `renderer/`: the radio itself. Your voice is sent as 8 kHz mono audio, about 16 KB/s while you talk. Incoming audio goes through a band-pass filter, light distortion and static to sound like AM CB.

There is no account system or encryption. Anyone with the base-station address can listen and talk, just like real CB.
