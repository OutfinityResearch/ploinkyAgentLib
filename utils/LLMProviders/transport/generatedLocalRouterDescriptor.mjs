import fs from 'node:fs';
import path from 'node:path';
import {
    createHash,
    createPublicKey,
    verify as verifySignature,
} from 'node:crypto';

export const GENERATED_LOCAL_DESCRIPTOR_SCHEMA = 'ploinky.generated-local-router.v1';
export const GENERATED_LOCAL_TRANSPORT_VERSION = 'node-authority-v1';
export const GENERATED_LOCAL_CHAT_PATH = '/base-agent-additional-server/soul-gateway/7000/v1/chat/completions';
export const GENERATED_LOCAL_MODELS_PATH = '/base-agent-additional-server/soul-gateway/7000/v1/models';

const SIGNATURE_DOMAIN = Buffer.from('PLOINKY\0GENERATED_LOCAL_ROUTER_DESCRIPTOR\0V1\0', 'utf8');
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const MAX_DESCRIPTOR_BYTES = 64 * 1024;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const LOOPBACK_AUTHORITY_PATTERN = /^127\.0\.0\.1:([1-9][0-9]{0,4})$/;
const GENERATED_LOCAL_CREDENTIAL_NAME = 'PLOINKY_AGENT_API_KEY';

const DESCRIPTOR_PAYLOAD_FIELDS = Object.freeze([
    'agentPrincipal',
    'attestationId',
    'edgeTopologyFile',
    'expiresAtUnixMs',
    'generationId',
    'instanceId',
    'internalRouterUrl',
    'issuedAtUnixMs',
    'launchId',
    'listenerClass',
    'localStreaming',
    'networkFingerprint',
    'physicalOrigin',
    'publicAuthority',
    'requestAuthority',
    'routerHost',
    'routerPort',
    'runtimeProof',
    'schema',
    'semanticTopologyDigest',
    'socketLocalAddressClass',
    'topology',
    'transportVersion',
]);
const DESCRIPTOR_PAYLOAD_FIELD_SET = new Set(DESCRIPTOR_PAYLOAD_FIELDS);

export const GENERATED_LOCAL_RUNTIME_NAMES = Object.freeze([
    'PLOINKY_ROUTER_DESCRIPTOR_FILE',
    'PLOINKY_ROUTER_HOST',
    'PLOINKY_ROUTER_PORT',
    'PLOINKY_ROUTER_URL',
    'PLOINKY_ROUTER_REQUEST_AUTHORITY',
    'PLOINKY_ROUTER_AUTHORITY',
    'PLOINKY_INTERNAL_ROUTER_URL',
    'PLOINKY_EDGE_TOPOLOGY_FILE',
    'PLOINKY_ROUTER_LISTENER_CLASS',
    'PLOINKY_ROUTER_ATTESTATION_ID',
    'PLOINKY_ROUTER_TRANSPORT_VERSION',
    'PLOINKY_ROUTER_LOCAL_STREAMING',
    'PLOINKY_AGENT_ID',
    'PLOINKY_AGENT_PRINCIPAL',
    'PLOINKY_AGENT_INSTANCE_ID',
    'PLOINKY_AGENT_ENABLE_GENERATION',
    'PLOINKY_AGENT_API_PUBLIC_KEY',
    'PLOINKY_AGENT_API_KEY',
]);

const GENERATED_LOCAL_SOURCE_NAMES = Object.freeze(
    GENERATED_LOCAL_RUNTIME_NAMES.map((name) => `PLOINKY_ENV_SOURCE_${name}`)
);
const GENERATED_LOCAL_BUNDLE_NAMES = new Set([
    ...GENERATED_LOCAL_RUNTIME_NAMES,
    ...GENERATED_LOCAL_SOURCE_NAMES,
]);
const ORDINARY_AGENT_IDENTITY_NAMES = new Set([
    'PLOINKY_AGENT_ID',
    'PLOINKY_AGENT_PRINCIPAL',
    'PLOINKY_AGENT_INSTANCE_ID',
    'PLOINKY_AGENT_ENABLE_GENERATION',
]);
const GENERATED_LOCAL_SIGNAL_NAMES = Object.freeze(
    GENERATED_LOCAL_RUNTIME_NAMES.filter((name) => !ORDINARY_AGENT_IDENTITY_NAMES.has(name))
);
const verifiedDescriptors = new WeakSet();

/**
 * Report provider credential availability without exposing generated-local
 * credential reads to discovery, diagnostics, or model-selection consumers.
 * Only the two certified request paths may read the generated credential.
 */
export function getProviderCredentialAvailability(providerConfig, apiKeyEnv, env = process.env) {
    if (isVerifiedGeneratedLocalRouterDescriptor(providerConfig?.generatedLocalDescriptor)) {
        return 'generated-local';
    }
    if (!apiKeyEnv) return 'not-configured';
    // An unbranded provider must never be allowed to turn the generated
    // credential name into a dynamic value read.
    if (apiKeyEnv === GENERATED_LOCAL_CREDENTIAL_NAME) return 'missing';
    return env[apiKeyEnv] ? 'available' : 'missing';
}

export class GeneratedLocalDescriptorError extends Error {
    constructor(code, message) {
        // Filesystem and parser errors can echo the descriptor path or raw
        // attacker-controlled bytes. Keep only this bounded public diagnostic.
        super(message);
        this.name = 'GeneratedLocalDescriptorError';
        this.code = code;
    }
}

function fail(code, message, options) {
    throw new GeneratedLocalDescriptorError(code, message, options);
}

function isPlainObject(value) {
    if (value === null || typeof value !== 'object') return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function canonicalize(value, stack) {
    if (value === null) return 'null';

    switch (typeof value) {
        case 'string':
            return JSON.stringify(value);
        case 'boolean':
            return value ? 'true' : 'false';
        case 'number':
            if (!Number.isFinite(value)) {
                fail('PLOINKY_DESCRIPTOR_CANONICAL_JSON_INVALID', 'Generated-local descriptor contains a non-finite number.');
            }
            return Object.is(value, -0) ? '0' : JSON.stringify(value);
        case 'bigint':
        case 'undefined':
        case 'function':
        case 'symbol':
            fail('PLOINKY_DESCRIPTOR_CANONICAL_JSON_INVALID', 'Generated-local descriptor contains a non-JSON value.');
            break;
        default:
            break;
    }

    if (stack.has(value)) {
        fail('PLOINKY_DESCRIPTOR_CANONICAL_JSON_INVALID', 'Generated-local descriptor contains a cycle.');
    }
    stack.add(value);
    try {
        if (Array.isArray(value)) {
            for (let index = 0; index < value.length; index += 1) {
                if (!Object.hasOwn(value, index)) {
                    fail('PLOINKY_DESCRIPTOR_CANONICAL_JSON_INVALID', 'Generated-local descriptor contains a sparse array.');
                }
            }
            const extraKeys = Reflect.ownKeys(value).filter((key) => key !== 'length');
            if (extraKeys.some((key) => typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key))) {
                fail('PLOINKY_DESCRIPTOR_CANONICAL_JSON_INVALID', 'Generated-local descriptor array contains a non-index property.');
            }
            return `[${value.map((entry) => canonicalize(entry, stack)).join(',')}]`;
        }
        if (!isPlainObject(value)) {
            fail('PLOINKY_DESCRIPTOR_CANONICAL_JSON_INVALID', 'Generated-local descriptor contains a non-plain object.');
        }
        const descriptors = Object.getOwnPropertyDescriptors(value);
        const ownKeys = Reflect.ownKeys(value);
        if (ownKeys.some((key) => typeof key !== 'string')) {
            fail('PLOINKY_DESCRIPTOR_CANONICAL_JSON_INVALID', 'Generated-local descriptor contains a symbol key.');
        }
        for (const key of ownKeys) {
            const property = descriptors[key];
            if (!property?.enumerable || property.get || property.set) {
                fail('PLOINKY_DESCRIPTOR_CANONICAL_JSON_INVALID', 'Generated-local descriptor contains a non-data property.');
            }
        }
        const keys = ownKeys.sort();
        return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key], stack)}`).join(',')}}`;
    } finally {
        stack.delete(value);
    }
}

export function canonicalJSONStringify(value) {
    return canonicalize(value, new Set());
}

function decodeCanonicalBase64url(value, expectedLength, description) {
    const raw = String(value || '');
    if (!raw || !BASE64URL_PATTERN.test(raw) || raw.includes('=')) {
        fail('PLOINKY_DESCRIPTOR_BASE64URL_INVALID', `${description} is not canonical base64url.`);
    }
    let decoded;
    try {
        decoded = Buffer.from(raw, 'base64url');
    } catch (error) {
        fail('PLOINKY_DESCRIPTOR_BASE64URL_INVALID', `${description} is not valid base64url.`, { cause: error });
    }
    if (decoded.length !== expectedLength || decoded.toString('base64url') !== raw) {
        fail('PLOINKY_DESCRIPTOR_BASE64URL_INVALID', `${description} has an invalid encoded length.`);
    }
    return decoded;
}

function signatureInput(payloadBytes) {
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(payloadBytes.length));
    return Buffer.concat([SIGNATURE_DOMAIN, length, payloadBytes]);
}

function validateTrustAnchor(rawPublicKey, rawSource) {
    if (String(rawSource || '') !== 'generated') {
        fail(
            'PLOINKY_DESCRIPTOR_TRUST_ANCHOR_SOURCE_INVALID',
            'Generated-local trust anchor is not marked as runtime-generated.'
        );
    }
    const publicKeyBytes = decodeCanonicalBase64url(
        rawPublicKey,
        32,
        'Generated-local trust anchor'
    );
    let keyObject;
    try {
        keyObject = createPublicKey({
            key: Buffer.concat([ED25519_SPKI_PREFIX, publicKeyBytes]),
            format: 'der',
            type: 'spki',
        });
    } catch (error) {
        fail('PLOINKY_DESCRIPTOR_TRUST_ANCHOR_INVALID', 'Generated-local trust anchor is not an Ed25519 public key.', { cause: error });
    }
    return Object.freeze({
        encoded: String(rawPublicKey),
        keyObject,
    });
}

// This capture happens when the module is evaluated. modelsConfigLoader imports
// this module before it reads a project .env, so a dotenv file can never replace
// the runtime-owned trust anchor used for descriptor verification.
const capturedTrustAnchorValue = process.env.PLOINKY_AGENT_API_PUBLIC_KEY;
const capturedTrustAnchorSource = process.env.PLOINKY_ENV_SOURCE_PLOINKY_AGENT_API_PUBLIC_KEY;

function capturedTrustAnchor() {
    return validateTrustAnchor(capturedTrustAnchorValue, capturedTrustAnchorSource);
}

export function isGeneratedLocalRuntimeName(name) {
    const normalized = String(name || '');
    return GENERATED_LOCAL_BUNDLE_NAMES.has(normalized)
        || normalized.startsWith('PLOINKY_ENV_SOURCE_PLOINKY_');
}

export function hasGeneratedLocalDescriptorBundle(env = process.env) {
    // Agent identity and generation are shared by every Ploinky runtime. They
    // become generated-local evidence only when paired with generated source
    // markers or a descriptor-/Router-/credential-specific signal.
    for (const name of GENERATED_LOCAL_SIGNAL_NAMES) {
        if (Object.hasOwn(env, name)) return true;
    }
    for (const name of GENERATED_LOCAL_SOURCE_NAMES) {
        if (Object.hasOwn(env, name)) return true;
    }
    for (const name of Object.keys(env)) {
        if (name.startsWith('PLOINKY_ENV_SOURCE_PLOINKY_')) return true;
    }
    return false;
}

function requireExactString(payload, field) {
    const value = payload[field];
    if (typeof value !== 'string' || !value || value !== value.trim()) {
        fail('PLOINKY_DESCRIPTOR_PAYLOAD_INVALID', `Generated-local descriptor field "${field}" must be a nonempty exact string.`);
    }
    return value;
}

function validateOrigin(raw, field) {
    let parsed;
    try {
        parsed = new URL(raw);
    } catch (error) {
        fail('PLOINKY_DESCRIPTOR_ORIGIN_INVALID', `Generated-local descriptor field "${field}" is not a valid URL origin.`, { cause: error });
    }
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
        || parsed.username
        || parsed.password
        || parsed.pathname !== '/'
        || parsed.search
        || parsed.hash
        || parsed.origin !== raw) {
        fail('PLOINKY_DESCRIPTOR_ORIGIN_INVALID', `Generated-local descriptor field "${field}" must be an exact HTTP(S) origin.`);
    }
    return parsed;
}

function validateAuthority(raw, field) {
    if (!raw
        || /[\u0000-\u0020\u007f]/.test(raw)
        || raw.includes('/')
        || raw.includes('\\')
        || raw.includes('@')
        || raw.includes('?')
        || raw.includes('#')) {
        fail('PLOINKY_DESCRIPTOR_AUTHORITY_INVALID', `Generated-local descriptor field "${field}" is not a valid wire authority.`);
    }
    let parsed;
    try {
        parsed = new URL(`http://${raw}/`);
    } catch (error) {
        fail('PLOINKY_DESCRIPTOR_AUTHORITY_INVALID', `Generated-local descriptor field "${field}" is not a valid wire authority.`, { cause: error });
    }
    if (parsed.host !== raw || !parsed.hostname || !parsed.port) {
        fail('PLOINKY_DESCRIPTOR_AUTHORITY_INVALID', `Generated-local descriptor field "${field}" must include an exact hostname and port.`);
    }
    return parsed;
}

function validatePayload(payload) {
    if (!isPlainObject(payload)) {
        fail('PLOINKY_DESCRIPTOR_PAYLOAD_INVALID', 'Generated-local descriptor payload must be a plain object.');
    }
    const payloadKeys = Object.keys(payload);
    if (payloadKeys.length !== DESCRIPTOR_PAYLOAD_FIELDS.length
        || payloadKeys.some((key) => !DESCRIPTOR_PAYLOAD_FIELD_SET.has(key))) {
        fail('PLOINKY_DESCRIPTOR_PAYLOAD_INVALID', 'Generated-local descriptor payload has missing or unknown fields.');
    }
    if (payload.schema !== GENERATED_LOCAL_DESCRIPTOR_SCHEMA) {
        fail('PLOINKY_DESCRIPTOR_SCHEMA_UNSUPPORTED', 'Generated-local descriptor schema is unsupported.');
    }

    const requiredStrings = [
        'agentPrincipal',
        'attestationId',
        'edgeTopologyFile',
        'generationId',
        'instanceId',
        'internalRouterUrl',
        'launchId',
        'listenerClass',
        'localStreaming',
        'networkFingerprint',
        'physicalOrigin',
        'publicAuthority',
        'requestAuthority',
        'routerHost',
        'routerPort',
        'semanticTopologyDigest',
        'socketLocalAddressClass',
        'topology',
        'transportVersion',
    ];
    for (const field of requiredStrings) requireExactString(payload, field);

    if (payload.transportVersion !== GENERATED_LOCAL_TRANSPORT_VERSION) {
        fail('PLOINKY_DESCRIPTOR_TRANSPORT_UNSUPPORTED', 'Generated-local descriptor transport version is unsupported.');
    }
    if (payload.expiresAtUnixMs !== null) {
        fail('PLOINKY_DESCRIPTOR_EXPIRY_INVALID', 'Generated-local descriptor v1 expiry must be exactly null.');
    }
    if (!Number.isSafeInteger(payload.issuedAtUnixMs) || payload.issuedAtUnixMs < 0) {
        fail('PLOINKY_DESCRIPTOR_ISSUED_AT_INVALID', 'Generated-local descriptor issuedAtUnixMs is invalid.');
    }
    if (payload.localStreaming !== 'disabled' && payload.localStreaming !== 'enabled') {
        fail('PLOINKY_DESCRIPTOR_STREAMING_INVALID', 'Generated-local descriptor localStreaming capability is invalid.');
    }
    if (payload.listenerClass !== 'public' && payload.listenerClass !== 'managed') {
        fail('PLOINKY_DESCRIPTOR_LISTENER_INVALID', 'Generated-local descriptor listener class is invalid.');
    }
    if (!SHA256_PATTERN.test(payload.attestationId)
        || !SHA256_PATTERN.test(payload.networkFingerprint)
        || !SHA256_PATTERN.test(payload.semanticTopologyDigest)) {
        fail('PLOINKY_DESCRIPTOR_DIGEST_INVALID', 'Generated-local descriptor contains an invalid SHA-256 identity.');
    }
    if (!isPlainObject(payload.runtimeProof)) {
        fail('PLOINKY_DESCRIPTOR_RUNTIME_PROOF_INVALID', 'Generated-local descriptor runtimeProof must be a plain object.');
    }

    const physicalOrigin = validateOrigin(payload.physicalOrigin, 'physicalOrigin');
    validateOrigin(payload.internalRouterUrl, 'internalRouterUrl');
    const publicAuthority = validateAuthority(payload.publicAuthority, 'publicAuthority');
    const requestAuthority = validateAuthority(payload.requestAuthority, 'requestAuthority');

    const publicMatch = LOOPBACK_AUTHORITY_PATTERN.exec(publicAuthority.host);
    if (!publicMatch || Number(publicMatch[1]) > 65535) {
        fail('PLOINKY_DESCRIPTOR_AUTHORITY_CELL_INVALID', 'Generated-local public authority must be canonical IPv4 loopback with a valid port.');
    }

    if (physicalOrigin.hostname.toLowerCase() !== payload.routerHost.toLowerCase()
        || String(physicalOrigin.port || (physicalOrigin.protocol === 'https:' ? 443 : 80)) !== payload.routerPort) {
        fail('PLOINKY_DESCRIPTOR_ROUTER_MIRROR_INVALID', 'Generated-local descriptor router host/port do not match its physical origin.');
    }
    if (payload.socketLocalAddressClass !== payload.listenerClass) {
        fail('PLOINKY_DESCRIPTOR_LISTENER_INVALID', 'Generated-local listener and socket address classes must match.');
    }
    if (payload.listenerClass === 'public' && requestAuthority.host !== publicAuthority.host) {
        fail('PLOINKY_DESCRIPTOR_AUTHORITY_CELL_INVALID', 'Public generated-local descriptors must use the public request authority.');
    }
    if (payload.listenerClass === 'managed'
        && (requestAuthority.host !== 'host.containers.internal:8080'
            || requestAuthority.host === publicAuthority.host)) {
        fail('PLOINKY_DESCRIPTOR_AUTHORITY_CELL_INVALID', 'Managed generated-local descriptors must use the exact distinct managed Router authority.');
    }
    if (payload.semanticTopologyDigest !== semanticTopologyDigest(payload)) {
        fail('PLOINKY_DESCRIPTOR_SEMANTIC_DIGEST_INVALID', 'Generated-local descriptor semantic topology digest does not match its exact inputs.');
    }

    // Traverse the complete payload through the canonicalizer now, before any
    // mirror or credential lookup can use it.
    canonicalJSONStringify(payload);
    return physicalOrigin;
}

function semanticTopologyDigest(payload) {
    const topology = {
        listenerClass: payload.listenerClass,
        localStreaming: payload.localStreaming,
        networkFingerprint: payload.networkFingerprint,
        physicalOrigin: payload.physicalOrigin,
        publicAuthority: payload.publicAuthority,
        requestAuthority: payload.requestAuthority,
        runtimeProof: payload.runtimeProof,
        socketLocalAddressClass: payload.socketLocalAddressClass,
        topology: payload.topology,
        transportVersion: payload.transportVersion,
    };
    return `sha256:${createHash('sha256').update(canonicalJSONStringify(topology), 'utf8').digest('hex')}`;
}

function requiredMirrors(payload, descriptorFile, publicKey) {
    return new Map([
        ['PLOINKY_ROUTER_DESCRIPTOR_FILE', descriptorFile],
        ['PLOINKY_ROUTER_HOST', payload.routerHost],
        ['PLOINKY_ROUTER_PORT', payload.routerPort],
        ['PLOINKY_ROUTER_URL', payload.physicalOrigin],
        ['PLOINKY_ROUTER_REQUEST_AUTHORITY', payload.requestAuthority],
        ['PLOINKY_ROUTER_AUTHORITY', payload.publicAuthority],
        ['PLOINKY_INTERNAL_ROUTER_URL', payload.internalRouterUrl],
        ['PLOINKY_EDGE_TOPOLOGY_FILE', payload.edgeTopologyFile],
        ['PLOINKY_ROUTER_LISTENER_CLASS', payload.listenerClass],
        ['PLOINKY_ROUTER_ATTESTATION_ID', payload.attestationId],
        ['PLOINKY_ROUTER_TRANSPORT_VERSION', payload.transportVersion],
        ['PLOINKY_ROUTER_LOCAL_STREAMING', payload.localStreaming],
        ['PLOINKY_AGENT_ID', payload.agentPrincipal],
        ['PLOINKY_AGENT_PRINCIPAL', payload.agentPrincipal],
        ['PLOINKY_AGENT_INSTANCE_ID', payload.instanceId],
        ['PLOINKY_AGENT_ENABLE_GENERATION', payload.generationId],
        ['PLOINKY_AGENT_API_PUBLIC_KEY', publicKey],
    ]);
}

function validateMirrors(env, payload, descriptorFile, publicKey) {
    for (const [name, expected] of requiredMirrors(payload, descriptorFile, publicKey)) {
        if (String(env[name] ?? '') !== String(expected)) {
            fail('PLOINKY_DESCRIPTOR_MIRROR_MISMATCH', `Generated-local runtime mirror "${name}" does not match the signed descriptor.`);
        }
        if (String(env[`PLOINKY_ENV_SOURCE_${name}`] ?? '') !== 'generated') {
            fail('PLOINKY_DESCRIPTOR_SOURCE_MISMATCH', `Generated-local runtime mirror "${name}" is not marked as generated.`);
        }
    }
    if (String(env.PLOINKY_ENV_SOURCE_PLOINKY_AGENT_API_KEY ?? '') !== 'generated') {
        fail('PLOINKY_DESCRIPTOR_SOURCE_MISMATCH', 'Generated-local API key is not marked as generated.');
    }
    if (!Object.hasOwn(env, 'PLOINKY_AGENT_API_KEY')) {
        fail('PLOINKY_DESCRIPTOR_MIRROR_MISMATCH', 'Generated-local API key mirror is missing.');
    }
}

function deepFreeze(value, seen = new Set()) {
    if (value === null || typeof value !== 'object' || seen.has(value)) return value;
    seen.add(value);
    for (const child of Object.values(value)) deepFreeze(child, seen);
    return Object.freeze(value);
}

function readDescriptorFile(descriptorFile) {
    if (!path.isAbsolute(descriptorFile) || descriptorFile.includes('\0')) {
        fail('PLOINKY_DESCRIPTOR_FILE_INVALID', 'Generated-local descriptor path must be absolute.');
    }
    let pathStats;
    try {
        pathStats = fs.lstatSync(descriptorFile, { bigint: true });
    } catch (error) {
        fail('PLOINKY_DESCRIPTOR_FILE_UNREADABLE', 'Generated-local descriptor file is unavailable.', { cause: error });
    }
    if (
        !pathStats.isFile()
        || pathStats.isSymbolicLink()
        || pathStats.size <= 0n
        || pathStats.size > BigInt(MAX_DESCRIPTOR_BYTES)
    ) {
        fail('PLOINKY_DESCRIPTOR_FILE_INVALID', 'Generated-local descriptor file must be a bounded regular non-symlink file.');
    }

    let descriptorFd;
    try {
        const noFollow = fs.constants.O_NOFOLLOW || 0;
        descriptorFd = fs.openSync(descriptorFile, fs.constants.O_RDONLY | noFollow);
        const before = fs.fstatSync(descriptorFd, { bigint: true });
        if (
            !before.isFile()
            || before.dev !== pathStats.dev
            || before.ino !== pathStats.ino
            || before.size !== pathStats.size
            || before.size <= 0n
            || before.size > BigInt(MAX_DESCRIPTOR_BYTES)
        ) {
            fail('PLOINKY_DESCRIPTOR_FILE_INVALID', 'Generated-local descriptor file changed before it could be read.');
        }

        const sourceBytes = Buffer.alloc(Number(before.size));
        let offset = 0;
        while (offset < sourceBytes.length) {
            const read = fs.readSync(descriptorFd, sourceBytes, offset, sourceBytes.length - offset, offset);
            if (read === 0) break;
            offset += read;
        }
        const after = fs.fstatSync(descriptorFd, { bigint: true });
        if (
            offset !== sourceBytes.length
            || after.dev !== before.dev
            || after.ino !== before.ino
            || after.size !== before.size
            || after.mtimeNs !== before.mtimeNs
            || after.ctimeNs !== before.ctimeNs
        ) {
            fail('PLOINKY_DESCRIPTOR_FILE_INVALID', 'Generated-local descriptor file changed while it was being read.');
        }
        return sourceBytes;
    } catch (error) {
        if (error?.code?.startsWith?.('PLOINKY_DESCRIPTOR_')) throw error;
        fail('PLOINKY_DESCRIPTOR_FILE_UNREADABLE', 'Generated-local descriptor file cannot be read.', { cause: error });
    } finally {
        if (descriptorFd !== undefined) {
            try {
                fs.closeSync(descriptorFd);
            } catch {
                // The verified bytes remain safe to reject or consume; closing
                // failure must not replace a more precise validation error.
            }
        }
    }
}

export function loadGeneratedLocalRouterDescriptor({ env = process.env } = {}) {
    if (!hasGeneratedLocalDescriptorBundle(env)) return null;

    // The API-key value is deliberately not read here. Only its source marker
    // is validated; the value is read by a request path after every check.
    const trustAnchor = capturedTrustAnchor();
    const descriptorFile = String(env.PLOINKY_ROUTER_DESCRIPTOR_FILE || '');
    const sourceBytes = readDescriptorFile(descriptorFile);

    let envelope;
    try {
        envelope = JSON.parse(sourceBytes.toString('utf8'));
    } catch (error) {
        fail('PLOINKY_DESCRIPTOR_JSON_INVALID', 'Generated-local descriptor file is not valid JSON.', { cause: error });
    }
    if (!isPlainObject(envelope)
        || Object.keys(envelope).length !== 2
        || !Object.hasOwn(envelope, 'payload')
        || !Object.hasOwn(envelope, 'signature')) {
        fail('PLOINKY_DESCRIPTOR_ENVELOPE_INVALID', 'Generated-local descriptor envelope must contain only payload and signature.');
    }

    const canonicalEnvelope = canonicalJSONStringify(envelope);
    if (!sourceBytes.equals(Buffer.from(canonicalEnvelope, 'utf8'))) {
        fail('PLOINKY_DESCRIPTOR_ENVELOPE_NONCANONICAL', 'Generated-local descriptor envelope bytes are not canonical JSON.');
    }

    validatePayload(envelope.payload);
    const payloadBytes = Buffer.from(canonicalJSONStringify(envelope.payload), 'utf8');
    const signature = decodeCanonicalBase64url(envelope.signature, 64, 'Generated-local descriptor signature');
    if (!verifySignature(null, signatureInput(payloadBytes), trustAnchor.keyObject, signature)) {
        fail('PLOINKY_DESCRIPTOR_SIGNATURE_INVALID', 'Generated-local descriptor signature verification failed.');
    }

    validateMirrors(env, envelope.payload, descriptorFile, trustAnchor.encoded);

    const result = {
        payload: deepFreeze(envelope.payload),
        signature: envelope.signature,
        descriptorFile,
        envelopeDigest: `sha256:${createHash('sha256').update(sourceBytes).digest('hex')}`,
    };
    deepFreeze(result);
    verifiedDescriptors.add(result);
    return result;
}

export function isVerifiedGeneratedLocalRouterDescriptor(value) {
    return Boolean(value && verifiedDescriptors.has(value));
}

export function assertVerifiedGeneratedLocalRouterDescriptor(value) {
    if (!isVerifiedGeneratedLocalRouterDescriptor(value)) {
        fail('PLOINKY_DESCRIPTOR_BRAND_INVALID', 'Generated-local provider requires a verified descriptor brand.');
    }
    return value;
}

export function refreshGeneratedLocalRouterDescriptor(expected, { env = process.env } = {}) {
    assertVerifiedGeneratedLocalRouterDescriptor(expected);
    const current = loadGeneratedLocalRouterDescriptor({ env });
    if (!current || current.envelopeDigest !== expected.envelopeDigest) {
        fail('PLOINKY_DESCRIPTOR_CHANGED', 'Generated-local descriptor changed after provider construction.');
    }
    return current;
}

export function buildGeneratedLocalOperationURL(descriptor, pathname) {
    assertVerifiedGeneratedLocalRouterDescriptor(descriptor);
    if (pathname !== GENERATED_LOCAL_CHAT_PATH && pathname !== GENERATED_LOCAL_MODELS_PATH) {
        fail('PLOINKY_DESCRIPTOR_OPERATION_DENIED', 'Generated-local Router operation path is not certified.');
    }
    const url = new URL(pathname, descriptor.payload.physicalOrigin);
    if (url.origin !== descriptor.payload.physicalOrigin
        || url.pathname !== pathname
        || url.search
        || url.hash
        || url.username
        || url.password) {
        fail('PLOINKY_DESCRIPTOR_OPERATION_DENIED', 'Generated-local Router operation URL is not exact.');
    }
    return url;
}

export function assertNoGeneratedLocalProtectedOverrides(value, description = 'Generated-local configuration') {
    if (value === null || value === undefined) return;
    if (!isPlainObject(value)) {
        fail('PLOINKY_GENERATED_LOCAL_OVERRIDE', `${description} must be a plain object.`);
    }
    const protectedNames = ['baseURL', 'apiKey', 'apiKeyEnv', 'transport', 'headers', 'providerKey'];
    for (const name of protectedNames) {
        if (Object.hasOwn(value, name)) {
            fail('PLOINKY_GENERATED_LOCAL_OVERRIDE', `${description} cannot define protected property "${name}".`);
        }
    }
}
