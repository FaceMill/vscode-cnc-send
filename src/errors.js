'use strict';

/** The user (or the VS Code cancel button) stopped the transfer. */
class CancelledError extends Error {
    constructor(message = 'Transfer cancelled') {
        super(message);
        this.name = 'CancelledError';
    }
}

/** The machine or the line failed in a way the protocol could not recover from. */
class TransferError extends Error {
    constructor(message) {
        super(message);
        this.name = 'TransferError';
    }
}

/** Settings are inconsistent or incomplete; nothing was sent. */
class ConfigError extends Error {
    constructor(problems) {
        super(Array.isArray(problems) ? problems.join('\n') : problems);
        this.name = 'ConfigError';
        this.problems = Array.isArray(problems) ? problems : [problems];
    }
}

function throwIfAborted(signal) {
    if (signal && signal.aborted) throw new CancelledError();
}

module.exports = { CancelledError, TransferError, ConfigError, throwIfAborted };
