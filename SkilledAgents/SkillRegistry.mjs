import { createFlexSearchAdapter } from './search/flexsearchAdapter.mjs';

const DEFAULT_INDEX_OPTIONS = {
    tokenize: 'forward',
};

const SEARCHABLE_FIELDS = ['name', 'what', 'why', 'description', 'arguments', 'requiredArguments', 'roles'];

const VALIDATOR_PREFIX = '@';
const ENUMERATOR_PREFIX = '%';
const RESOLVER_PREFIX = '&';

function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeToken(token) {
    if (typeof token !== 'string') {
        return '';
    }
    return token.trim();
}

function stripPrefix(value, prefix) {
    if (!value || !prefix) {
        return value;
    }
    return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

function resolveHandler(skillObj, name, kind) {
    if (!name) {
        return null;
    }

    const direct = skillObj && typeof skillObj[name] === 'function' ? skillObj[name] : null;
    if (direct) {
        return direct.bind(skillObj);
    }

    const containerNames = (() => {
        switch (kind) {
        case 'validator':
            return ['argumentValidators', 'validators', 'validationHandlers'];
        case 'enumerator':
            return ['argumentEnumerators', 'enumerators', 'optionProviders'];
        case 'resolver':
            return ['argumentResolvers', 'resolvers', 'valueResolvers', 'lookups'];
        case 'presenter':
            return ['argumentPresenters', 'presenters', 'valuePresenters', 'formatters'];
        default:
            return [];
        }
    })();

    for (const containerName of containerNames) {
        const container = skillObj && isPlainObject(skillObj[containerName]) ? skillObj[containerName] : null;
        if (!container) {
            continue;
        }
        const handler = typeof container[name] === 'function' ? container[name] : null;
        if (handler) {
            return handler.bind(skillObj);
        }
    }

    return null;
}

function normalizeArgumentDefinition(argumentName, rawDefinition, skillObj) {
    if (!isPlainObject(rawDefinition)) {
        throw new TypeError(`Argument "${argumentName}" must be described with an object definition.`);
    }

    const description = typeof rawDefinition.description === 'string' ? rawDefinition.description : '';
    const llmHint = typeof rawDefinition.llmHint === 'string' ? rawDefinition.llmHint : '';

    const defaultValue = Object.prototype.hasOwnProperty.call(rawDefinition, 'default')
        ? rawDefinition.default
        : (Object.prototype.hasOwnProperty.call(rawDefinition, 'defaultValue') ? rawDefinition.defaultValue : undefined);

    const typeToken = normalizeToken(rawDefinition.type);
    const validatorToken = normalizeToken(rawDefinition.validator || rawDefinition.validation || rawDefinition.validate);
    const enumToken = normalizeToken(rawDefinition.enum || rawDefinition.enumerator || rawDefinition.optionsProvider);
    const resolverToken = normalizeToken(rawDefinition.resolver || rawDefinition.resolve || rawDefinition.lookup || rawDefinition.valueResolver);
    const presenterToken = normalizeToken(rawDefinition.presenter || rawDefinition.display || rawDefinition.present || rawDefinition.valuePresenter);

    let baseType = null;
    let validatorName = validatorToken ? stripPrefix(validatorToken, VALIDATOR_PREFIX) : '';
    let enumeratorName = enumToken ? stripPrefix(enumToken, ENUMERATOR_PREFIX) : '';
    let resolverName = resolverToken ? stripPrefix(resolverToken, RESOLVER_PREFIX) : '';
    let presenterName = presenterToken ? presenterToken : '';

    if (typeToken) {
        if (typeToken.startsWith(VALIDATOR_PREFIX)) {
            validatorName = stripPrefix(typeToken, VALIDATOR_PREFIX);
        } else if (typeToken.startsWith(ENUMERATOR_PREFIX)) {
            enumeratorName = stripPrefix(typeToken, ENUMERATOR_PREFIX);
        } else if (!baseType) {
            baseType = typeToken.toLowerCase();
        }
    }

    if (!baseType) {
        const fallback = normalizeToken(rawDefinition.valueType || rawDefinition.baseType);
        baseType = fallback ? fallback.toLowerCase() : 'string';
    }

    const staticOptions = Array.isArray(rawDefinition.options) ? rawDefinition.options.slice() : null;

    let validator = validatorName ? resolveHandler(skillObj, validatorName, 'validator') : null;
    if (validatorName && !validator && typeof rawDefinition.validator === 'function') {
        validator = rawDefinition.validator.bind(skillObj);
    }
    if (!validator && typeof rawDefinition.validator === 'function') {
        validator = rawDefinition.validator.bind(skillObj);
    }

    let enumerator = enumeratorName ? resolveHandler(skillObj, enumeratorName, 'enumerator') : null;
    if (enumeratorName && !enumerator && typeof rawDefinition.enum === 'function') {
        enumerator = rawDefinition.enum.bind(skillObj);
    }
    if (!enumerator && typeof rawDefinition.enum === 'function') {
        enumerator = rawDefinition.enum.bind(skillObj);
    }

    if (validatorName && !validator) {
        throw new Error(`Validator "${validatorName}" for argument "${argumentName}" was not found on the skill module.`);
    }

    if (enumeratorName && !enumerator) {
        throw new Error(`Enumerator "${enumeratorName}" for argument "${argumentName}" was not found on the skill module.`);
    }

    const resolverHandler = resolverName ? resolveHandler(skillObj, resolverName, 'resolver') : null;
    const presenterHandler = presenterName ? resolveHandler(skillObj, presenterName, 'presenter') : null;

    let resolver = resolverHandler;
    if (!resolver && typeof rawDefinition.resolver === 'function') {
        resolver = rawDefinition.resolver.bind(skillObj);
    } else if (!resolver && typeof rawDefinition.valueResolver === 'function') {
        resolver = rawDefinition.valueResolver.bind(skillObj);
    }

    let presenter = presenterHandler;
    if (!presenter && typeof rawDefinition.presenter === 'function') {
        presenter = rawDefinition.presenter.bind(skillObj);
    } else if (!presenter && typeof rawDefinition.valuePresenter === 'function') {
        presenter = rawDefinition.valuePresenter.bind(skillObj);
    }

    if (!enumerator && staticOptions) {
        enumerator = async () => staticOptions.slice();
        enumeratorName = ''; // indicates inline list
    }

    return {
        name: argumentName,
        description,
        llmHint,
        type: baseType,
        defaultValue,
        validatorName: validatorName || '',
        validator,
        enumeratorName: enumeratorName || '',
        enumerator,
        resolverName: resolverName || '',
        resolver,
        presenterName: presenterName || '',
        presenter,
        hasStaticOptions: Array.isArray(staticOptions),
    };
}

function toSearchableText(value) {
    if (value === null || value === undefined) {
        return '';
    }
    if (typeof value === 'string') {
        return value;
    }
    if (Array.isArray(value)) {
        return value.map(toSearchableText).join(' ');
    }
    if (typeof value === 'object') {
        try {
            return JSON.stringify(value);
        } catch (error) {
            return String(value);
        }
    }
    return String(value);
}

function normalizeSearchResults(result, { includeScores = false } = {}) {
    if (!result) {
        return [];
    }

    const output = [];

    const pushResult = (id, score = null) => {
        if (typeof id !== 'string' || !id) {
            return;
        }
        if (includeScores) {
            output.push({ id, score: typeof score === 'number' ? score : null });
        } else {
            output.push(id);
        }
    };

    const walk = (value) => {
        if (!value) {
            return;
        }
        if (Array.isArray(value)) {
            value.forEach(walk);
            return;
        }
        if (typeof value === 'string') {
            pushResult(value);
            return;
        }
        if (typeof value === 'object') {
            if (Array.isArray(value.result)) {
                walk(value.result);
                return;
            }
            if (Array.isArray(value.ids)) {
                value.ids.forEach((id) => pushResult(id));
                return;
            }
            const id = typeof value.id === 'string'
                ? value.id
                : (typeof value.doc === 'string'
                    ? value.doc
                    : (typeof value.key === 'string' ? value.key : null));
            if (id) {
                pushResult(id, value.score);
            }
        }
    };

    walk(result);
    return output;
}

function buildSearchText(skill) {
    return SEARCHABLE_FIELDS
        .map(field => toSearchableText(skill[field]))
        .filter(Boolean)
        .join(' ');
}

function normalizeSkillName(name) {
    if (typeof name !== 'string') {
        return '';
    }
    return name.trim().toLowerCase();
}

function sanitizeSpecs(specs) {
    if (!specs || typeof specs !== 'object') {
        throw new TypeError('Skill specifications must be provided as an object.');
    }

    const normalized = {};
    const normalizedArguments = {};
    let hasArguments = false;
    let requiredArguments = [];

    for (const key of Object.keys(specs)) {
        const value = specs[key];
        if (value === undefined) {
            continue;
        }

        if (key === 'arguments') {
            if (!isPlainObject(value)) {
                throw new TypeError('Skill specification "arguments" must be an object keyed by argument name.');
            }
            for (const [argName, rawDefinition] of Object.entries(value)) {
                if (typeof argName !== 'string' || !argName.trim()) {
                    throw new Error('Argument names must be non-empty strings.');
                }
                normalizedArguments[argName.trim()] = rawDefinition;
            }
            hasArguments = true;
            continue;
        }

        if (key === 'args') {
            throw new Error('Skill specification no longer supports the "args" array. Use the "arguments" object instead.');
        }

        if (key === 'requiredArgs') {
            throw new Error('Skill specification no longer supports "requiredArgs". Use "requiredArguments" instead.');
        }

        if (key === 'requiredArguments') {
            if (!Array.isArray(value)) {
                throw new TypeError('Skill specification "requiredArguments" must be an array of strings.');
            }
            requiredArguments = value
                .map(entry => (typeof entry === 'string' ? entry.trim() : ''))
                .filter(Boolean);
            continue;
        }

        normalized[key] = value;
    }

    if (!hasArguments) {
        throw new Error('Skill specification requires an "arguments" object describing inputs.');
    }

    normalized.arguments = normalizedArguments;
    normalized.requiredArguments = requiredArguments;

    if (!normalized.name || typeof normalized.name !== 'string') {
        throw new Error('Skill specification requires a "name" string.');
    }

    if (!normalized.description || typeof normalized.description !== 'string') {
        throw new Error('Skill specification requires a "description" string.');
    }

    return normalized;
}

export default class SkillRegistry {
    constructor(options = {}) {
        const { flexSearchAdapter, indexOptions } = options;
        this.index = flexSearchAdapter || createFlexSearchAdapter(indexOptions || DEFAULT_INDEX_OPTIONS);
        this.skills = new Map();
        this.actions = new Map();
    }

    registerSkill(skillObj) {
        if (!skillObj || typeof skillObj !== 'object') {
            throw new TypeError('registerSkill requires a skill configuration object.');
        }

        const { specs, action, roles } = skillObj;

        if (!specs || typeof specs !== 'object') {
            throw new TypeError('registerSkill requires a "specs" object.');
        }

        if (typeof action !== 'function') {
            throw new TypeError('registerSkill requires a function action handler.');
        }

        const normalizedSpecs = sanitizeSpecs(specs);
        const canonicalName = normalizeSkillName(normalizedSpecs.name);
        if (!canonicalName) {
            throw new Error('Skill specification requires a non-empty name.');
        }

        if (!Array.isArray(roles)) {
            throw new TypeError('registerSkill requires a "roles" array.');
        }

        const normalizedRoles = Array.from(new Set(roles
            .map(role => (typeof role === 'string' ? role.trim() : ''))
            .filter(Boolean)
            .map(role => role.toLowerCase())));

        if (!normalizedRoles.length) {
            throw new Error('registerSkill requires at least one role.');
        }

        const argumentOrder = Object.keys(normalizedSpecs.arguments);
        const argumentMetadata = {};
        const publicArguments = {};

        for (const argumentName of argumentOrder) {
            const rawDefinition = normalizedSpecs.arguments[argumentName];
            const meta = normalizeArgumentDefinition(argumentName, rawDefinition, skillObj);
            argumentMetadata[argumentName] = meta;

            const publicEntry = {};
            if (meta.type) {
                publicEntry.type = meta.type;
            }
            if (meta.description) {
                publicEntry.description = meta.description;
            }
            if (meta.llmHint) {
                publicEntry.llmHint = meta.llmHint;
            }
            if (meta.defaultValue !== undefined) {
                publicEntry.default = meta.defaultValue;
            }
            if (meta.validatorName) {
                publicEntry.validator = `${VALIDATOR_PREFIX}${meta.validatorName}`;
            }
            if (meta.enumeratorName) {
                publicEntry.enumerator = `${ENUMERATOR_PREFIX}${meta.enumeratorName}`;
            } else if (meta.enumerator) {
                publicEntry.enumerator = 'inline';
            }
            publicArguments[argumentName] = publicEntry;
        }

        const requiredArguments = Array.isArray(normalizedSpecs.requiredArguments)
            ? normalizedSpecs.requiredArguments.slice()
            : [];

        const record = {
            canonicalName,
            ...normalizedSpecs,
            arguments: publicArguments,
            requiredArguments,
            roles: normalizedRoles,
            registeredAt: new Date().toISOString(),
            argumentMetadata,
            argumentOrder,
        };

        if (this.skills.has(canonicalName)) {
            this.skills.delete(canonicalName);
            this.actions.delete(canonicalName);
            if (typeof this.index.remove === 'function') {
                try {
                    this.index.remove(canonicalName);
                } catch (error) {
                    // ignore removal issues; index will be refreshed via add below
                }
            }
        }

        this.skills.set(canonicalName, record);
        this.actions.set(canonicalName, action);

        const searchText = buildSearchText(record);
        if (searchText) {
            this.index.add(canonicalName, searchText);
        }

        return record.name;
    }

    rankSkill(taskDescription, options = {}) {
        if (!this.skills.size) {
            return [];
        }
        const query = typeof taskDescription === 'string' ? taskDescription.trim() : '';
        if (!query) {
            return [];
        }

        // Support both single role and array of roles
        let normalizedRoles = [];

        if (Array.isArray(options.roles) && options.roles.length > 0) {
            // Multiple roles provided
            normalizedRoles = options.roles
                .map(r => typeof r === 'string' ? r.trim().toLowerCase() : '')
                .filter(Boolean);
        } else {
            // Single role provided (backward compatibility)
            const normalizedRole = typeof options.role === 'string' && options.role.trim()
                ? options.role.trim().toLowerCase()
                : (typeof options.callerRole === 'string' && options.callerRole.trim()
                    ? options.callerRole.trim().toLowerCase()
                    : '');

            if (normalizedRole) {
                normalizedRoles = [normalizedRole];
            }
        }

        if (!normalizedRoles.length) {
            throw new Error('rankSkill requires a caller role for access filtering.');
        }

        const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : options.limit === 0 ? 0 : 5;
        const includeScores = options.includeScores === true;
        const searchOptions = {
            bool: options?.bool === 'and' ? 'and' : 'or',
            suggest: true,
            ...(includeScores ? { enrich: true } : {}),
            ...(limit ? { limit } : {}),
        };

        let rawResults;
        try {
            rawResults = this.index.search(query, searchOptions);
        } catch (error) {
            return [];
        }
        const matches = normalizeSearchResults(rawResults, { includeScores });
        if (!matches.length) {
            return [];
        }
        const seen = new Set();
        const filtered = [];
        for (const entry of matches) {
            const key = includeScores ? entry?.id : entry;
            const canonical = normalizeSkillName(key);
            if (!canonical || seen.has(canonical)) {
                continue;
            }
            if (this.skills.has(canonical)) {
                const record = this.skills.get(canonical);
                // Check if user has any of the required roles for this skill
                const hasAccess = Array.isArray(record.roles) && 
                    normalizedRoles.some(userRole => record.roles.includes(userRole));

                if (hasAccess) {
                    seen.add(canonical);
                    if (includeScores) {
                        filtered.push({
                            name: record.name,
                            score: typeof entry?.score === 'number' ? entry.score : null,
                        });
                    } else {
                        filtered.push(record.name);
                    }
                }
            }
            if (limit && filtered.length >= limit) {
                break;
            }
        }
        if (includeScores && filtered.length) {
            const hasNumericScore = filtered.some(item => typeof item.score === 'number' && Number.isFinite(item.score));
            if (!hasNumericScore) {
                const total = filtered.length;
                filtered.forEach((item, index) => {
                    const fallback = total === 1 ? 1 : (total - index) / total;
                    item.score = Number(fallback.toFixed(4));
                });
            }
        }
        return filtered;
    }

    getSkill(skillName) {
        const canonical = normalizeSkillName(skillName);
        if (!canonical) {
            return null;
        }
        return this.skills.get(canonical) || null;
    }

    getSkillAction(skillName) {
        const canonical = normalizeSkillName(skillName);
        if (!canonical) {
            return null;
        }
        return this.actions.get(canonical) || null;
    }

    listSkillsForRole(role) {
        const normalizedRole = typeof role === 'string' ? role.trim().toLowerCase() : '';
        if (!normalizedRole) {
            return [];
        }

        const toSummary = (record) => ({
            name: record.name,
            description: record.humanDescription || record.description || record.what || record.name,
            needConfirmation: record.needConfirmation === true,
        });

        return Array.from(this.skills.values())
            .filter(record => Array.isArray(record.roles) && record.roles.includes(normalizedRole))
            .sort((a, b) => a.name.localeCompare(b.name))
            .map(toSummary);
    }

    clear() {
        this.skills.clear();
        this.actions.clear();
        if (typeof this.index.clear === 'function') {
            this.index.clear();
        }
    }
}
