import http, { STATUS_CODES } from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { once } from 'node:events';

import {
    GENERATED_LOCAL_CHAT_PATH,
    GENERATED_LOCAL_MODELS_PATH,
    assertVerifiedGeneratedLocalRouterDescriptor,
    buildGeneratedLocalOperationURL,
    canonicalJSONStringify,
} from './generatedLocalRouterDescriptor.mjs';

const MAX_JSON_UPLOAD_BYTES = 2 * 1024 * 1024;
const MAX_JSON_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_ERROR_RESPONSE_BYTES = 64 * 1024;
const MAX_HEADER_BYTES = 64 * 1024;
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_HEADER_TIMEOUT_MS = 460_000;
const DEFAULT_BODY_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 510_000;

const PROTECTED_HEADERS = new Set([
    'host',
    'authorization',
    'content-type',
    'content-length',
    'accept',
    'connection',
    'transfer-encoding',
    'te',
    'upgrade',
    'forwarded',
    'x-forwarded-for',
    'x-forwarded-host',
    'x-forwarded-port',
    'x-forwarded-proto',
    'x-real-ip',
    'x-ploinky-authority-probe',
]);

let requestFactory = (protocol, options, callback) => (
    protocol === 'https:' ? https.request(options, callback) : http.request(options, callback)
);

export class RouterHttpTransportError extends Error {
    constructor(code, message, options = {}) {
        // Do not retain the raw lower-level error as `cause`: socket factories
        // and URL parsers may embed credentials or descriptor paths in it.
        // The public error code/message below are the bounded, redacted form.
        super(message);
        this.name = 'RouterHttpTransportError';
        this.code = code;
        if (options.status !== undefined) this.status = options.status;
        if (options.headers !== undefined) this.headers = options.headers;
        if (options.body !== undefined) this.body = options.body;
    }
}

function transportError(code, message, options) {
    return new RouterHttpTransportError(code, message, options);
}

function abortError() {
    const error = new Error('The generated-local Router request was aborted.');
    error.name = 'AbortError';
    error.code = 'ABORT_ERR';
    return error;
}

function timeoutError(code, phase) {
    return transportError(code, `Generated-local Router ${phase} timed out.`);
}

function validatePositiveTimeout(value, fallback, name) {
    const selected = value === undefined ? fallback : value;
    if (!Number.isSafeInteger(selected) || selected <= 0) {
        throw new TypeError(`${name} must be a positive integer.`);
    }
    return selected;
}

function validateCallerHeaders(headers) {
    if (headers === undefined || headers === null) return {};
    const prototype = typeof headers === 'object' && headers !== null
        ? Object.getPrototypeOf(headers)
        : null;
    if (typeof headers !== 'object'
        || headers === null
        || Array.isArray(headers)
        || (prototype !== Object.prototype && prototype !== null)) {
        throw transportError('PLOINKY_ROUTER_HEADERS_INVALID', 'Generated-local Router headers must be a plain object.');
    }
    const result = {};
    for (const [rawName, rawValue] of Object.entries(headers)) {
        const name = String(rawName).trim().toLowerCase();
        if (!name
            || PROTECTED_HEADERS.has(name)
            || name.startsWith('proxy-')
            || name.startsWith('x-forwarded-')
            || name.startsWith('sec-websocket-')) {
            throw transportError('PLOINKY_ROUTER_PROTECTED_HEADER', `Generated-local Router caller header "${rawName}" is protected.`);
        }
        if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(rawName)) {
            throw transportError('PLOINKY_ROUTER_HEADERS_INVALID', 'Generated-local Router caller header name is invalid.');
        }
        if (Array.isArray(rawValue)) {
            result[rawName] = rawValue.map((entry) => String(entry));
        } else if (rawValue !== undefined && rawValue !== null) {
            result[rawName] = String(rawValue);
        }
    }
    return result;
}

function normalizeResponseHeaders(incoming) {
    const headers = Object.create(null);
    const raw = Array.isArray(incoming.rawHeaders) ? incoming.rawHeaders : [];
    for (let index = 0; index < raw.length; index += 2) {
        const name = String(raw[index] || '').toLowerCase();
        const value = String(raw[index + 1] || '');
        if (!name) continue;
        if (!Object.hasOwn(headers, name)) {
            headers[name] = value;
        } else if (name === 'set-cookie') {
            headers[name] = Array.isArray(headers[name])
                ? [...headers[name], value]
                : [headers[name], value];
        } else {
            headers[name] = `${headers[name]}, ${value}`;
        }
    }
    return Object.freeze(headers);
}

function redactText(value, secrets = []) {
    let output = String(value ?? '');
    output = output.replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]');
    output = output.replace(/\b(?:https?):\/\/[^\s/@:]+:[^\s/@]+@/gi, (match) => match.replace(/\/\/.*@/, '//[REDACTED]@'));
    output = output.replace(/\bagent:[^|\s"']+\|[A-Za-z0-9_-]{32,}/g, '[REDACTED_SIGNED_IDENTITY]');
    for (const secret of secrets) {
        const raw = String(secret || '');
        if (raw) output = output.split(raw).join('[REDACTED]');
    }
    return output;
}

function redactHeadersForError(headers, secrets) {
    const redacted = Object.create(null);
    for (const [name, value] of Object.entries(headers || {})) {
        redacted[name] = Array.isArray(value)
            ? Object.freeze(value.map((entry) => redactText(entry, secrets)))
            : redactText(value, secrets);
    }
    return Object.freeze(redacted);
}

async function writeBodyWithBackpressure(request, body, signal) {
    if (!body || body.length === 0) {
        request.end();
        return;
    }
    if (signal?.aborted) throw abortError();
    if (!request.write(body)) {
        try {
            await once(request, 'drain', signal ? { signal } : undefined);
        } catch (error) {
            if (signal?.aborted) throw abortError();
            throw error;
        }
    }
    if (signal?.aborted) throw abortError();
    request.end();
}

class RouterHttpResponse {
    #incoming;
    #consumed = false;
    #completed = false;
    #terminalError = null;
    #cleanup;
    #idleTimeoutMs;
    #idleTimer = null;
    #onReadable;
    #secrets;

    constructor(incoming, { cleanup, idleTimeoutMs, secrets }) {
        this.#incoming = incoming;
        this.#cleanup = cleanup;
        this.#idleTimeoutMs = idleTimeoutMs;
        this.#secrets = secrets;
        this.status = incoming.statusCode || 0;
        this.statusText = incoming.statusMessage || STATUS_CODES[this.status] || '';
        this.ok = this.status >= 200 && this.status < 300;
        this.headers = normalizeResponseHeaders(incoming);
        this.#onReadable = () => this.#resetIdleTimer();

        incoming.once('aborted', () => {
            this.#terminalError ||= transportError('PLOINKY_ROUTER_RESPONSE_ABORTED', 'Generated-local Router response was aborted.');
            this.#finish();
        });
        incoming.once('error', (error) => {
            this.#terminalError ||= error;
            this.#finish();
        });
        incoming.once('end', () => this.#finish());
        incoming.on('readable', this.#onReadable);
        this.#resetIdleTimer();
    }

    get body() {
        this.#claim();
        return this.#incoming;
    }

    #claim() {
        if (this.#consumed) {
            throw transportError('PLOINKY_ROUTER_BODY_ALREADY_CONSUMED', 'Generated-local Router response body has already been consumed.');
        }
        this.#consumed = true;
    }

    #resetIdleTimer() {
        if (this.#completed) return;
        clearTimeout(this.#idleTimer);
        this.#idleTimer = setTimeout(() => {
            const error = timeoutError('PLOINKY_ROUTER_BODY_IDLE_TIMEOUT', 'response body');
            this.#terminalError ||= error;
            this.#incoming.destroy(error);
            this.#finish();
        }, this.#idleTimeoutMs);
        this.#idleTimer.unref?.();
    }

    #finish() {
        if (this.#completed) return;
        this.#completed = true;
        clearTimeout(this.#idleTimer);
        this.#incoming.removeListener('readable', this.#onReadable);
        this.#cleanup();
    }

    async #readBounded(limit) {
        this.#claim();
        const chunks = [];
        let total = 0;
        try {
            for await (const chunk of this.#incoming) {
                this.#resetIdleTimer();
                const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                total += bytes.length;
                if (total > limit) {
                    const error = transportError('PLOINKY_ROUTER_RESPONSE_TOO_LARGE', 'Generated-local Router response exceeded its byte limit.');
                    this.#incoming.destroy(error);
                    throw error;
                }
                chunks.push(bytes);
            }
            if (this.#terminalError) throw this.#terminalError;
            return Buffer.concat(chunks, total);
        } finally {
            this.#finish();
        }
    }

    async json() {
        const bytes = await this.#readBounded(MAX_JSON_RESPONSE_BYTES);
        try {
            return JSON.parse(bytes.toString('utf8'));
        } catch (error) {
            throw transportError('PLOINKY_ROUTER_JSON_INVALID', 'Generated-local Router returned invalid JSON.', { cause: error });
        }
    }

    async text() {
        return (await this.#readBounded(MAX_JSON_RESPONSE_BYTES)).toString('utf8');
    }

    async readErrorText() {
        const bytes = await this.#readBounded(MAX_ERROR_RESPONSE_BYTES);
        return redactText(bytes.toString('utf8'), this.#secrets);
    }

    destroy(error = undefined) {
        if (!this.#completed) this.#incoming.destroy(error);
        this.#finish();
    }
}

function descriptorSecrets(descriptor, bearer) {
    const payload = descriptor.payload;
    return [
        bearer,
        descriptor.signature,
        descriptor.descriptorFile,
        payload.agentPrincipal,
        payload.instanceId,
        payload.generationId,
        payload.launchId,
    ].filter(Boolean);
}

export async function routerHttpRequest({
    descriptor,
    pathname,
    method = 'GET',
    json = undefined,
    headers = undefined,
    bearer = undefined,
    signal = undefined,
    accept = 'application/json',
    connectHeaderTimeoutMs = undefined,
    connectTimeoutMs = undefined,
    headerTimeoutMs = undefined,
    bodyIdleTimeoutMs = undefined,
    totalTimeoutMs = undefined,
} = {}) {
    assertVerifiedGeneratedLocalRouterDescriptor(descriptor);
    const operationURL = buildGeneratedLocalOperationURL(descriptor, pathname);
    const expectedMethod = pathname === GENERATED_LOCAL_CHAT_PATH ? 'POST' : 'GET';
    if (method !== expectedMethod) {
        throw transportError(
            'PLOINKY_ROUTER_METHOD_DENIED',
            `Generated-local Router operation requires ${expectedMethod}.`
        );
    }
    const allowedAccept = pathname === GENERATED_LOCAL_CHAT_PATH
        ? new Set(['application/json', 'text/event-stream'])
        : new Set(['application/json']);
    if (!allowedAccept.has(accept)) {
        throw transportError(
            'PLOINKY_ROUTER_ACCEPT_DENIED',
            'Generated-local Router Accept value is not certified for this operation.'
        );
    }
    const callerHeaders = validateCallerHeaders(headers);
    // Retain the original combined option as a compatibility alias while
    // allowing callers to bound connection establishment separately from the
    // application response-header latency that includes model inference.
    if (connectHeaderTimeoutMs !== undefined
        && (connectTimeoutMs !== undefined || headerTimeoutMs !== undefined)) {
        throw new TypeError(
            'connectHeaderTimeoutMs cannot be combined with connectTimeoutMs or headerTimeoutMs.'
        );
    }
    const combinedTimeout = connectHeaderTimeoutMs === undefined
        ? undefined
        : validatePositiveTimeout(
            connectHeaderTimeoutMs,
            DEFAULT_CONNECT_TIMEOUT_MS,
            'connectHeaderTimeoutMs'
        );
    const connectTimeout = validatePositiveTimeout(
        connectTimeoutMs,
        DEFAULT_CONNECT_TIMEOUT_MS,
        'connectTimeoutMs'
    );
    const headerTimeout = validatePositiveTimeout(
        headerTimeoutMs,
        DEFAULT_HEADER_TIMEOUT_MS,
        'headerTimeoutMs'
    );
    const idleTimeout = validatePositiveTimeout(
        bodyIdleTimeoutMs,
        DEFAULT_BODY_IDLE_TIMEOUT_MS,
        'bodyIdleTimeoutMs'
    );
    const totalTimeout = validatePositiveTimeout(
        totalTimeoutMs,
        DEFAULT_TOTAL_TIMEOUT_MS,
        'totalTimeoutMs'
    );
    if (signal?.aborted) throw abortError();

    if (bearer === undefined || typeof bearer !== 'string' || !bearer) {
        throw transportError(
            'PLOINKY_ROUTER_BEARER_REQUIRED',
            'Generated-local Router operations require a nonempty bearer.'
        );
    }
    if (pathname === GENERATED_LOCAL_CHAT_PATH && json === undefined) {
        throw transportError(
            'PLOINKY_ROUTER_REQUEST_BODY_REQUIRED',
            'Generated-local Router chat operations require a JSON body.'
        );
    }
    if (pathname === GENERATED_LOCAL_MODELS_PATH && json !== undefined) {
        throw transportError(
            'PLOINKY_ROUTER_REQUEST_BODY_DENIED',
            'Generated-local Router model discovery cannot carry a request body.'
        );
    }

    let body = null;
    if (json !== undefined) {
        body = Buffer.from(canonicalJSONStringify(json), 'utf8');
        if (body.length > MAX_JSON_UPLOAD_BYTES) {
            throw transportError('PLOINKY_ROUTER_REQUEST_TOO_LARGE', 'Generated-local Router JSON upload exceeds 2 MiB.');
        }
    }

    const physicalURL = new URL(descriptor.payload.physicalOrigin);
    const requestHeaders = {
        ...callerHeaders,
        Host: descriptor.payload.requestAuthority,
        Accept: accept,
        Connection: 'close',
        ...(body ? {
            'Content-Type': 'application/json',
            'Content-Length': String(body.length),
        } : {}),
        Authorization: `Bearer ${bearer}`,
    };

    return await new Promise((resolve, reject) => {
        let settled = false;
        let response = null;
        let connectTimer = null;
        let headerTimer = null;
        let totalTimer = null;
        let request;
        let socket;
        let socketConnectEvent;
        let uploadPromise = Promise.resolve();

        const cleanup = () => {
            clearTimeout(connectTimer);
            clearTimeout(headerTimer);
            clearTimeout(totalTimer);
            request?.removeListener?.('socket', onSocket);
            if (socketConnectEvent) {
                socket?.removeListener?.(socketConnectEvent, onConnected);
            }
            signal?.removeEventListener?.('abort', onAbort);
        };
        const rejectOnce = (error) => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(error);
        };
        const onAbort = () => {
            const error = abortError();
            response?.destroy(error);
            request?.destroy(error);
            rejectOnce(error);
        };
        const onConnected = () => {
            if (combinedTimeout !== undefined) return;
            clearTimeout(connectTimer);
            connectTimer = null;
            if (settled || response) return;
            headerTimer = setTimeout(() => {
                const error = timeoutError('PLOINKY_ROUTER_HEADER_TIMEOUT', 'response header');
                request?.destroy(error);
                rejectOnce(error);
            }, headerTimeout);
            headerTimer.unref?.();
        };
        const onSocket = (assignedSocket) => {
            socket = assignedSocket;
            const tls = physicalURL.protocol === 'https:';
            socketConnectEvent = tls ? 'secureConnect' : 'connect';
            const connecting = tls ? socket.secureConnecting : socket.connecting;
            if (connecting) {
                socket.once(socketConnectEvent, onConnected);
            } else {
                onConnected();
            }
        };

        signal?.addEventListener?.('abort', onAbort, { once: true });
        connectTimer = setTimeout(() => {
            const legacyCombined = combinedTimeout !== undefined;
            const error = timeoutError(
                legacyCombined
                    ? 'PLOINKY_ROUTER_CONNECT_HEADER_TIMEOUT'
                    : 'PLOINKY_ROUTER_CONNECT_TIMEOUT',
                legacyCombined ? 'connect/header' : 'connect'
            );
            request?.destroy(error);
            rejectOnce(error);
        }, combinedTimeout ?? connectTimeout);
        connectTimer.unref?.();
        totalTimer = setTimeout(() => {
            const error = timeoutError('PLOINKY_ROUTER_TOTAL_TIMEOUT', 'request');
            response?.destroy(error);
            request?.destroy(error);
            rejectOnce(error);
        }, totalTimeout);
        totalTimer.unref?.();

        const options = {
            protocol: physicalURL.protocol,
            hostname: physicalURL.hostname,
            port: physicalURL.port || (physicalURL.protocol === 'https:' ? 443 : 80),
            method,
            path: `${operationURL.pathname}`,
            headers: requestHeaders,
            maxHeaderSize: MAX_HEADER_BYTES,
            setHost: false,
            ...(physicalURL.protocol === 'https:' && !net.isIP(physicalURL.hostname)
                ? { servername: physicalURL.hostname }
                : {}),
        };

        try {
            request = requestFactory(physicalURL.protocol, options, (incoming) => {
                clearTimeout(connectTimer);
                clearTimeout(headerTimer);
                response = new RouterHttpResponse(incoming, {
                    cleanup,
                    idleTimeoutMs: idleTimeout,
                    secrets: descriptorSecrets(descriptor, bearer),
                });

                if (response.status >= 300 && response.status < 400) {
                    response.readErrorText().then((detail) => {
                        const secrets = descriptorSecrets(descriptor, bearer);
                        const error = transportError(
                            'PLOINKY_ROUTER_REDIRECT_REJECTED',
                            `Generated-local Router redirect was rejected (${response.status}${detail ? `: ${detail}` : ''}).`,
                            {
                                status: response.status,
                                headers: redactHeadersForError(response.headers, secrets),
                                body: detail,
                            }
                        );
                        rejectOnce(error);
                    }, rejectOnce);
                    return;
                }

                // A peer can send response headers as soon as Content-Length
                // bytes arrive, before request.end(). Do not hand body ownership
                // to the caller until the upload has cleared backpressure and
                // completed successfully.
                queueMicrotask(() => {
                    uploadPromise.then(() => {
                        if (!settled) {
                            settled = true;
                            resolve(response);
                        }
                    }, rejectOnce);
                });
            });
            request.maxHeadersCount = 128;
            request.once('socket', onSocket);
            request.once('error', (error) => {
                if (signal?.aborted) {
                    rejectOnce(abortError());
                } else {
                    rejectOnce(transportError(
                        error?.code?.startsWith?.('PLOINKY_') ? error.code : 'PLOINKY_ROUTER_REQUEST_FAILED',
                        `Generated-local Router request failed: ${redactText(error?.message || 'unknown transport error', descriptorSecrets(descriptor, bearer))}`,
                        { cause: error }
                    ));
                }
            });
            uploadPromise = writeBodyWithBackpressure(request, body, signal);
            uploadPromise.catch((error) => {
                request.destroy(error);
                rejectOnce(error);
            });
        } catch (error) {
            rejectOnce(transportError('PLOINKY_ROUTER_REQUEST_FAILED', 'Generated-local Router request could not be constructed.', { cause: error }));
        }
    });
}

export function __setRouterRequestFactoryForTests(factory) {
    if (typeof factory !== 'function') throw new TypeError('Expected a request factory function.');
    requestFactory = factory;
}

export function __resetRouterRequestFactoryForTests() {
    requestFactory = (protocol, options, callback) => (
        protocol === 'https:' ? https.request(options, callback) : http.request(options, callback)
    );
}
