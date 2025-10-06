import { registerProvider } from '../providerRegistry.mjs';
import * as openai from './openai.mjs';
import * as google from './google.mjs';
import * as anthropic from './anthropic.mjs';
import * as huggingFace from './huggingFace.mjs';


let registered = false;

export function registerBuiltInProviders(options = {}) {
    if (registered) {
        return;
    }

    const skip = options.skip || process.env.PLOINKY_SKIP_BUILTIN_PROVIDERS === '1';
    if (skip) {
        registered = true;
        return;
    }

    registerProvider({ key: 'openai', handler: openai, metadata: { module: './openai.mjs' } });
    registerProvider({ key: 'google', handler: google, metadata: { module: './google.mjs' } });
    registerProvider({ key: 'anthropic', handler: anthropic, metadata: { module: './anthropic.mjs' } });
    registerProvider({ key: 'huggingface', handler: huggingFace, metadata: { module: './huggingFace.mjs' } });
    registerProvider({ key: 'openrouter', handler: openai, metadata: { module: './openai.mjs' } });
    registerProvider({ key: 'custom', handler: openai, metadata: { module: './openai.mjs' } });

    registered = true;
}

export const resetBuiltInProviders = () => { registered = false; };
