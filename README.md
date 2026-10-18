# CNC DNC Sender (Haas & FANUC)

Send and receive G-code between VS Code and a CNC machine over RS-232 (DNC, Direct Numerical Control).

- **Haas**: XMODEM (128-byte blocks, CRC-16 or checksum, chosen by the control).
- **FANUC** and generic controls: raw text stream with XON/XOFF or RTS/CTS flow control.

> **Use at your own risk.** This extension was vibe coded: written with AI assistance and not reviewed by a
> professional CNC or serial-communications engineer. It is supplied **as is, without warranty of any kind**,
> express or implied, including merchantability and fitness for a particular purpose. The authors are not liable
> for damaged machines, crashed or lost programs, scrapped parts, or injury arising from its use. Verify every
> program and every serial setting on your own equipment, and test with a loopback or a spare program before
> sending anything to a machine you cannot afford to lose.

## Profiles

Each machine gets a named profile holding its serial port, baud rate, protocol, and timing. You can keep as many as you need.

- **Control Panel** (Command Palette → *CNC DNC Sender: Open Control Panel*): pick a profile, edit it, **New from form** to copy one, **Rename**, **Delete**, and **Make active**.
- **Active profile**: used by Send, Receive, and the keyboard shortcut.
- **Status bar**: the **CNC: <profile>** item beside **Send to CNC** shows the active profile. Click it to pick another profile. VS Code's status bar has no dropdown control, so this opens a list.
- **Send** (status bar, title-bar icon, or `Cmd+Alt+S` / `Ctrl+Alt+S`) sends the current file with the active profile.
- **Receive** (Command Palette: *CNC DNC Sender: Receive File from CNC*, or the Receive button in the Control Panel) pulls a program from the control with the active profile and asks where to save it.

Profiles are stored in `cncDnc.profiles` in your settings. Use *Save to workspace settings* in the panel to keep a profile list for one project only.

## Use

1. Connect the RS-232 cable and put the control in its receive/edit mode.
2. Open the Control Panel and select or create a profile for the machine.
3. Pick the port (press Refresh if it is missing), apply a preset if needed, and press **Save profile**.
4. Use **Test port** to confirm the port opens.
5. Pick the active profile in the status bar, open the `.nc` file, and press **Send to CNC**, the title-bar icon, `Cmd+Alt+S` / `Ctrl+Alt+S`, or the right-click menu.
6. To receive a program, press **Receive** in the Control Panel or run the Receive command, then start the send on the control. The received program opens after you choose where to save it.

The editor buffer is sent, so unsaved edits go to the machine too. A progress notification shows blocks or bytes sent and has a Cancel button. Details are logged to the **CNC DNC Sender** output channel.

## Profile fields

| Field | Default | Notes |
| --- | --- | --- |
| `port` | `""` | `/dev/cu.*` on macOS, `COMx` on Windows |
| `baudRate`, `dataBits`, `parity`, `stopBits` | 9600, 8, none, 1 | XMODEM requires 8 data bits and no parity |
| `flowControl` | `none` | `hardware` = RTS/CTS, `software` = XON/XOFF (not usable with XMODEM) |
| `dtr`, `rts` | `true` | Lines asserted when the port opens |
| `protocol` | `xmodem` | `xmodem` or `stream` |
| `lineEnding` | `asIs` | `asIs`, `LF`, `CRLF`, `CR` |
| `wrapWithPercent` | `false` | Adds `%` at the start and end if missing |
| `trailer` | `none` | Byte sent once at the end of a stream: `none`, `EOT`, `ctrlZ` |
| `charDelayMs`, `lineDelayMs` | 0 | Stream pacing for controls that drop characters |
| `receiveIdleMs` | 3000 | Stream receive ends after this much silence |
| `blockTimeoutMs`, `startTimeoutMs`, `maxRetries` | 10000, 60000, 10 | XMODEM timing and retries |

## Presets

Presets only fill the form. They are starting points, not verified values. Check each against your control's RS-232 / communication settings before relying on it.

- **Haas (XMODEM)**: 9600 8N1, no flow control, XMODEM, file sent as-is.
- **FANUC (stream, XON/XOFF)**: 9600 8N1, XON/XOFF, CR LF line endings, `%` delimiters ensured.
- **Generic XMODEM** and **Generic text stream**: the same as the Haas and FANUC presets, without machine-specific choices.

## Development

```
npm install
npm test
```

The protocol code (`src/xmodem.js`, `src/stream.js`, `src/text.js`, `src/config.js`) has no VS Code or serial dependency and is covered by the tests in `test/`. `src/serial.js` is the only module that talks to `serialport`.

## Limits

- Stream transfers have no acknowledgement, so a dropped character cannot be detected. Use XMODEM where the control supports it.
- Program numbers and memory space on the control are not checked before sending.
- Serial settings saved as flat `cncDnc.port`-style values by an earlier version may not carry over. If the first profile has the wrong port, set it in the Control Panel.
