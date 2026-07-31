/**
 * Bounded incremental Server-Sent Events parser shared by streaming providers.
 * It accepts either a WHATWG ReadableStream or a Node readable stream.
 */

const DEFAULT_MAX_LINE_BYTES = 256 * 1024;
const DEFAULT_MAX_EVENT_BYTES = 256 * 1024;

function sseError(code, message) {
    const error = new Error(message);
    error.name = 'SSEParserError';
    error.code = code;
    return error;
}

async function* webChunks(stream, state) {
    const reader = stream.getReader();
    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) {
                state.completed = true;
                return;
            }
            yield value;
        }
    } finally {
        if (!state.completed) {
            try {
                await reader.cancel('SSE consumer cancelled');
            } catch {
                // Cancellation is best-effort after the consumer has stopped.
            }
        }
        reader.releaseLock();
    }
}

async function* nodeChunks(stream, state) {
    try {
        for await (const chunk of stream) yield chunk;
        state.completed = true;
    } finally {
        if (!state.completed && typeof stream.destroy === 'function') {
            stream.destroy();
        }
    }
}

function chunkIterator(stream, state) {
    if (stream && typeof stream.getReader === 'function') return webChunks(stream, state);
    if (stream && typeof stream[Symbol.asyncIterator] === 'function') return nodeChunks(stream, state);
    throw new TypeError('parseSSEStream requires a readable stream.');
}

function parseFrameLines(lines) {
    let event = '';
    const dataLines = [];
    let id = '';
    let retry = null;

    for (const line of lines) {
        if (line.startsWith(':')) continue;
        const colonIndex = line.indexOf(':');
        const field = colonIndex === -1 ? line : line.slice(0, colonIndex);
        let value = colonIndex === -1 ? '' : line.slice(colonIndex + 1);
        if (value.startsWith(' ')) value = value.slice(1);

        switch (field) {
            case 'event':
                event = value;
                break;
            case 'data':
                dataLines.push(value);
                break;
            case 'id':
                if (!value.includes('\0')) id = value;
                break;
            case 'retry':
                if (/^[0-9]+$/.test(value)) retry = Number(value);
                break;
            default:
                break;
        }
    }

    const data = dataLines.join('\n');
    let parsedData = null;
    if (data) {
        try {
            parsedData = JSON.parse(data);
        } catch {
            // Non-JSON SSE data is preserved in `data`.
        }
    }
    return { event, data, id, retry, parsedData };
}

/**
 * @param {ReadableStream|import('node:stream').Readable} readableStream
 * @param {object} [options]
 * @param {string} [options.doneSentinel='[DONE]']
 * @param {number} [options.maxLineBytes=262144]
 * @param {number} [options.maxEventBytes=262144]
 */
export async function* parseSSEStream(readableStream, options = {}) {
    const {
        doneSentinel = '[DONE]',
        maxLineBytes = DEFAULT_MAX_LINE_BYTES,
        maxEventBytes = DEFAULT_MAX_EVENT_BYTES,
    } = options;
    if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes <= 0
        || !Number.isSafeInteger(maxEventBytes) || maxEventBytes <= 0) {
        throw new TypeError('SSE byte limits must be positive integers.');
    }

    const state = { completed: false };
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let textBuffer = '';
    let eventLines = [];
    let eventBytes = 0;

    const emitFrame = () => {
        if (eventLines.length === 0) return null;
        const frame = parseFrameLines(eventLines);
        eventLines = [];
        eventBytes = 0;
        return frame;
    };

    try {
        for await (const chunk of chunkIterator(readableStream, state)) {
            const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
            textBuffer += decoder.decode(bytes, { stream: true });

            while (true) {
                const newlineIndex = textBuffer.indexOf('\n');
                if (newlineIndex === -1) break;
                let line = textBuffer.slice(0, newlineIndex);
                textBuffer = textBuffer.slice(newlineIndex + 1);
                if (line.endsWith('\r')) line = line.slice(0, -1);

                const lineBytes = Buffer.byteLength(line, 'utf8');
                if (lineBytes > maxLineBytes) {
                    throw sseError('PLOINKY_SSE_LINE_TOO_LARGE', 'SSE line exceeded its byte limit.');
                }
                if (line === '') {
                    const frame = emitFrame();
                    if (!frame) continue;
                    if (frame.data === doneSentinel) return;
                    readableStream.pause?.();
                    try {
                        yield frame;
                    } finally {
                        readableStream.resume?.();
                    }
                    continue;
                }

                eventBytes += lineBytes + 1;
                if (eventBytes > maxEventBytes) {
                    throw sseError('PLOINKY_SSE_EVENT_TOO_LARGE', 'SSE event exceeded its byte limit.');
                }
                eventLines.push(line);
            }

            if (Buffer.byteLength(textBuffer, 'utf8') > maxLineBytes) {
                throw sseError('PLOINKY_SSE_LINE_TOO_LARGE', 'SSE line exceeded its byte limit.');
            }
        }

        textBuffer += decoder.decode();
        if (textBuffer) {
            let line = textBuffer.endsWith('\r') ? textBuffer.slice(0, -1) : textBuffer;
            const lineBytes = Buffer.byteLength(line, 'utf8');
            if (lineBytes > maxLineBytes || eventBytes + lineBytes > maxEventBytes) {
                throw sseError('PLOINKY_SSE_EVENT_TOO_LARGE', 'SSE terminal event exceeded its byte limit.');
            }
            eventLines.push(line);
        }
        const frame = emitFrame();
        if (frame && frame.data !== doneSentinel) yield frame;
    } catch (error) {
        if (error instanceof TypeError && /encoded data was not valid/.test(error.message)) {
            throw sseError('PLOINKY_SSE_UTF8_INVALID', 'SSE stream contains invalid UTF-8.');
        }
        throw error;
    }
}
