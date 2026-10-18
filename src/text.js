'use strict';

const EOL = { LF: '\n', CRLF: '\r\n', CR: '\r' };

/**
 * Turn the document text into the exact text that goes on the wire.
 * - lineEnding: 'asIs' leaves line endings alone; otherwise they are rewritten.
 * - wrapWithPercent: make sure the program starts and ends with '%' (ISO/EIA program delimiters).
 * With both off, the text is returned unchanged.
 */
function prepareProgram(text, s) {
    if (s.lineEnding === 'asIs' && !s.wrapWithPercent) return text;

    const eol = s.lineEnding === 'asIs' ? (text.includes('\r\n') ? '\r\n' : '\n') : EOL[s.lineEnding];
    const lines = text.split(/\r\n|\r|\n/);

    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
    while (lines.length && lines[0].trim() === '') lines.shift();

    if (s.wrapWithPercent && lines.length) {
        if (!lines[0].trim().startsWith('%')) lines.unshift('%');
        if (lines[lines.length - 1].trim() !== '%') lines.push('%');
    }

    return lines.length ? lines.join(eol) + eol : '';
}

/** Characters outside 7-bit ASCII. These do not survive a typical CNC serial receive. */
function nonAsciiChars(text) {
    return [...new Set(text.match(/[^\x00-\x7F]/g) || [])];
}

module.exports = { prepareProgram, nonAsciiChars };
