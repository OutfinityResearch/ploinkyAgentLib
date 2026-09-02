import fs from 'node:fs';
import path from 'node:path';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

const TEMP_ROOT = path.join(process.cwd(), 'tests', '.tmp', 'logging');
const DEBUGLOGS_DIR = path.join(process.cwd(), 'debuglogs');

// Helpers
const ensureTempDir = () => {
    fs.mkdirSync(TEMP_ROOT, { recursive: true });
};

const cleanupTempDir = () => {
    if (fs.existsSync(TEMP_ROOT)) {
        fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
    }
};

const cleanupDebugLogs = () => {
    if (fs.existsSync(DEBUGLOGS_DIR)) {
        for (const file of fs.readdirSync(DEBUGLOGS_DIR)) {
            if (file.startsWith('debug-') && file.endsWith('.log')) {
                fs.unlinkSync(path.join(DEBUGLOGS_DIR, file));
            }
        }
    }
};

const getDebugLogFile = () => {
    if (!fs.existsSync(DEBUGLOGS_DIR)) return null;
    const files = fs.readdirSync(DEBUGLOGS_DIR).filter(f => f.startsWith('debug-') && f.endsWith('.log'));
    return files.length ? path.join(DEBUGLOGS_DIR, files[0]) : null;
};

const readDebugLogFile = () => {
    const filePath = getDebugLogFile();
    if (!filePath || !fs.existsSync(filePath)) return '';
    return fs.readFileSync(filePath, 'utf-8');
};

describe('DebugLogger', () => {
    before(() => {
        ensureTempDir();
    });

    after(() => {
        cleanupTempDir();
    });

    test('DebugLogger class has log, debug, info, warn, close methods', async () => {
        const { getDebugLogger } = await import('../../utils/DebugLogger.mjs');
        const logger = getDebugLogger();

        assert.equal(typeof logger.log, 'function');
        assert.equal(typeof logger.debug, 'function');
        assert.equal(typeof logger.info, 'function');
        assert.equal(typeof logger.warn, 'function');
        assert.equal(typeof logger.close, 'function');
    });

    test('debug() prefixes with [DEBUG]', async () => {
        const { DebugLogger } = await import('../../utils/DebugLogger.mjs');
        const tmpFile = path.join(TEMP_ROOT, `debug-prefix-${Date.now()}.log`);
        const stream = fs.createWriteStream(tmpFile, { flags: 'a' });

        const logger = new DebugLogger(true);
        logger.stream = stream;
        logger.initialised = true;

        logger.debug('test message');
        stream.end();

        await new Promise(resolve => stream.on('close', resolve));

        const content = fs.readFileSync(tmpFile, 'utf-8');
        assert.ok(content.includes('[DEBUG]'));
        assert.ok(content.includes('test message'));
    });

    test('info() prefixes with [INFO]', async () => {
        const { DebugLogger } = await import('../../utils/DebugLogger.mjs');
        const tmpFile = path.join(TEMP_ROOT, `info-prefix-${Date.now()}.log`);
        const stream = fs.createWriteStream(tmpFile, { flags: 'a' });

        const logger = new DebugLogger(true);
        logger.stream = stream;
        logger.initialised = true;

        logger.info('info_message');
        stream.end();

        await new Promise(resolve => stream.on('close', resolve));

        const content = fs.readFileSync(tmpFile, 'utf-8');
        assert.ok(content.includes('[INFO]'));
        assert.ok(content.includes('info_message'));
    });

    test('warn() prefixes with [WARN]', async () => {
        const { DebugLogger } = await import('../../utils/DebugLogger.mjs');
        const tmpFile = path.join(TEMP_ROOT, `warn-prefix-${Date.now()}.log`);
        const stream = fs.createWriteStream(tmpFile, { flags: 'a' });

        const logger = new DebugLogger(true);
        logger.stream = stream;
        logger.initialised = true;

        logger.warn('warn_message');
        stream.end();

        await new Promise(resolve => stream.on('close', resolve));

        const content = fs.readFileSync(tmpFile, 'utf-8');
        assert.ok(content.includes('[WARN]'));
        assert.ok(content.includes('warn_message'));
    });

    test('log() writes to file when enabled', async () => {
        const { DebugLogger } = await import('../../utils/DebugLogger.mjs');
        const tmpFile = path.join(TEMP_ROOT, `log-enabled-${Date.now()}.log`);
        const stream = fs.createWriteStream(tmpFile, { flags: 'a' });

        const logger = new DebugLogger(true);
        logger.stream = stream;
        logger.initialised = true;

        logger.log('enabled_log_test');
        stream.end();

        await new Promise(resolve => stream.on('close', resolve));

        const content = fs.readFileSync(tmpFile, 'utf-8');
        assert.ok(content.includes('enabled_log_test'));
    });

    test('log() is silent when disabled', async () => {
        const { DebugLogger } = await import('../../utils/DebugLogger.mjs');
        const tmpFile = path.join(TEMP_ROOT, `log-disabled-${Date.now()}.log`);
        const stream = fs.createWriteStream(tmpFile, { flags: 'a' });

        const logger = new DebugLogger(false);
        logger.stream = stream;
        logger.initialised = true;

        logger.log('should_not_appear');
        stream.end();

        await new Promise(resolve => stream.on('close', resolve));

        const content = fs.readFileSync(tmpFile, 'utf-8');
        assert.equal(content, '');
    });

    test('getDebugLogger returns singleton', async () => {
        const { getDebugLogger } = await import('../../utils/DebugLogger.mjs');
        const a = getDebugLogger();
        const b = getDebugLogger();
        assert.strictEqual(a, b);
    });
});

describe('MainAgent logger propagation', () => {
    before(() => {
        ensureTempDir();
        cleanupDebugLogs();
    });

    after(() => {
        cleanupTempDir();
        cleanupDebugLogs();
    });

    test('MainAgent uses getDebugLogger() as default when no logger provided', async () => {
        const { MainAgent } = await import('../../MainAgent/MainAgent.mjs');
        const { getDebugLogger } = await import('../../utils/DebugLogger.mjs');

        const agent = new MainAgent({
            startDir: TEMP_ROOT,
            disableInternalSkills: true,
        });

        assert.strictEqual(agent.logger, getDebugLogger());
        agent.shutdown();
    });

    test('MainAgent accepts and stores custom logger', async () => {
        const { MainAgent } = await import('../../MainAgent/MainAgent.mjs');

        const customLogger = {
            log: () => {},
            debug: () => {},
            info: () => {},
            warn: () => {},
            close: () => {},
        };

        const agent = new MainAgent({
            startDir: TEMP_ROOT,
            logger: customLogger,
            disableInternalSkills: true,
        });

        assert.strictEqual(agent.logger, customLogger);
        agent.shutdown();
    });

    test('MainAgent propagates logger to SubsystemFactory', async () => {
        const { MainAgent } = await import('../../MainAgent/MainAgent.mjs');

        const customLogger = {
            log: () => {},
            debug: () => {},
            info: () => {},
            warn: () => {},
            close: () => {},
        };

        const agent = new MainAgent({
            startDir: TEMP_ROOT,
            logger: customLogger,
            disableInternalSkills: true,
        });

        assert.strictEqual(agent.subsystemFactory.logger, customLogger);
        agent.shutdown();
    });

    test('MainAgent propagates logger to LLMAgent', async () => {
        const { MainAgent } = await import('../../MainAgent/MainAgent.mjs');

        const customLogger = {
            log: () => {},
            debug: () => {},
            info: () => {},
            warn: () => {},
            close: () => {},
        };

        const agent = new MainAgent({
            startDir: TEMP_ROOT,
            logger: customLogger,
            disableInternalSkills: true,
        });

        assert.strictEqual(agent.llmAgent.logger, customLogger);
        agent.shutdown();
    });

    test('SubsystemFactory propagates logger to subsystems', async () => {
        const { MainAgent } = await import('../../MainAgent/MainAgent.mjs');

        const customLogger = {
            log: () => {},
            debug: () => {},
            info: () => {},
            warn: () => {},
            close: () => {},
        };

        const agent = new MainAgent({
            startDir: TEMP_ROOT,
            logger: customLogger,
            disableInternalSkills: true,
        });

        const orchestrator = agent.ensureSubsystem('orchestrator');
        const codeSkills = agent.ensureSubsystem('cskill');
        const dbTable = agent.ensureSubsystem('dbtable');

        assert.strictEqual(orchestrator.logger, customLogger);
        assert.strictEqual(codeSkills.logger, customLogger);
        assert.strictEqual(dbTable.logger, customLogger);
        agent.shutdown();
    });
});

describe('Custom logger override — end-to-end', () => {
    before(() => {
        ensureTempDir();
        cleanupDebugLogs();
    });

    after(() => {
        cleanupTempDir();
        cleanupDebugLogs();
    });

    test('custom logger receives calls when subsystems log', async () => {
        const { MainAgent } = await import('../../MainAgent/MainAgent.mjs');

        const logCalls = [];
        const customLogger = {
            log: (...args) => logCalls.push({ method: 'log', args }),
            debug: (...args) => logCalls.push({ method: 'debug', args }),
            info: (...args) => logCalls.push({ method: 'info', args }),
            warn: (...args) => logCalls.push({ method: 'warn', args }),
            close: () => {},
        };

        const agent = new MainAgent({
            startDir: TEMP_ROOT,
            logger: customLogger,
            disableInternalSkills: true,
        });

        // Trigger subsystem logging by accessing orchestrator
        const orchestrator = agent.ensureSubsystem('orchestrator');
        assert.strictEqual(orchestrator.logger, customLogger);

        // The logger should be the custom one, not the DebugLogger singleton
        const { getDebugLogger } = await import('../../utils/DebugLogger.mjs');
        assert.notStrictEqual(orchestrator.logger, getDebugLogger());

        agent.shutdown();
    });

    test('default logger is DebugLogger singleton (file-only, no stdout)', async () => {
        const { MainAgent } = await import('../../MainAgent/MainAgent.mjs');
        const { getDebugLogger } = await import('../../utils/DebugLogger.mjs');

        const agent = new MainAgent({
            startDir: TEMP_ROOT,
            disableInternalSkills: true,
        });

        // Default logger IS the singleton
        assert.strictEqual(agent.logger, getDebugLogger());

        // Singleton has file-only behavior (no console.* methods)
        assert.equal(typeof agent.logger.log, 'function');
        assert.equal(typeof agent.logger.debug, 'function');
        assert.equal(typeof agent.logger.info, 'function');
        assert.equal(typeof agent.logger.warn, 'function');

        agent.shutdown();
    });
});
