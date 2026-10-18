'use strict';

const crypto = require('crypto');
const vscode = require('vscode');
const config = require('./config');
const { listPorts, testPort } = require('./serial');

const { MACHINE_PROFILES, BAUD_RATES, DATA_BITS, PARITIES, STOP_BITS, FLOW_CONTROL, PROTOCOLS, LINE_ENDINGS, TRAILERS } = config;

// Form layout. Keys must match config.DEFAULTS. The webview renders from this list.
const SECTIONS = [
    {
        title: 'Connection',
        fields: [
            {
                key: 'port', label: 'Serial port', kind: 'port',
                hint: 'Pick a detected port or type one. On macOS prefer /dev/cu.* (callout); /dev/tty.* can block on open waiting for carrier detect.',
            },
            { key: 'baudRate', label: 'Baud rate', kind: 'select', options: BAUD_RATES },
            { key: 'dataBits', label: 'Data bits', kind: 'select', options: DATA_BITS },
            { key: 'parity', label: 'Parity', kind: 'select', options: PARITIES },
            { key: 'stopBits', label: 'Stop bits', kind: 'select', options: STOP_BITS },
            {
                key: 'flowControl', label: 'Flow control', kind: 'select', options: FLOW_CONTROL,
                labels: { none: 'None', hardware: 'Hardware (RTS/CTS)', software: 'Software (XON/XOFF)' },
            },
            { key: 'dtr', label: 'Assert DTR', kind: 'bool' },
            { key: 'rts', label: 'Assert RTS', kind: 'bool' },
        ],
    },
    {
        title: 'Transfer',
        fields: [
            {
                key: 'protocol', label: 'Protocol', kind: 'select', options: PROTOCOLS,
                labels: { xmodem: 'XMODEM (128-byte blocks, ACK/NAK)', stream: 'Stream (raw text, no framing)' },
            },
            {
                key: 'lineEnding', label: 'Line endings', kind: 'select', options: LINE_ENDINGS,
                labels: { asIs: 'Keep as in file', LF: 'LF', CRLF: 'CR LF', CR: 'CR' },
            },
            { key: 'wrapWithPercent', label: 'Ensure % at start and end', kind: 'bool' },
            {
                key: 'trailer', label: 'End-of-text byte', kind: 'select', options: TRAILERS,
                labels: { none: 'None', EOT: 'EOT (0x04)', ctrlZ: 'Ctrl-Z (0x1A)' },
            },
            { key: 'charDelayMs', label: 'Stream: delay per character (ms)', kind: 'number' },
            { key: 'lineDelayMs', label: 'Stream: delay per line (ms)', kind: 'number' },
            { key: 'receiveIdleMs', label: 'Stream receive: end after silence (ms)', kind: 'number' },
            { key: 'blockTimeoutMs', label: 'XMODEM: block timeout (ms)', kind: 'number' },
            { key: 'startTimeoutMs', label: 'XMODEM: start timeout (ms)', kind: 'number' },
            { key: 'maxRetries', label: 'XMODEM: retries per block', kind: 'number' },
        ],
    },
];

function getHtml(webview, nonce) {
    const data = JSON.stringify({
        sections: SECTIONS,
        presets: Object.entries(MACHINE_PROFILES).map(([id, p]) => ({ id, label: p.label, settings: p.settings })),
    }).replace(/</g, '\\u003c');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>CNC DNC Sender</title>
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 12px 20px; max-width: 760px; }
  h2 { font-size: 1.1em; margin: 20px 0 8px; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 4px; }
  .row { display: grid; grid-template-columns: 260px 1fr; gap: 8px; align-items: center; margin: 6px 0; }
  .hint { grid-column: 2; font-size: 0.85em; opacity: 0.75; margin-top: -2px; }
  input[type=text], input[type=number], select {
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent); padding: 4px 6px; width: 100%; box-sizing: border-box;
  }
  .line { display: flex; gap: 6px; }
  button {
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border: none; padding: 5px 12px; cursor: pointer;
  }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button:disabled { opacity: 0.5; cursor: default; }
  .toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 12px; }
  #status { margin-top: 12px; padding: 8px; white-space: pre-wrap; display: none; }
  #status.ok { display: block; border-left: 3px solid var(--vscode-testing-iconPassed); }
  #status.error { display: block; border-left: 3px solid var(--vscode-errorForeground); }
  .note { font-size: 0.85em; opacity: 0.8; margin-top: 6px; }
</style>
</head>
<body>
<h1 style="font-size:1.3em;margin:0 0 4px">CNC DNC Sender</h1>
<div class="note">One profile per machine. The active profile is used by the keyboard shortcut and the status bar.</div>

<h2>Profiles</h2>
<div class="row">
  <label for="profileSelect">Profile</label>
  <div class="line">
    <select id="profileSelect"></select>
    <button id="makeActive" class="secondary">Make active</button>
  </div>
  <div class="hint" id="profileHint"></div>
</div>
<div class="toolbar">
  <button id="newProfile" class="secondary">New from form</button>
  <button id="renameProfile" class="secondary">Rename</button>
  <button id="deleteProfile" class="secondary">Delete</button>
</div>

<h2>Preset</h2>
<div class="row">
  <label for="preset">Start the form from</label>
  <div class="line">
    <select id="preset"></select>
    <button id="applyPreset" class="secondary">Apply to form</button>
  </div>
  <div class="hint">Fills the settings below with typical values for a control type. Nothing is saved until you press Save.</div>
</div>

<div id="sections"></div>

<div class="toolbar">
  <label><input type="checkbox" id="toWorkspace"> Save to workspace settings (otherwise user settings)</label>
</div>
<div class="toolbar">
  <button id="save">Save profile</button>
  <button id="test" class="secondary">Test port</button>
  <button id="send" class="secondary">Send current file with this profile</button>
  <button id="receive" class="secondary">Receive file from CNC</button>
</div>
<div class="note">Send and receive use the saved version of the profile. Save first if you changed anything. To receive, start the send on the control after pressing Receive.</div>
<div id="status"></div>

<datalist id="portList"></datalist>

<script nonce="${nonce}">
const DATA = ${data};
const vscode = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);
const state = { profiles: [], activeProfile: '', selected: '' };

function profileNamed(name) {
  return state.profiles.find((p) => p.name === name);
}

function buildForm() {
  const container = $('sections');
  for (const section of DATA.sections) {
    const h = document.createElement('h2');
    h.textContent = section.title;
    container.appendChild(h);
    for (const field of section.fields) {
      const row = document.createElement('div');
      row.className = 'row';
      const label = document.createElement('label');
      label.htmlFor = 'f-' + field.key;
      label.textContent = field.label;
      row.appendChild(label);

      let input;
      if (field.kind === 'port') {
        const line = document.createElement('div');
        line.className = 'line';
        input = document.createElement('input');
        input.type = 'text';
        input.setAttribute('list', 'portList');
        input.placeholder = '/dev/cu.usbserial-XXXX or COM3';
        const refresh = document.createElement('button');
        refresh.className = 'secondary';
        refresh.textContent = 'Refresh';
        refresh.onclick = () => vscode.postMessage({ type: 'refreshPorts' });
        line.appendChild(input);
        line.appendChild(refresh);
        row.appendChild(line);
      } else if (field.kind === 'select') {
        input = document.createElement('select');
        for (const opt of field.options) {
          const o = document.createElement('option');
          o.value = String(opt);
          o.textContent = (field.labels && field.labels[opt]) || String(opt);
          input.appendChild(o);
        }
        row.appendChild(input);
      } else if (field.kind === 'bool') {
        input = document.createElement('input');
        input.type = 'checkbox';
        row.appendChild(input);
      } else {
        input = document.createElement('input');
        input.type = 'number';
        input.min = '0';
        row.appendChild(input);
      }
      input.id = 'f-' + field.key;
      input.dataset.key = field.key;
      container.appendChild(row);

      if (field.hint) {
        const hint = document.createElement('div');
        hint.className = 'hint';
        hint.textContent = field.hint;
        container.appendChild(hint);
      }
    }
  }

  for (const p of DATA.presets) {
    const o = document.createElement('option');
    o.value = p.id;
    o.textContent = p.label;
    $('preset').appendChild(o);
  }
}

function fillForm(settings) {
  for (const section of DATA.sections) {
    for (const field of section.fields) {
      const input = $('f-' + field.key);
      if (!input || settings[field.key] === undefined) continue;
      const value = settings[field.key];
      if (field.kind === 'bool') {
        input.checked = !!value;
      } else if (field.kind === 'select') {
        const str = String(value);
        if (![...input.options].some((o) => o.value === str)) {
          const o = document.createElement('option');
          o.value = str;
          o.textContent = str;
          input.appendChild(o);
        }
        input.value = str;
      } else {
        input.value = value;
      }
    }
  }
}

function readForm() {
  const settings = {};
  for (const section of DATA.sections) {
    for (const field of section.fields) {
      const input = $('f-' + field.key);
      if (field.kind === 'bool') settings[field.key] = input.checked;
      else if (field.kind === 'number') settings[field.key] = Number(input.value);
      else if (field.kind === 'port') settings[field.key] = input.value.trim();
      else settings[field.key] = input.value;
    }
  }
  return settings;
}

function setStatus(kind, text) {
  const s = $('status');
  s.className = kind;
  s.textContent = text;
}

function setPorts(ports) {
  const list = $('portList');
  list.innerHTML = '';
  for (const p of ports) {
    const o = document.createElement('option');
    o.value = p.path;
    o.label = p.description || '';
    list.appendChild(o);
  }
}

function renderProfiles() {
  const select = $('profileSelect');
  select.innerHTML = '';
  for (const p of state.profiles) {
    const o = document.createElement('option');
    o.value = p.name;
    o.textContent = p.name + (p.name === state.activeProfile ? '  (active)' : '');
    select.appendChild(o);
  }
  select.value = state.selected;
  const isActive = state.selected === state.activeProfile;
  $('makeActive').disabled = isActive;
  $('profileHint').textContent = isActive
    ? 'This is the active profile.'
    : 'Active profile is "' + state.activeProfile + '". Make this one active to use it for the keyboard shortcut.';
}

function loadSelected() {
  const profile = profileNamed(state.selected);
  if (profile) fillForm(profile);
  renderProfiles();
}

function save(type, extra) {
  vscode.postMessage(Object.assign({ type, workspace: $('toWorkspace').checked }, extra || {}));
}

$('profileSelect').onchange = (e) => {
  state.selected = e.target.value;
  loadSelected();
};
$('makeActive').onclick = () => save('setActive', { name: state.selected });
$('newProfile').onclick = () => save('newProfile', { settings: readForm() });
$('renameProfile').onclick = () => save('renameProfile', { name: state.selected });
$('deleteProfile').onclick = () => save('deleteProfile', { name: state.selected });

$('applyPreset').onclick = () => {
  const preset = DATA.presets.find((p) => p.id === $('preset').value);
  if (preset) {
    fillForm(preset.settings);
    setStatus('ok', 'Applied preset "' + preset.label + '" to the form. Press Save profile to keep it.');
  }
};

$('save').onclick = () => save('save', { name: state.selected, settings: readForm() });
$('test').onclick = () => vscode.postMessage({ type: 'test', settings: readForm() });
$('send').onclick = () => vscode.postMessage({ type: 'send', name: state.selected });
$('receive').onclick = () => vscode.postMessage({ type: 'receive', name: state.selected });

window.addEventListener('message', (event) => {
  const msg = event.data;
  switch (msg.type) {
    case 'state':
      state.profiles = msg.profiles;
      state.activeProfile = msg.activeProfile;
      if (!profileNamed(state.selected)) state.selected = msg.selected || msg.activeProfile || (msg.profiles[0] && msg.profiles[0].name) || '';
      if (msg.selected) state.selected = msg.selected;
      setPorts(msg.ports);
      $('toWorkspace').checked = msg.hasWorkspace;
      $('toWorkspace').disabled = !msg.hasWorkspace;
      loadSelected();
      if (msg.warning) setStatus('error', msg.warning);
      break;
    case 'ports':
      setPorts(msg.ports);
      setStatus('ok', msg.ports.length ? msg.ports.length + ' port(s) detected.' : 'No serial ports detected.');
      break;
    case 'status':
      setStatus(msg.kind, msg.text);
      break;
  }
});

buildForm();
vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}

class ControlPanel {
    static show(context, output) {
        if (ControlPanel.current) {
            ControlPanel.current.panel.reveal();
            return;
        }
        const panel = vscode.window.createWebviewPanel(
            'cncDnc.controlPanel',
            'CNC DNC Sender: Control Panel',
            vscode.ViewColumn.Active,
            { enableScripts: true, retainContextWhenHidden: true },
        );
        ControlPanel.current = new ControlPanel(panel, output);
        context.subscriptions.push(ControlPanel.current);
    }

    constructor(panel, output) {
        this.panel = panel;
        this.output = output;
        this.panel.webview.html = getHtml(panel.webview, crypto.randomBytes(16).toString('base64'));
        this.subscription = panel.webview.onDidReceiveMessage((msg) => this.onMessage(msg));
        panel.onDidDispose(() => this.dispose());
    }

    dispose() {
        if (ControlPanel.current === this) ControlPanel.current = undefined;
        this.subscription.dispose();
    }

    configuration() {
        return vscode.workspace.getConfiguration('cncDnc');
    }

    loadState() {
        const cfg = this.configuration();
        return config.loadState((key) => cfg.get(key));
    }

    /** Save the profile list and active name in one place. Returns the target that was written. */
    async writeState(profiles, activeProfile, toWorkspace) {
        const target = this.target(toWorkspace);
        const cfg = this.configuration();
        await cfg.update('profiles', profiles, target);
        await cfg.update('activeProfile', activeProfile, target);
        return target;
    }

    target(toWorkspace) {
        const hasWorkspace = !!(vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length);
        return toWorkspace && hasWorkspace ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    }

    async postState(extra = {}) {
        let ports = [];
        let warning;
        try {
            ports = await listPorts();
        } catch (err) {
            warning = 'Could not list serial ports: ' + err.message;
        }
        const { profiles, activeProfile } = this.loadState();
        this.panel.webview.postMessage({
            type: 'state',
            profiles,
            activeProfile: activeProfile || (profiles[0] && profiles[0].name) || '',
            selected: extra.selected,
            ports,
            hasWorkspace: !!(vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length),
            warning: warning || extra.warning,
        });
    }

    status(kind, text) {
        this.panel.webview.postMessage({ type: 'status', kind, text });
    }

    async onMessage(msg) {
        try {
            switch (msg.type) {
                case 'ready':
                    return this.postState();
                case 'refreshPorts': {
                    const ports = await listPorts();
                    return this.panel.webview.postMessage({ type: 'ports', ports });
                }
                case 'save':
                    return this.save(msg);
                case 'newProfile':
                    return this.newProfile(msg);
                case 'renameProfile':
                    return this.renameProfile(msg);
                case 'deleteProfile':
                    return this.deleteProfile(msg);
                case 'setActive':
                    return this.setActive(msg);
                case 'test':
                    return this.test(msg.settings);
                case 'send':
                    return vscode.commands.executeCommand('cncDnc.sendProgram', msg.name);
                case 'receive':
                    return vscode.commands.executeCommand('cncDnc.receiveProgram', msg.name);
            }
        } catch (err) {
            this.status('error', err.message);
        }
    }

    async save(msg) {
        const settings = config.fromObject(msg.settings);
        const problems = config.validate(settings, { requirePort: false });
        if (problems.length) {
            return this.status('error', 'Not saved:\n' + problems.join('\n'));
        }
        const { profiles, activeProfile } = this.loadState();
        const index = profiles.findIndex((p) => p.name === msg.name);
        if (index < 0) return this.status('error', `Profile "${msg.name}" no longer exists.`);

        profiles[index] = { name: msg.name, ...settings };
        const target = await this.writeState(profiles, activeProfile, msg.workspace);
        this.status('ok', `Saved profile "${msg.name}" to ${this.scopeName(target)} settings.`);
        return this.postState({ selected: msg.name });
    }

    async newProfile(msg) {
        const settings = config.fromObject(msg.settings);
        const { profiles, activeProfile } = this.loadState();
        const name = await vscode.window.showInputBox({
            title: 'New profile',
            prompt: 'Name for the new profile (for example the machine name)',
            value: 'New profile',
            validateInput: (value) => config.validateProfileName(value, profiles),
        });
        if (name === undefined) return;

        const trimmed = name.trim();
        profiles.push({ name: trimmed, ...settings });
        await this.writeState(profiles, activeProfile || profiles[0].name, msg.workspace);
        this.status('ok', `Created profile "${trimmed}" from the form.`);
        return this.postState({ selected: trimmed });
    }

    async renameProfile(msg) {
        const { profiles, activeProfile } = this.loadState();
        const profile = profiles.find((p) => p.name === msg.name);
        if (!profile) return this.status('error', `Profile "${msg.name}" no longer exists.`);

        const name = await vscode.window.showInputBox({
            title: 'Rename profile',
            prompt: `New name for "${msg.name}"`,
            value: msg.name,
            validateInput: (value) => config.validateProfileName(value, profiles, msg.name),
        });
        if (name === undefined) return;

        const trimmed = name.trim();
        profile.name = trimmed;
        const newActive = activeProfile === msg.name ? trimmed : activeProfile;
        await this.writeState(profiles, newActive, msg.workspace);
        this.status('ok', `Renamed to "${trimmed}".`);
        return this.postState({ selected: trimmed });
    }

    async deleteProfile(msg) {
        const { profiles, activeProfile } = this.loadState();
        if (profiles.length <= 1) {
            return this.status('error', 'At least one profile must remain.');
        }
        const choice = await vscode.window.showWarningMessage(
            `Delete profile "${msg.name}"?`,
            { modal: true },
            'Delete',
        );
        if (choice !== 'Delete') return;

        const remaining = profiles.filter((p) => p.name !== msg.name);
        const newActive = activeProfile === msg.name ? remaining[0].name : activeProfile;
        await this.writeState(remaining, newActive, msg.workspace);
        this.status('ok', `Deleted profile "${msg.name}".`);
        return this.postState({ selected: newActive });
    }

    async setActive(msg) {
        const { profiles } = this.loadState();
        await this.writeState(profiles, msg.name, msg.workspace);
        this.status('ok', `"${msg.name}" is now the active profile.`);
        return this.postState({ selected: msg.name });
    }

    scopeName(target) {
        return target === vscode.ConfigurationTarget.Workspace ? 'workspace' : 'user';
    }

    async test(raw) {
        const settings = config.fromObject(raw);
        const problems = config.validate(settings);
        if (problems.length) return this.status('error', problems.join('\n'));
        this.status('ok', 'Testing ' + settings.port + ' ...');
        try {
            const report = await testPort(settings);
            this.status('ok', report);
        } catch (err) {
            this.status('error', 'Port test failed: ' + err.message);
        }
    }
}

module.exports = { ControlPanel };
