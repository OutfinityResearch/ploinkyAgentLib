import FlexSearch from 'flexsearch';

const DEFAULT_TYPE = 'index';

const STATIC_METHODS = [
    'registerEncoder',
    'registerDecoder',
    'registerLanguage',
    'registerMatcher',
    'registerPipeline',
    'registerStemmer',
    'release',
];

function inferTypeFromInstance(candidate) {
    if (typeof candidate?.get === 'function' || typeof candidate?.set === 'function') {
        return 'document';
    }
    return DEFAULT_TYPE;
}

function isFlexSearchInstance(candidate) {
    return Boolean(candidate && typeof candidate === 'object' && typeof candidate.add === 'function' && typeof candidate.search === 'function');
}

function resolveConstructor(flexsearchLib, type) {
    const lib = flexsearchLib || FlexSearch;
    if (!lib) {
        throw new Error('FlexSearch module is not available.');
    }
    const upperType = (typeof type === 'string' ? type : DEFAULT_TYPE).toLowerCase();
    if (upperType === 'document') {
        if (!lib.Document) {
            throw new Error('FlexSearch.Document constructor is not available.');
        }
        return lib.Document;
    }
    if (!lib.Index) {
        throw new Error('FlexSearch.Index constructor is not available.');
    }
    return lib.Index;
}

function exposeInstanceMethods(target, source) {
    if (!source) {
        return;
    }

    const seen = new Set();

    const bindMethod = (methodName, methodFn) => {
        if (seen.has(methodName)) {
            return;
        }
        if (methodName === 'constructor' || methodName in target) {
            return;
        }
        if (typeof methodFn === 'function') {
            Object.defineProperty(target, methodName, {
                value: methodFn.bind(source),
                writable: false,
                enumerable: false,
            });
            seen.add(methodName);
        }
    };

    let proto = Object.getPrototypeOf(source);
    while (proto && proto !== Object.prototype) {
        for (const name of Object.getOwnPropertyNames(proto)) {
            const descriptor = Object.getOwnPropertyDescriptor(proto, name);
            if (descriptor && typeof descriptor.value === 'function') {
                bindMethod(name, descriptor.value);
            }
        }
        proto = Object.getPrototypeOf(proto);
    }

    for (const name of Object.keys(source)) {
        const value = source[name];
        if (typeof value === 'function') {
            bindMethod(name, value);
        }
    }
}

export class FlexSearchAdapter {
    constructor(configOrInstance = {}, options = {}) {
        const typeProvided = options && Object.prototype.hasOwnProperty.call(options, 'type');
        const typeHint = typeProvided ? options.type : undefined;
        const flexsearchLib = options?.flexsearch;
        if (isFlexSearchInstance(configOrInstance)) {
            this.index = configOrInstance;
            this.config = options.config || null;
            this.type = typeof typeHint === 'string' ? typeHint : inferTypeFromInstance(this.index);
        } else {
            const ctor = resolveConstructor(flexsearchLib, typeHint);
            this.config = configOrInstance || {};
            this.index = new ctor(this.config);
            this.type = typeof typeHint === 'string' ? typeHint : DEFAULT_TYPE;
        }
        exposeInstanceMethods(this, this.index);
    }

    getIndex() {
        return this.index;
    }

    getType() {
        return this.type;
    }

    clone(overrides = {}) {
        const nextConfig = { ...(this.config || {}), ...overrides };
        return new FlexSearchAdapter(nextConfig, { type: this.type });
    }

    hasMethod(name) {
        return typeof this.index?.[name] === 'function';
    }
}

for (const methodName of STATIC_METHODS) {
    if (typeof FlexSearch?.[methodName] === 'function') {
        Object.defineProperty(FlexSearchAdapter, methodName, {
            value: (...args) => FlexSearch[methodName](...args),
            writable: false,
            enumerable: false,
        });
    }
}

export function createFlexSearchAdapter(config = {}, options = {}) {
    return new FlexSearchAdapter(config, options);
}

export function fromFlexSearchInstance(instance, options = {}) {
    if (!isFlexSearchInstance(instance)) {
        throw new TypeError('fromFlexSearchInstance expects a FlexSearch index instance.');
    }
    return new FlexSearchAdapter(instance, { ...options, config: options.config || null });
}

export default FlexSearchAdapter;
