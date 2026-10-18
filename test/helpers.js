'use strict';

// A fake serial line. Writes are recorded; `onWrite(frame, index)` may return a byte
// (or array of bytes) the "control" sends back. Replies are delivered on the next tick,
// the way a real serial line delivers them.
function fakeLine(onWrite) {
    const listeners = new Set();
    const written = [];

    const emit = (bytes) => setImmediate(() => {
        for (const listener of [...listeners]) listener(Buffer.from(bytes));
    });

    return {
        written,
        emit,
        async write(buffer) {
            const frame = Buffer.from(buffer);
            written.push(frame);
            if (onWrite) {
                const reply = onWrite(frame, written.length);
                if (reply !== undefined && reply !== null) {
                    emit(Buffer.isBuffer(reply) || Array.isArray(reply) ? reply : [reply]);
                }
            }
        },
        async drain() {},
        onData(callback) {
            listeners.add(callback);
            return { dispose: () => listeners.delete(callback) };
        },
    };
}

module.exports = { fakeLine };
