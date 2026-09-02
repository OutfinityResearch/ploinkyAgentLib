import fs from 'node:fs';
import path from 'node:path';

import { LLMAgent } from '../LLMAgents/LLMAgent.mjs';
import { getDebugLogger } from '../utils/DebugLogger.mjs';
import { Sanitiser } from '../utils/Sanitiser.mjs';

import { discoverSkills, discoverSkillsFromRoot } from './services/discoverSkills.mjs';
import { SubsystemFactory } from './services/SubsystemFactory.mjs';
import { SecuritySupervisor } from './supervisor/SecuritySupervisor.mjs';

const INTERNAL_SKILLS_DIR = path.resolve(
    new URL('.', import.meta.url).pathname,
    '../skills'
);

function joinSkillNames(skills) {
    const names = skills
        .map((skill) => skill?.name)
        .filter(Boolean);
    return names.length ? names.join(', ') : 'none';
}

function isPathInside(candidate, root) {
    if (!candidate || !root) {
        return false;
    }
    const relative = path.relative(path.resolve(root), path.resolve(candidate));
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function getSourceMtimeMs(filePath) {
    try {
        return fs.statSync(filePath).mtimeMs;
    } catch {
        return null;
    }
}

function getSkillFingerprint(skillRecord) {
    return [
        skillRecord?.type || '',
        skillRecord?.filePath || '',
        Number.isFinite(skillRecord?._sourceMtimeMs)
            ? skillRecord._sourceMtimeMs
            : getSourceMtimeMs(skillRecord?.filePath),
    ].join('|');
}

export class MainAgent {
    constructor({
        startDir = process.cwd(),
        supervisor = null,
        logger = null,
        llmAgentOptions = {},
        modelConfig = null,
        reasoningEffort = null,
        disableInternalSkills = true,
        additionalWorkspaceRoots = [],
    } = {}) {
        this.startDir = startDir;
        this.additionalWorkspaceRoots = additionalWorkspaceRoots;
        this._workspaceSkillRoots = [startDir];
        this.logger = logger || getDebugLogger();
        this.disableInternalSkills = Boolean(disableInternalSkills);
        this.reasoningEffort = reasoningEffort || null;

        this.llmAgent = new LLMAgent({ ...llmAgentOptions, modelConfig, reasoningEffort, logger: this.logger });

        this._skills = new Map();
        this._skillAliases = new Map();
        this._disabledSkillNames = new Set();
        this._orchestratorAllowedSkills = new Set();
        this._duplicateSkillEvents = [];
        this._session = null;

        this.supervisor = supervisor || new SecuritySupervisor({ logger: this.logger });

        this.subsystemFactory = new SubsystemFactory({
            mainAgent: this,
            modelConfig: this.llmAgent.modelConfig,
            logger: this.logger,
        });

        this._discoverAndRegister();
    }

    _discoverAndRegister() {
        const internalSkills = this.disableInternalSkills
            ? []
            : discoverSkillsFromRoot(INTERNAL_SKILLS_DIR, {
                logger: this.logger,
            });

        for (const record of internalSkills) {
            record.isInternal = true;
            this._registerSkill(record);
        }

        this.logger.debug(`MainAgent:internalSkills: disabled=${this.disableInternalSkills}, found ${internalSkills.length} skills: ${joinSkillNames(internalSkills)}`);

        const { roots, skills: userSkills } = this._discoverWorkspaceSkills();
        this._workspaceSkillRoots = roots;

        for (const record of userSkills) {
            record.isInternal = false;
            this._registerSkill(record);
        }

        this.logger.debug(`MainAgent:workspaceSkills: found ${userSkills.length} skills: ${joinSkillNames(userSkills)}`);

        this._refreshOrchestratedSkillIndex();
        this.debugSkillRegistrationSummary({ phase: 'constructor' });
    }

    _discoverWorkspaceSkills() {
        const additionalRoots = typeof this.additionalWorkspaceRoots === 'function'
            ? this.additionalWorkspaceRoots()
            : this.additionalWorkspaceRoots;
        if (!Array.isArray(additionalRoots) || additionalRoots.some(root => typeof root !== 'string' || !root)) {
            throw new TypeError('additionalWorkspaceRoots must provide an array of non-empty directory paths.');
        }
        const roots = [...new Set([this.startDir, ...additionalRoots].map(root => path.resolve(root)))];
        const records = new Map();
        for (const root of roots) {
            for (const record of discoverSkills(root, { logger: this.logger })) {
                if (!records.has(record.filePath)) records.set(record.filePath, record);
            }
        }
        return { roots, skills: [...records.values()] };
    }

    debugSkillRegistrationSummary(context = {}) {
        const skills = Array.from(this._skills.values()).map((skill) => ({
            name: skill.name,
            shortName: skill.shortName,
            type: skill.type,
            isInternal: Boolean(skill.isInternal),
            skillDir: skill.skillDir,
            enabled: skill.enabled !== false,
        }));
        const availableSkills = skills.filter((skill) => skill.enabled !== false
            && !this._orchestratorAllowedSkills.has(skill.name));
        const phase = context.phase ? ` phase=${context.phase}` : '';

        if (Array.isArray(context.additionalRoots) && context.additionalRoots.length) {
            const rootSummary = context.additionalRoots
                .map((root) => `${root.skillRoot}: ${root.discoveredCount} skills`)
                .join('; ');
            this.logger.debug(`MainAgent:additionalSkillRoots:${phase}: ${rootSummary}`);
        }

        this.logger.debug(`MainAgent:registeredSkills:${phase}: registered=${skills.length}, available=${availableSkills.length}, orchestratedHidden=${this._orchestratorAllowedSkills.size}, aliases=${this._skillAliases.size}, duplicates=${this._duplicateSkillEvents.length}`);
        this.logger.debug(`MainAgent:availableSkills:${phase}: ${joinSkillNames(availableSkills)}`);
        this.logger.debug(`MainAgent:allRegisteredSkills:${phase}: ${joinSkillNames(skills)}`);
        if (this._duplicateSkillEvents.length) {
            const duplicates = this._duplicateSkillEvents
                .map((entry) => `${entry.name}: ${entry.existing.skillDir} -> ${entry.replacement.skillDir}`)
                .join('; ');
            this.logger.debug(`MainAgent:duplicateSkills:${phase}: ${duplicates}`);
        }
    }

    _refreshOrchestratedSkillIndex() {
        const orchestratorAllowedSkills = new Set();

        for (const skillRecord of this._skills.values()) {
            if (skillRecord.enabled === false || skillRecord.type !== 'orchestrator') {
                continue;
            }

            const declaredSkillNames = [
                ...(skillRecord.preparedConfig?.allowedSkills || []),
                ...(skillRecord.preparedConfig?.allowedPrepSkills || []),
            ];

            for (const declaredName of declaredSkillNames) {
                const targetRecord = this.getSkillRecord(declaredName);
                if (!targetRecord || targetRecord.enabled === false || targetRecord.name === skillRecord.name) {
                    continue;
                }
                orchestratorAllowedSkills.add(targetRecord.name);
            }
        }

        this._orchestratorAllowedSkills = orchestratorAllowedSkills;

        const skills = Array.from(orchestratorAllowedSkills);
        this.logger.debug(`MainAgent:orchestratedSkills: hiding ${skills.length} skills from top-level tool surface: ${skills.length ? skills.join(', ') : 'none'}`);
    }

    _registerSkill(skillRecord) {
        const { name, type, shortName, descriptor, skillDir } = skillRecord;
        skillRecord._sourceMtimeMs = getSourceMtimeMs(skillRecord.filePath);
        skillRecord.enabled = !this._disabledSkillNames.has(name);

        const baseName = sanitiseName(descriptor?.name || shortName);
        const aliases = new Set([
            name,
            sanitiseName(name),
            shortName,
            sanitiseName(shortName),
            baseName,
        ].filter(Boolean));

        if (this._skills.has(name)) {
            const existing = this._skills.get(name);
            const duplicateEvent = {
                name,
                type,
                shortName,
                existing: {
                    skillDir: existing.skillDir,
                    type: existing.type,
                    shortName: existing.shortName,
                    isInternal: Boolean(existing.isInternal),
                },
                replacement: {
                    skillDir,
                    type,
                    shortName,
                    isInternal: Boolean(skillRecord.isInternal),
                },
                registered: {
                    skillDir,
                    type,
                    shortName,
                    isInternal: Boolean(skillRecord.isInternal),
                },
            };
            this._duplicateSkillEvents.push(duplicateEvent);
            this.logger.debug(`MainAgent:duplicateSkill: ${name}: replacing ${existing.skillDir} with ${skillDir}`);
        }

        this._skills.set(name, skillRecord);

        for (const alias of aliases) {
            this._skillAliases.set(alias, skillRecord);
        }

        const subsystem = this.subsystemFactory.get(type);
        if (subsystem && typeof subsystem.parseSkillDescriptor === 'function') {
            try {
                skillRecord.descriptor = subsystem.parseSkillDescriptor({
                    filePath: skillRecord.filePath,
                    skillDir: skillRecord.skillDir,
                    shortName: skillRecord.shortName,
                });
            } catch (error) {
                this.logger.warn(`[MainAgent] Failed to parse skill ${skillRecord.shortName}: ${error.message}`);
            }
        }

        if (!skillRecord.descriptor) {
            skillRecord.descriptor = {
                name: skillRecord.shortName,
                rawContent: '',
                sections: {},
            };
        }

        if (subsystem && typeof subsystem.prepareSkill === 'function') {
            try {
                subsystem.prepareSkill(skillRecord, this);
            } catch (error) {
                this.logger.warn(`[MainAgent] Failed to prepare skill ${skillRecord.name}: ${error.message}`);
            }
        }
    }

    async executePrompt(message, options = {}) {
        const {
            model = null,
            tags = null,
            systemPrompt = null,
            signal = null,
            supervisor = this.supervisor,
            context = null,
            reasoningEffort = null,
            initialHistory = null,
        } = options;
        if (context && typeof context === 'object') {
            this.context = context;
        }

        const effectiveReasoningEffort = reasoningEffort || this.reasoningEffort;

        if (!this._session) {
            const tools = this._buildToolsForSession();
            this._session = await this.llmAgent.startLoopAgentSession(tools, message, {
                model,
                tags,
                systemPrompt,
                supervisor,
                signal,
                reasoningEffort: effectiveReasoningEffort,
                initialHistory,
            });
        } else {
            if (initialHistory !== null
                && initialHistory !== undefined
                && (!Array.isArray(initialHistory) || initialHistory.length > 0)) {
                throw new Error('initialHistory can only be supplied when MainAgent creates a new session.');
            }
            const promptOptions = { signal };
            if (Object.prototype.hasOwnProperty.call(options, 'model')) {
                promptOptions.model = model;
            }
            if (Object.prototype.hasOwnProperty.call(options, 'tags')) {
                promptOptions.tags = tags;
            }
            if (Object.prototype.hasOwnProperty.call(options, 'reasoningEffort')) {
                promptOptions.reasoningEffort = effectiveReasoningEffort;
            }
            await this._session.newPrompt(message, promptOptions);
        }

        return {
            result: this._session.getLastResult(),
            status: this._session.status,
        };
    }

    cancelCurrentSession(reason = 'cancelled') {
        if (this._session && typeof this._session.cancel === 'function') {
            this._session.cancel(reason);
        }
        if (this.llmAgent && typeof this.llmAgent.cancel === 'function') {
            this.llmAgent.cancel();
        }
    }

    async executeSkill(skillName, prompt, options = {}) {
        if (options?.signal?.aborted) {
            const error = new Error('Skill execution cancelled before start.');
            error.name = 'AbortError';
            throw error;
        }

        const skillRecord = this.getSkillRecord(skillName);
        if (!skillRecord) {
            throw new Error(`Skill "${skillName}" not found.`);
        }
        if (skillRecord.enabled === false) {
            throw new Error(`Skill "${skillRecord.name}" is disabled.`);
        }

        const subsystem = this.subsystemFactory.get(skillRecord.type);
        if (!subsystem || typeof subsystem.executeSkillPrompt !== 'function') {
            throw new Error(`Subsystem for type "${skillRecord.type}" does not support execution.`);
        }

        return subsystem.executeSkillPrompt({
            skillRecord,
            promptText: prompt,
            options,
        });
    }

    /**
     * Build all skills — async, heavy one-time setup.
     *
     * Unlike `prepareSkill` (called automatically during registration for fast,
     * synchronous config parsing), `buildSkills` performs expensive operations
     * like code generation from specs/ for code skills.
     *
     * Must be called explicitly before executing skills that require build-time preparation.
     * Safe to call multiple times — skills that are already built are skipped.
     */
    async buildSkills() {
        const skills = this.getSkills().filter((skillRecord) => skillRecord.enabled !== false);
        const buildTasks = skills.map(async (skillRecord) => {
            const subsystem = this.subsystemFactory.get(skillRecord.type);
            if (subsystem && typeof subsystem.buildSkill === 'function') {
                try {
                    await subsystem.buildSkill(skillRecord, this);
                } catch (error) {
                    this.logger.warn(`[MainAgent] Failed to build skill ${skillRecord.name}: ${error.message}`);
                }
            }
        });

        await Promise.all(buildTasks);
    }

    refreshSkills() {
        const beforeSkills = this.getSkills();
        const beforeByName = new Map(beforeSkills.map((skill) => [skill.name, skill]));
        const beforeWorkspaceSkills = beforeSkills.filter((skill) => this._isWorkspaceSkillRecord(skill));
        const beforeWorkspaceNames = new Set(beforeWorkspaceSkills.map((skill) => skill.name));
        const preservedSkills = beforeSkills.filter((skill) => !this._isWorkspaceSkillRecord(skill));
        const { roots, skills: workspaceSkills } = this._discoverWorkspaceSkills();

        for (const record of workspaceSkills) {
            record.isInternal = false;
        }

        const workspaceNames = new Set(workspaceSkills.map((skill) => skill.name));
        const added = workspaceSkills
            .filter((skill) => !beforeByName.has(skill.name))
            .map((skill) => skill.name)
            .sort();
        const updated = workspaceSkills
            .filter((skill) => beforeByName.has(skill.name) && getSkillFingerprint(beforeByName.get(skill.name)) !== getSkillFingerprint(skill))
            .map((skill) => skill.name)
            .sort();
        const removed = Array.from(beforeWorkspaceNames)
            .filter((name) => !workspaceNames.has(name))
            .sort();

        this._skills = new Map();
        this._skillAliases = new Map();
        this._orchestratorAllowedSkills = new Set();
        this._duplicateSkillEvents = [];

        for (const record of preservedSkills) {
            this._registerSkill(record);
        }
        for (const record of workspaceSkills) {
            this._registerSkill(record);
        }

        this._workspaceSkillRoots = roots;
        this._refreshOrchestratedSkillIndex();

        const summary = {
            registered: this._skills.size,
            added,
            updated,
            removed,
        };

        this._refreshCurrentSessionTools(summary);
        this.debugSkillRegistrationSummary({ phase: 'refreshSkills' });

        return summary;
    }

    _isWorkspaceSkillRecord(skillRecord) {
        return Boolean(skillRecord?.skillDir && !skillRecord.isInternal
            && this._workspaceSkillRoots.some(root => isPathInside(skillRecord.skillDir, root)));
    }

    _refreshCurrentSessionTools(summary = {}) {
        if (!this._session || typeof this._session.replaceTools !== 'function') {
            return false;
        }
        this._session.replaceTools(this._buildToolsForSession(), summary);
        return true;
    }

    _buildToolsForSession() {
        const tools = {};
        const allSkills = this.getSkills()
            .filter((skillRecord) => skillRecord.enabled !== false)
            .filter((skillRecord) => !this._orchestratorAllowedSkills.has(skillRecord.name));

        for (const skillRecord of allSkills) {
            const toolName = sanitiseName(skillRecord.shortName || skillRecord.name);
            tools[toolName] = {
                handler: async (agent, promptText, executionOptions = {}) => {
                    const safePrompt = typeof promptText === 'string'
                        ? promptText
                        : (promptText != null ? JSON.stringify(promptText) : '');
                    const parentSession = executionOptions?.session || null;
                    const parentSessionContext = parentSession && typeof parentSession.getConversationSnapshot === 'function'
                        ? parentSession.getConversationSnapshot()
                        : null;
                    const supervisor = parentSession?.supervisor || this.supervisor;
                    const parentSessionOptions = parentSession?.options || {};
                    const runtimeContext = this.context && typeof this.context === 'object'
                        ? this.context
                        : {};
                    const context = {
                        ...runtimeContext,
                        ...(parentSessionContext ? { parentSession: parentSessionContext } : {}),
                        ...(executionOptions?.supervisorApproval
                            ? { supervisorApproval: executionOptions.supervisorApproval }
                            : {}),
                    };
                    this.logger.debug(`MainAgent:skillParentContext: ${toolName}: hasParentContext=${Boolean(parentSessionContext)}`);

                    const result = await this.executeSkill(skillRecord.name, safePrompt, {
                        model: parentSessionOptions.model || 'plan',
                        tags: parentSessionOptions.tags || null,
                        reasoningEffort: parentSessionOptions.reasoningEffort || null,
                        signal: executionOptions?.signal || null,
                        supervisor,
                        parentContext: parentSessionContext,
                        context,
                    });
                    const output = result?.result;
                    if (output == null) return '';
                    if (typeof output === 'string') return output;
                    try { return JSON.stringify(output); } catch { return String(output); }
                },
                description: skillRecord.type === 'orchestrator'
                    ? (skillRecord.descriptor?.sections?.description || skillRecord.descriptor?.name || skillRecord.name)
                    : (skillRecord.descriptor?.rawContent || skillRecord.descriptor?.name || skillRecord.name),
            };
        }

        return tools;
    }
    

    getSkillRecord(identifier) {
        if (!identifier || typeof identifier !== 'string') {
            return null;
        }
        const normalized = sanitiseName(identifier);
        return this._skillAliases.get(normalized) || null;
    }

    listSkillsByType(type) {
        return Array.from(this._skills.values()).filter(record => record.type === type);
    }

    getSkills() {
        return Array.from(this._skills.values());
    }

    enableSkills(skillNames) {
        return this._setSkillsEnabled(skillNames, true);
    }

    disableSkills(skillNames) {
        return this._setSkillsEnabled(skillNames, false);
    }

    _setSkillsEnabled(skillNames, enabled) {
        if (!Array.isArray(skillNames)) {
            throw new TypeError('Skill names must be provided as an array.');
        }

        const records = [];
        const missing = [];
        const seen = new Set();
        for (const identifier of skillNames) {
            const record = this.getSkillRecord(identifier);
            if (!record) {
                missing.push(String(identifier));
                continue;
            }
            if (seen.has(record.name)) continue;
            seen.add(record.name);
            records.push(record);
        }
        if (missing.length) {
            throw new Error(`Unknown skill(s): ${missing.join(', ')}`);
        }

        for (const record of records) {
            record.enabled = enabled;
            if (enabled) this._disabledSkillNames.delete(record.name);
            else this._disabledSkillNames.add(record.name);
        }

        this._refreshOrchestratedSkillIndex();
        this._refreshCurrentSessionTools({
            enabledChanged: records.map((record) => record.name),
            enabled,
        });
        return records;
    }

    ensureSubsystem(type) {
        return this.subsystemFactory.get(type);
    }

    shutdown() {
        this._session = null;
    }
}

function sanitiseName(value) {
    return Sanitiser.sanitiseName(value);
}
