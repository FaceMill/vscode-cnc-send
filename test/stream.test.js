'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sendStream, nextLineEnd } = require('../src/stream');
const { CancelledError } = require('../src/errors');
const { fakeLine } = require('./helpers');

test('nextLineEnd splits on LF, CR, and CRLF', () => {
    const bytes = Buffer.from('A\r\nB\nC\rD');
    const chunks = [];
    let start = 0;
    while (start < bytes.length) {
        const end = nextLineEnd(bytes, start);
        chunks.push(bytes.subarray(start, end).toString());
        start = end;
    }
    assert.deepEqual(chunks, ['A\r\n', 'B\n', 'C\r', 'D']);
});

test('stream writes the whole program line by line, then the trailer', async () => {
    const text = Buffer.from('%\nO0001\nG0 X0\n%\n');
    const line = fakeLine(() => null);
    await sendStream(text, line, { trailer: 'ctrlZ' });
    assert.equal(line.written.length, 4 + 1);
    assert.equal(Buffer.concat(line.written).toString(), '%\nO0001\nG0 X0\n%\n\x1a');
});

test('EOT trailer is sent when selected', async () => {
    const line = fakeLine(() => null);
    await sendStream(Buffer.from('M30\n'), line, { trailer: 'EOT' });
    assert.deepEqual(line.written.at(-1), Buffer.from([0x04]));
});

test('no trailer means the program bytes are the only output', async () => {
    const line = fakeLine(() => null);
    await sendStream(Buffer.from('M30\n'), line, { trailer: 'none' });
    assert.equal(Buffer.concat(line.written).toString(), 'M30\n');
});

test('charDelayMs sends one byte per write', async () => {
    const line = fakeLine(() => null);
    await sendStream(Buffer.from('G1\n'), line, { charDelayMs: 1 });
    assert.equal(line.written.length, 3);
    assert.ok(line.written.every((frame) => frame.length === 1));
});

test('aborting stops the stream part way through', async () => {
    const controller = new AbortController();
    const line = fakeLine(() => null);
    const bytes = Buffer.from('one\ntwo\nthree\n');
    await assert.rejects(
        sendStream(bytes, line, {
            signal: controller.signal,
            onProgress: () => controller.abort(),
        }),
        CancelledError,
    );
    assert.equal(line.written.length, 1);
});
