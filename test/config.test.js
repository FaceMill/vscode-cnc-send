'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const config = require('../src/config');
const { prepareProgram, nonAsciiChars } = require('../src/text');

const withPort = (overrides = {}) => ({ ...config.DEFAULTS, port: '/dev/cu.usbserial-110', ...overrides });

test('defaults with a port selected are valid', () => {
    assert.deepEqual(config.validate(withPort()), []);
});

test('missing port is reported unless the caller opts out', () => {
    assert.equal(config.validate(config.DEFAULTS).length, 1);
    assert.deepEqual(config.validate(config.DEFAULTS, { requirePort: false }), []);
});

test('XMODEM rejects 7 data bits, parity, and XON/XOFF', () => {
    const problems = config.validate(withPort({ dataBits: 7, parity: 'even', flowControl: 'software' }));
    assert.equal(problems.length, 3);
});

test('stream may use 7 bits and XON/XOFF', () => {
    const problems = config.validate(withPort({ protocol: 'stream', dataBits: 7, parity: 'even', flowControl: 'software' }));
    assert.deepEqual(problems, []);
});

test('readSettings coerces strings from forms to numbers and booleans', () => {
    const s = config.fromObject({ baudRate: '19200', maxRetries: '3', rts: 'on', dtr: false, port: 'COM3' });
    assert.equal(s.baudRate, 19200);
    assert.equal(s.maxRetries, 3);
    assert.equal(s.rts, true);
    assert.equal(s.dtr, false);
    assert.equal(s.port, 'COM3');
});

test('every machine profile is valid once a port is chosen', () => {
    for (const [id, profile] of Object.entries(config.MACHINE_PROFILES)) {
        assert.deepEqual(config.validate(withPort(profile.settings)), [], `profile ${id}`);
    }
});

test('package.json declares the profile settings and the commands the code registers', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const props = pkg.contributes.configuration.properties;
    assert.deepEqual(props['cncDnc.profiles'].default, []);
    assert.deepEqual(props['cncDnc.profiles'].items.required, ['name']);
    assert.equal(props['cncDnc.activeProfile'].default, '');
    const commands = pkg.contributes.commands.map((c) => c.command).sort();
    assert.deepEqual(commands, ['cncDnc.openControlPanel', 'cncDnc.receiveProgram', 'cncDnc.selectProfile', 'cncDnc.sendProgram']);
});

test('profilesFrom returns the saved profiles with defaults filled in', () => {
    const profiles = config.profilesFrom([{ name: ' Haas VF-2 ', port: 'COM3', baudRate: '19200' }], () => undefined);
    assert.equal(profiles.length, 1);
    assert.equal(profiles[0].name, 'Haas VF-2');
    assert.equal(profiles[0].port, 'COM3');
    assert.equal(profiles[0].baudRate, 19200);
    assert.equal(profiles[0].protocol, config.DEFAULTS.protocol);
});

test('profilesFrom seeds one Default profile from legacy flat settings when none are saved', () => {
    const legacy = { port: '/dev/cu.usbserial-110', protocol: 'stream' };
    const profiles = config.profilesFrom([], (key) => legacy[key]);
    assert.equal(profiles[0].name, 'Default');
    assert.equal(profiles[0].port, '/dev/cu.usbserial-110');
    assert.equal(profiles[0].protocol, 'stream');
});

test('profilesFrom drops entries without a name', () => {
    const profiles = config.profilesFrom([{ name: '  ' }, null, { name: 'Fanuc' }], () => undefined);
    assert.deepEqual(profiles.map((p) => p.name), ['Fanuc']);
});

test('resolveProfile falls back to the first profile when the active name is stale', () => {
    const profiles = [{ name: 'A' }, { name: 'B' }];
    assert.equal(config.resolveProfile(profiles, 'B').name, 'B');
    assert.equal(config.resolveProfile(profiles, 'gone').name, 'A');
    assert.equal(config.resolveProfile(profiles, '').name, 'A');
});

test('loadState reads profiles and the active name through one getter', () => {
    const store = { profiles: [{ name: 'Mill' }], activeProfile: 'Mill' };
    const state = config.loadState((key) => store[key]);
    assert.deepEqual(state.profiles.map((p) => p.name), ['Mill']);
    assert.equal(state.activeProfile, 'Mill');
});

test('validateProfileName rejects empty, duplicate, and overlong names', () => {
    const profiles = [{ name: 'Mill' }, { name: 'Lathe' }];
    assert.ok(config.validateProfileName('  ', profiles));
    assert.ok(config.validateProfileName('Mill', profiles));
    assert.ok(config.validateProfileName('x'.repeat(41), profiles));
    assert.equal(config.validateProfileName('Mill', profiles, 'Mill'), null, 'keeps its own name');
    assert.equal(config.validateProfileName('Router', profiles), null);
});

test('prepareProgram leaves text alone when asIs and no wrap', () => {
    const text = 'O1\r\nG0\n';
    assert.equal(prepareProgram(text, withPort()), text);
});

test('prepareProgram rewrites line endings and trims blank edges', () => {
    const out = prepareProgram('\n\nO1\r\nG0\rM30\n\n', withPort({ lineEnding: 'CRLF' }));
    assert.equal(out, 'O1\r\nG0\r\nM30\r\n');
});

test('prepareProgram adds % delimiters when missing', () => {
    const out = prepareProgram('O1\nG0\nM30', withPort({ lineEnding: 'LF', wrapWithPercent: true }));
    assert.equal(out, '%\nO1\nG0\nM30\n%\n');
});

test('prepareProgram keeps existing % delimiters', () => {
    const out = prepareProgram('%\nO1\nM30\n%\n', withPort({ lineEnding: 'LF', wrapWithPercent: true }));
    assert.equal(out, '%\nO1\nM30\n%\n');
});

test('nonAsciiChars finds characters that would not survive a 7-bit line', () => {
    assert.deepEqual(nonAsciiChars('G1 X1 ° Y2 °'), ['°']);
    assert.deepEqual(nonAsciiChars('G1 X1'), []);
});
