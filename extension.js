const os = require('os');
const path = require('path');
const vscode = require('vscode');
const config = require('./src/config');
const { sendProgram, receiveProgram } = require('./src/sender');
const { nonAsciiChars } = require('./src/text');
const { ControlPanel } = require('./src/panel');
const { CancelledError, ConfigError } = require('./src/errors');

let output;
let profileItem;
let sendItem;

function log(message) {
    output.appendLine(`[${new Date().toLocaleTimeString()}] ${message}`);
}

function loadState() {
    const cfg = vscode.workspace.getConfiguration('cncDnc');
    return config.loadState((key) => cfg.get(key));
}

function activeProfile(state) {
    return config.resolveProfile(state.profiles, state.activeProfile);
}

/** Keep the profile picker and the Send tooltip in step with the active profile. */
function updateStatus() {
    const active = activeProfile(loadState());
    profileItem.text = `$(plug) CNC: ${active.name} $(chevron-down)`;
    profileItem.tooltip = `Active profile "${active.name}" (${active.port || 'no port'}). Click to change.`;
    sendItem.tooltip = `Send the current file with "${active.name}"`;
}

async function openPanelOnProblem(problems) {
    const choice = await vscode.window.showErrorMessage(
        'Cannot send yet: ' + problems[0],
        'Open Control Panel',
    );
    if (choice) vscode.commands.executeCommand('cncDnc.openControlPanel');
}

/**
 * Send the active editor. Uses the named profile when given (the Control Panel passes one),
 * otherwise the active profile, which is the one picked in the status bar.
 */
async function sendActiveEditor(profileName) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showErrorMessage('No file open.');
        return;
    }

    const state = loadState();
    const profile = profileName
        ? state.profiles.find((p) => p.name === profileName)
        : activeProfile(state);
    if (!profile) {
        vscode.window.showErrorMessage(`Profile "${profileName}" was not found.`);
        return;
    }

    const settings = config.fromObject(profile);
    const problems = config.validate(settings);
    if (problems.length) {
        await openPanelOnProblem([`Profile "${profile.name}": ${problems[0]}`]);
        return;
    }

    // The editor buffer is sent, so unsaved edits go to the machine too.
    const text = editor.document.getText();
    if (!text.trim()) {
        vscode.window.showErrorMessage('The active document is empty.');
        return;
    }

    const bad = nonAsciiChars(text);
    if (bad.length) {
        const choice = await vscode.window.showWarningMessage(
            `The program contains non-ASCII characters (${bad.slice(0, 5).join(' ')}). A CNC may not accept these. Send anyway?`,
            { modal: true },
            'Send anyway',
        );
        if (choice !== 'Send anyway') return;
    }

    const name = path.basename(editor.document.fileName || 'program');
    log(`Sending ${name} with profile "${profile.name}" to ${settings.port} using ${settings.protocol}`);

    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: `Sending ${name} to ${profile.name} (${settings.port})`,
            cancellable: true,
        },
        async (progress, token) => {
            const controller = new AbortController();
            const subscription = token.onCancellationRequested(() => controller.abort());
            let lastPercent = 0;
            try {
                await sendProgram(text, settings, {
                    signal: controller.signal,
                    log,
                    onProgress: (done, total) => {
                        const percent = total ? Math.floor((done / total) * 100) : 100;
                        progress.report({ message: `${done} of ${total}`, increment: percent - lastPercent });
                        lastPercent = percent;
                    },
                });
                vscode.window.showInformationMessage(`${name} sent to the machine with profile "${profile.name}".`);
                log('Transfer finished');
            } catch (err) {
                if (err instanceof CancelledError) {
                    vscode.window.showWarningMessage('Transfer cancelled.');
                    log('Transfer cancelled');
                } else if (err instanceof ConfigError) {
                    await openPanelOnProblem(err.problems);
                } else {
                    log('ERROR: ' + err.message);
                    output.show(true);
                    vscode.window.showErrorMessage('Send failed: ' + err.message);
                }
            } finally {
                subscription.dispose();
            }
        },
    );
}

/**
 * Change the active profile. The status bar picker and the Control Panel both use this.
 * It writes to workspace settings only when the workspace already overrides the active profile.
 */
async function selectProfile() {
    const state = loadState();
    const items = state.profiles.map((p) => ({
        label: p.name + (p.name === state.activeProfile ? '  (active)' : ''),
        description: `${p.port || 'no port'} · ${p.baudRate} · ${p.protocol}`,
        profileName: p.name,
    }));
    items.push({ label: '$(gear) Manage profiles…', description: 'Open the Control Panel', profileName: null });

    const pick = await vscode.window.showQuickPick(items, {
        title: 'CNC profile for Send and Receive',
        placeHolder: 'Choose the active profile',
    });
    if (!pick) return;
    if (pick.profileName === null) return vscode.commands.executeCommand('cncDnc.openControlPanel');

    const cfg = vscode.workspace.getConfiguration('cncDnc');
    const overridden = cfg.inspect('activeProfile');
    const workspaceOverride = overridden && overridden.workspaceValue !== undefined;
    const target = workspaceOverride ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    await cfg.update('activeProfile', pick.profileName, target);
}

/** Name the saved file after the O-number on its first line, or use a timestamp. */
function suggestedName(text) {
    const match = text.match(/^\s*(O\d{1,5})\b/m);
    if (match) return `${match[1]}.nc`;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    return `received-${stamp}.nc`;
}

/** Save the received bytes through a dialog. Cancelling leaves them in an untitled editor. */
async function saveReceived(data, profileName) {
    if (!data.length) {
        vscode.window.showWarningMessage('Nothing was received from the control.');
        return;
    }

    const text = data.toString('latin1');
    const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
    const base = folder ? folder.uri.fsPath : os.homedir();
    const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(path.join(base, suggestedName(text))),
        filters: { 'G-code': ['nc', 'txt'] },
        title: 'Save program received from CNC',
    });

    let doc;
    if (uri) {
        await vscode.workspace.fs.writeFile(uri, data);
        doc = await vscode.workspace.openTextDocument(uri);
    } else {
        doc = await vscode.workspace.openTextDocument({ content: text, language: 'plaintext' });
    }
    await vscode.window.showTextDocument(doc);
    vscode.window.showInformationMessage(
        `Received ${data.length} bytes from "${profileName}".` + (uri ? '' : ' Not saved to disk yet; use Save As.'),
    );
}

/** Receive a file from the control with the named profile (or the active one) and save it. */
async function receiveFromProfile(profileName) {
    const state = loadState();
    const profile = profileName
        ? state.profiles.find((p) => p.name === profileName)
        : activeProfile(state);
    if (!profile) {
        vscode.window.showErrorMessage(`Profile "${profileName}" was not found.`);
        return;
    }

    const settings = config.fromObject(profile);
    const problems = config.validate(settings);
    if (problems.length) {
        await openPanelOnProblem([`Profile "${profile.name}": ${problems[0]}`]);
        return;
    }

    log(`Receiving with profile "${profile.name}" from ${settings.port} using ${settings.protocol}`);
    const unit = settings.protocol === 'xmodem' ? 'blocks' : 'bytes';

    let data;
    try {
        data = await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `Receiving from ${profile.name} (${settings.port}). Start the send on the control now.`,
                cancellable: true,
            },
            async (progress, token) => {
                const controller = new AbortController();
                const subscription = token.onCancellationRequested(() => controller.abort());
                try {
                    return await receiveProgram(settings, {
                        signal: controller.signal,
                        log,
                        onProgress: (done) => progress.report({ message: `${done} ${unit} so far` }),
                    });
                } finally {
                    subscription.dispose();
                }
            },
        );
    } catch (err) {
        if (err instanceof CancelledError) {
            vscode.window.showWarningMessage('Receive cancelled.');
            log('Receive cancelled');
        } else if (err instanceof ConfigError) {
            await openPanelOnProblem(err.problems);
        } else {
            log('ERROR: ' + err.message);
            output.show(true);
            vscode.window.showErrorMessage('Receive failed: ' + err.message);
        }
        return;
    }

    log(`Received ${data.length} bytes`);
    await saveReceived(data, profile.name);
}

function activate(context) {
    output = vscode.window.createOutputChannel('CNC DNC Sender');

    // Status bar: the profile picker sits beside the Send button. The bar has no dropdown control,
    // so the picker is a clickable item that opens the list of profiles.
    profileItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 101);
    profileItem.name = 'CNC Profile';
    profileItem.command = 'cncDnc.selectProfile';

    sendItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    sendItem.name = 'CNC Send';
    sendItem.text = '$(send) Send to CNC';
    sendItem.command = 'cncDnc.sendProgram';

    profileItem.show();
    sendItem.show();
    updateStatus();

    context.subscriptions.push(
        output,
        profileItem,
        sendItem,
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('cncDnc')) updateStatus();
        }),
        // The title-bar button, the status bar Send, and the keyboard shortcut all send with the active profile.
        // The Control Panel passes a profile name; other callers pass nothing or a resource.
        vscode.commands.registerCommand('cncDnc.sendProgram', (arg) => sendActiveEditor(typeof arg === 'string' ? arg : undefined)),
        vscode.commands.registerCommand('cncDnc.selectProfile', () => selectProfile()),
        vscode.commands.registerCommand('cncDnc.receiveProgram', (arg) => receiveFromProfile(typeof arg === 'string' ? arg : undefined)),
        vscode.commands.registerCommand('cncDnc.openControlPanel', () => ControlPanel.show(context, output)),
    );
}

function deactivate() {}

module.exports = { activate, deactivate };
