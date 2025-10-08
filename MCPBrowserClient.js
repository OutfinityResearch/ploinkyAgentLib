// AgentClient: minimal MCP client wrapper used by RoutingServer.
// Not a class; exposes factory returning concrete methods for MCP interactions.

const DEFAULT_PROTOCOL_VERSION = '2025-06-18';
const JSONRPC_VERSION = '2.0';

function resolveBaseUrl(baseUrl) {
    try {
        if (typeof window !== 'undefined' && window.location) {
            return new URL(baseUrl, window.location.href).toString();
        }
    } catch {
        // Fall through to absolute resolution
    }

    return new URL(baseUrl).toString();
}

function createAgentClient(baseUrl) {
    const endpoint = resolveBaseUrl(baseUrl);

    let connected = false;
    let sessionId = null;
    let protocolVersion = null;
    let abortController = null;
    let streamTask = null;
    let messageId = 0;

    const pending = new Map();

    let serverCapabilities = null;
    let serverInfo = null;
    let instructions = null;

    function nextId() {
        messageId += 1;
        return `${messageId}`;
    }

    function buildHeaders(options = {}) {
        const { acceptStream = false, includeContentType = false } = options;

        const headers = new Headers();
        if (includeContentType) {
            headers.set('content-type', 'application/json');
        }
        headers.set('accept', acceptStream ? 'text/event-stream' : 'application/json, text/event-stream');
        if (sessionId) {
            headers.set('mcp-session-id', sessionId);
        }
        if (protocolVersion) {
            headers.set('mcp-protocol-version', protocolVersion);
        }
        return headers;
    }

    function handleJsonrpcMessage(message) {
        const id = message.id !== undefined && message.id !== null ? String(message.id) : null;

        if (id && pending.has(id)) {
            const { resolve, reject } = pending.get(id);
            pending.delete(id);

            if ('error' in message && message.error) {
                reject(new Error(message.error.message ?? 'Unknown MCP error'));
            } else {
                resolve(message.result);
            }
            return;
        }

        // Notifications are ignored; extend here if needed.
    }

    async function parseJsonResponse(response) {
        const data = await response.json();
        const messages = Array.isArray(data) ? data : [data];
        for (const message of messages) {
            handleJsonrpcMessage(message);
        }
    }

    async function parseSseStream(stream) {
        if (!stream) {
            return;
        }

        const reader = stream.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { value, done } = await reader.read();
            if (done) {
                break;
            }

            buffer += decoder.decode(value, { stream: true });

            let boundaryIndex;
            while (
                (boundaryIndex = buffer.indexOf('\n\n')) !== -1 ||
                (boundaryIndex = buffer.indexOf('\r\n\r\n')) !== -1
            ) {
                const delimiterLength = buffer.startsWith('\r\n\r\n', boundaryIndex) ? 4 : 2;
                const rawEvent = buffer.slice(0, boundaryIndex);
                buffer = buffer.slice(boundaryIndex + delimiterLength);

                const eventLines = rawEvent.split(/\r?\n/);
                let eventId = null;
                const dataLines = [];

                for (const line of eventLines) {
                    if (line.startsWith('id:')) {
                        eventId = line.slice(3).trimStart();
                    } else if (line.startsWith('data:')) {
                        dataLines.push(line.slice(5).trimStart());
                    }
                }

                if (dataLines.length === 0) {
                    continue;
                }

                const payload = dataLines.join('\n');
                try {
                    const parsed = JSON.parse(payload);
                    if (Array.isArray(parsed)) {
                        for (const item of parsed) {
                            handleJsonrpcMessage(item);
                        }
                    } else {
                        handleJsonrpcMessage(parsed);
                    }
                } catch (error) {
                    console.warn('Failed to parse SSE message', error);
                }
            }
        }

        buffer += decoder.decode();

        if (buffer.trim().length > 0) {
            try {
                const parsed = JSON.parse(buffer.trim());
                if (Array.isArray(parsed)) {
                    for (const item of parsed) {
                        handleJsonrpcMessage(item);
                    }
                } else {
                    handleJsonrpcMessage(parsed);
                }
            } catch {
                // Ignore trailing partial data
            }
        }
    }

    function ensureStreamTask() {
        if (streamTask) {
            return;
        }

        if (abortController?.signal.aborted) {
            abortController = null;
        }

        if (!abortController) {
            abortController = new AbortController();
        }

        streamTask = (async () => {
            try {
                const headers = buildHeaders({ acceptStream: true });
                const response = await fetch(endpoint, {
                    method: 'GET',
                    headers,
                    signal: abortController.signal
                });

                if (response.status === 405) {
                    // Server does not support SSE; fall back to direct responses.
                    return;
                }

                if (!response.ok) {
                    throw new Error(`Failed to open MCP SSE stream: HTTP ${response.status}`);
                }

                await parseSseStream(response.body);
            } catch (error) {
                if (!abortController.signal.aborted) {
                    console.warn('MCP SSE stream error', error);
                }
            } finally {
                streamTask = null;
            }
        })();
    }

    async function sendMessage(message) {
        const optimisticallyAccepted = message.id === undefined;
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: buildHeaders({ includeContentType: true }),
            body: JSON.stringify(message)
        });

        const receivedSession = response.headers.get('mcp-session-id');
        if (receivedSession) {
            sessionId = receivedSession;
        }

        const receivedProtocol = response.headers.get('mcp-protocol-version');
        if (receivedProtocol) {
            protocolVersion = receivedProtocol;
        }

        if (response.status === 202 || response.status === 204) {
            // Asynchronous response via SSE; nothing else to do here.
            return;
        }

        if (!response.ok) {
            const text = await response.text().catch(() => '');
            throw new Error(`MCP request failed: HTTP ${response.status}${text ? ` - ${text}` : ''}`);
        }

        const contentType = response.headers.get('content-type') ?? '';
        if (contentType.includes('application/json')) {
            await parseJsonResponse(response);
            return;
        }

        if (contentType.includes('text/event-stream')) {
            await parseSseStream(response.body);
            return;
        }

        if (!optimisticallyAccepted) {
            throw new Error(`Unsupported MCP response content type: ${contentType || '<none>'}`);
        }
    }

    async function sendRequest(method, params) {
        ensureStreamTask();

        const id = nextId();

        const deferred = {};
        const promise = new Promise((resolve, reject) => {
            deferred.resolve = resolve;
            deferred.reject = reject;
        });

        pending.set(id, deferred);

        try {
            await sendMessage({ jsonrpc: JSONRPC_VERSION, id, method, params });
        } catch (error) {
            pending.delete(id);
            deferred.reject(error);
        }

        return promise;
    }

    async function sendNotification(method, params) {
        ensureStreamTask();
        await sendMessage({ jsonrpc: JSONRPC_VERSION, method, params });
    }

    async function connect() {
        if (connected) {
            return;
        }

        ensureStreamTask();

        const initResult = await sendRequest('initialize', {
            protocolVersion: DEFAULT_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: {
                name: 'ploinky-router',
                version: '1.0.0'
            }
        });

        protocolVersion = initResult.protocolVersion ?? DEFAULT_PROTOCOL_VERSION;
        serverCapabilities = initResult.capabilities ?? null;
        serverInfo = initResult.serverInfo ?? null;
        instructions = initResult.instructions ?? null;

        await sendNotification('notifications/initialized');
        connected = true;
    }

    async function listTools() {
        await connect();
        const result = await sendRequest('tools/list', {});
        return result?.tools ?? [];
    }

    async function callTool(name, args) {
        await connect();
        return await sendRequest('tools/call', {
            name,
            arguments: args ?? {}
        });
    }

    async function listResources() {
        await connect();
        const result = await sendRequest('resources/list', {});
        return result?.resources ?? [];
    }

    async function readResource(uri) {
        await connect();
        return await sendRequest('resources/read', { uri });
    }

    async function close() {
        if (abortController) {
            abortController.abort();
        }
        streamTask = null;
        abortController = null;

        try {
            if (sessionId) {
                await fetch(endpoint, {
                    method: 'DELETE',
                    headers: buildHeaders()
                });
            }
        } catch {
            // Ignore close errors
        }

        for (const { reject } of pending.values()) {
            reject(new Error('MCP client closed'));
        }
        pending.clear();

        connected = false;
        sessionId = null;
        protocolVersion = null;
    }

    return {
        connect,
        listTools,
        callTool,
        listResources,
        readResource,
        close,
        getCapabilities: () => serverCapabilities,
        getServerInfo: () => serverInfo,
        getInstructions: () => instructions
    };
}

export { createAgentClient };
