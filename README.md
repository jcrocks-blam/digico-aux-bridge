# DiGiCo Aux Bridge

A small Windows service that lets phones and tablets control **aux mixes** on a DiGiCo SD/Quantum
console from a web page, while the engineer keeps using the **official DiGiCo iPad app**.

```
 DiGiCo console  <--OSC/UDP-->  Bridge PC  <--OSC/UDP-->  DiGiCo iPad app
                                   |
                                   +--  web page (http://bridge-pc:8080/) on any phone/tablet
```

- The console allows only one "DiGiCo iPad" device. The bridge takes that slot and passes the iPad app's
  traffic through unchanged, so the iPad app works as normal.
- The web page shows every input channel with a fader for its send to an aux. Names come from the console.
- Each phone picks its aux (or is locked to one with a link like `/?aux=3`), and can hide channels it doesn't need.
- Any number of phones can open the page; they all stay in sync with each other, the iPad and the desk.
- Web users can only change aux send levels, and only on the auxes you allow. Nothing else on the console is reachable from the page.

No Node.js or anything else is needed on the bridge PC: it runs as a single `DigicoAuxBridge.exe`.

---

## 1. Get the .exe

**Easiest:** download `DigicoAuxBridge-windows.zip` from this repository's **Releases** page and unzip it on the
bridge PC. GitHub builds and tests it on Windows automatically (see `.github/workflows/build.yml`).

**Or build it yourself** on any Windows PC with internet:

1. Install **Node.js 22 or 24 LTS** from nodejs.org.
2. Double-click `build-exe.bat` (or run `node build\build.js --exe`).
3. The finished app is in `dist\DigicoAuxBridge\`: `DigicoAuxBridge.exe`, `config.json`, the install scripts and this README.

Copy that folder to the bridge PC, e.g. `C:\DigicoAuxBridge\`.

## 2. Configure `config.json`

| Setting | Meaning |
|---|---|
| `console.ip` | The console's IP (shown at the bottom of Setup > External Control). |
| `console.sendPort` | Must equal the **Send** port in the console's External Control entry for the bridge. The bridge listens here. |
| `console.receivePort` | Must equal the **Rcv** port in that entry. The bridge sends here. |
| `ipad.enabled` | `true` to proxy the official iPad app through the bridge. |
| `ipad.ip` | `"auto"` (learn it from the first packet) or the iPad's fixed IP. With a fixed IP, packets from anything else are ignored. |
| `ipad.sendPort` | The port the iPad app **sends** to. The bridge listens here. |
| `ipad.receivePort` | The port the iPad app **receives** on. The bridge sends here. |
| `aux` | The aux a phone opens on the first time (1, 2, 3 ...). |
| `auxes` | Which auxes phones may pick: `"auto"` = every aux on the console, or a list like `"1-6, 9"`. The bridge refuses anything else. |
| `inputCount` | `"auto"` asks the console, or a number to override. |
| `web.port` | Web page port (default 8080). |
| `web.pin` | Optional PIN people must enter before they can use the page. `""` = no PIN. |
| `web.title` | Optional browser tab title. |
| `levels.min` / `levels.max` | Send level range in dB (DiGiCo: -150 to +10). |
| `paths.*` | OSC address templates. See "Checking the OSC paths" below. |
| `sync.*` | Query rate, heartbeat and timeout. The defaults are fine. |
| `log.oscToStdout` | Print every OSC message to the log (very chatty; for setup only). |

Keep the console-side ports and the iPad-side ports different from each other (defaults: 8000/8001 and 9000/9001).

## 3. Install the service

On the bridge PC, open **PowerShell as Administrator** in the folder and run:

```
powershell -ExecutionPolicy Bypass -File .\install.ps1 -DisableSleep
```

This downloads the WinSW service wrapper (or uses `WinSW-x64.exe` if you put it in the folder), installs and starts
the **DiGiCo Aux Bridge** service (automatic start, restarts on crash), opens the firewall for the OSC and web ports,
and with `-DisableSleep` stops the PC sleeping on AC power. It prints the mixer page addresses when it's done.

After editing `config.json`, restart the service (`Restart-Service DigicoAuxBridge`). If you changed ports, re-run
`install.ps1` so the firewall rules follow.

Remove everything with `uninstall.ps1`. Logs are in the `logs` folder.

**Also:** give the PC a static IP on the console's subnet, use wired Ethernet, and in Device Manager untick
"Allow the computer to turn off this device" for the network adapter.

## 4. Set up the console

On the console: **Setup > External Control**

1. Set **Enable External Control** to **Yes**, and turn on **Suppress OSC retransmit**.
2. Load the **iPad** command set if the console asks.
3. **Add device > DiGiCo iPad**. IP address = the **bridge PC's** IP. Send / Rcv ports = `console.sendPort` / `console.receivePort`.
4. Enable the device (green tick). Remove or disable any other DiGiCo iPad entry: only one can be active.

These settings are global to the desk, not part of the session.

## 5. Set up the iPad app

In the DiGiCo app's connection settings, enter the **bridge PC's IP** instead of the console's, with ports matching
`ipad.sendPort` (app sends) and `ipad.receivePort` (app receives). The app behaves as if it were talking to the desk.

## 6. Use it

Open `http://<bridge-pc-ip>:8080/` on a phone and add it to the home screen.

- Drag a fader sideways. It moves relative to where it is, so a stray tap never jumps a level. Vertical swipes scroll.
- **−/+** step 1 dB. Below −60 dB a step goes to off (−∞), and + from off goes to −60.
- **Tap the aux name** at the top to switch aux. The phone remembers its choice.
- **Locked links:** `http://<bridge-pc-ip>:8080/?aux=3` opens straight on aux 3 with the picker hidden. Handy for
  giving each performer their own link or QR code. (It's a convenience, not security: they could edit the link.
  Use `auxes` in config.json to limit what's reachable at all.)
- **Edit** lets each phone hide channels it doesn't need: tap channels to show/hide them, or use Show all, Hide all
  or Hide unused (hides channels whose send is off). Hidden channels are remembered per phone and per aux.
- **Find channel** filters by name or number. **In mix** temporarily hides channels whose send is off.
- The pill top right shows **Live**, **Console offline** or **Offline** (phone lost the bridge).

The **status page** (`http://<bridge-pc-ip>:8080/status`) shows the console, iPad and web connections, and can capture
live OSC traffic.

---

## First time on a real desk: checklist

The OSC addresses come from community reverse-engineering of the iPad protocol (they match both the
Bitfocus Companion DiGiCo module and the DigiControl project), but nobody has confirmed them on *your* console and
software version yet. Allow 15 minutes:

1. Start with the service stopped (`net stop DigicoAuxBridge`) and run `run-foreground.bat`. Every OSC message is printed.
2. Check the console connects: the window shows `[console] connected` and `[console] NN input channels`.
   If not: IP, ports, the device's green tick, and the Windows firewall.
3. Connect the iPad app to the bridge. You should see `[ipad] iPad app seen at ...` and the app should load normally.
4. **Checking the OSC paths:** on the iPad, move an input's send to your aux. The `ipad>console` line shows the exact
   address, e.g. `/Input_Channels/3/Aux_Send/1/send_level -12.5`. Compare with `paths.sendLevel` in config.json
   (`{ch}` and `{aux}` are placeholders). Do the same for a channel name. Fix the templates if they differ.
   Also check the status page shows the right number of auxes (`paths.auxCount`) and their names (`paths.auxName`).
5. **Level format:** the number after the address should be in dB (−150 to +10). If it's 0–1 instead, set
   `levels.min` to 0 and `levels.max` to 1 and tell me, so the fader taper can be changed to match.
6. Move a fader on the web page: the desk and the iPad should follow. Move a send on the desk: the page should follow.
7. **Echo behaviour:** watch whether the console sends your web changes back (`console>bridge` right after `web>console`).
   Either way works; the bridge handles both. If the iPad shows a change twice or jitters, tell me what you see.
8. Close the window, `net start DigicoAuxBridge`, done.

## Troubleshooting

| Symptom | Check |
|---|---|
| Status page says console "No reply" | Console IP and ports in config.json vs the External Control entry; device enabled; firewall rule exists; PC on the console's subnet. |
| iPad app won't connect | The app must point at the bridge PC's IP; `ipad.sendPort`/`receivePort` must match the app; `ipad.ip` is `"auto"` or the iPad's actual IP. |
| Service won't start | Run `run-foreground.bat` to see the error. "EADDRINUSE" means another program (Companion?) uses that port. |
| Faders show "—" | The console hasn't answered that channel yet. Press **Re-sync from console** on the status page. |
| Phones can't open the page | Same network as the PC? Firewall rule for the web port? Try `http://<ip>:8080/healthz`. |

---

## Making a release

Push a version tag and GitHub builds the .exe and publishes a Release with the zip attached:

```
git tag v1.0.1
git push origin v1.0.1
```

Every push to `main` also builds and tests it; the zip is under the run's **Artifacts** in the Actions tab.

## Development

Needs Node 22+. No npm packages are used.

```
node tools/simulator.js --surface        # fake Quantum on UDP 8000 -> replies to 8001
node src/main.js                         # bridge (writes a default config.json on first run)
node tools/test-e2e.js                   # end-to-end test: simulator + bridge + fake iPad + web clients
node build/build.js                      # bundle only -> dist/DigicoAuxBridge/aux-bridge.js
```

Simulator options: `--channels 48 --auxes 16 --echo` (echo changes back, like retransmit suppression off),
`--surface` (moves a random aux 1 send every 4 s, like an engineer on the desk).

Source: `src/bridge.js` (proxy, state, sync, echo handling), `src/web.js` (HTTP + WebSocket),
`src/osc.js` and `src/ws.js` (dependency-free OSC and WebSocket), `src/web/` (mixer and status pages).
