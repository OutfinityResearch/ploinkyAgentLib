import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import {
    ALL_INDEX_FILES,
    BM25F_DEFAULTS,
    INDEX_SCHEMA_VERSION,
    JSONL_INDEX_FILES,
    KU_FILES,
    RECORD_TYPES,
    ROOT_FILES,
    SEARCH_FIELDS,
} from './constants.mjs';
import { reusableFindingsText, sha256, sha256Object, stripSensitiveFields } from './schemas.mjs';
import { stringifyJson, stringifyJsonl } from './storage.mjs';

export class AKUIndexBuilder {
    constructor(options = {}) {
        this.store = options.store;
        this.tokenizer = options.tokenizer;
        this.clock = options.clock ?? (() => new Date());
    }

    async buildFromKUFolders(akuConfig = {}) {
        const kuIds = await this.store.scanKUFolders();
        const kuRecords = [];
        const documentRecords = [];
        const fileRecords = [];
        const linkRecords = [];
        const resultRecords = [];
        const eventRecords = [];
        const searchRecords = [];

        for (const kuId of kuIds) {
            const ku = await this.store.loadKU(kuId);
            const manifest = stripSensitiveFields(ku.manifest);
            const kuRecord = buildKURecord(manifest);
            kuRecords.push(kuRecord);
            searchRecords.push(kuRecord);

            for (const document of ku.documents) {
                const record = buildDocumentRecord(stripSensitiveFields(document), manifest);
                documentRecords.push(record);
                searchRecords.push(record);
            }
            for (const file of ku.files) {
                const record = buildFileRecord(stripSensitiveFields(file), manifest);
                fileRecords.push(record);
                searchRecords.push(record);
            }
            for (const link of ku.links ?? []) {
                const record = buildLinkRecord(stripSensitiveFields(link), manifest);
                linkRecords.push(record);
                searchRecords.push(record);
            }
            for (const result of ku.results) {
                const record = buildResultRecord(stripSensitiveFields(result), manifest);
                resultRecords.push(record);
                searchRecords.push(record);
            }
            for (const event of ku.events) {
                const record = buildEventRecord(stripSensitiveFields(event), manifest);
                eventRecords.push(record);
                searchRecords.push(record);
            }
        }

        const sortedSearchRecords = sortRecords(searchRecords);
        const stats = this.buildStats(sortedSearchRecords);
        const files = {
            [ROOT_FILES.searchIndex]: stringifyJsonl(sortedSearchRecords),
            [ROOT_FILES.searchStats]: stringifyJson(stats),
            [ROOT_FILES.kuIndex]: stringifyJsonl(sortRecords(kuRecords)),
            [ROOT_FILES.documentsIndex]: stringifyJsonl(sortRecords(documentRecords)),
            [ROOT_FILES.filesIndex]: stringifyJsonl(sortRecords(fileRecords)),
            [ROOT_FILES.linksIndex]: stringifyJsonl(sortRecords(linkRecords)),
            [ROOT_FILES.resultsIndex]: stringifyJsonl(sortRecords(resultRecords)),
            [ROOT_FILES.eventsIndex]: stringifyJsonl(sortRecords(eventRecords)),
        };
        const recordCounts = {
            search: sortedSearchRecords.length,
            ku: kuRecords.length,
            document: documentRecords.length,
            file: fileRecords.length,
            link: linkRecords.length,
            result: resultRecords.length,
            event: eventRecords.length,
        };

        return {
            files,
            stats,
            recordCounts,
            indexMeta: this.buildIndexMeta({
                files,
                recordCounts,
                akuConfig,
            }),
        };
    }

    buildStats(records) {
        const avgFieldLengths = Object.fromEntries(SEARCH_FIELDS.map(field => [field, 0]));
        const documentFrequency = {};
        const fieldTokenTotals = Object.fromEntries(SEARCH_FIELDS.map(field => [field, 0]));

        for (const record of records) {
            const recordTerms = new Set();
            for (const field of SEARCH_FIELDS) {
                const tokens = this.tokenizer.tokenizeField(record[field], field);
                fieldTokenTotals[field] += tokens.length;
                for (const token of tokens) {
                    recordTerms.add(token);
                }
            }
            for (const term of recordTerms) {
                documentFrequency[term] = (documentFrequency[term] ?? 0) + 1;
            }
        }

        for (const field of SEARCH_FIELDS) {
            avgFieldLengths[field] = records.length
                ? Number((fieldTokenTotals[field] / records.length).toFixed(6))
                : 0;
        }

        return {
            schema: INDEX_SCHEMA_VERSION,
            record_count: records.length,
            avg_field_lengths: avgFieldLengths,
            document_frequency: Object.fromEntries(Object.entries(documentFrequency).sort(([a], [b]) => a.localeCompare(b))),
            bm25f: {
                k1: BM25F_DEFAULTS.k1,
                field_weights: BM25F_DEFAULTS.fieldWeights,
                field_b: BM25F_DEFAULTS.fieldB,
            },
            built_at: this.clock().toISOString(),
        };
    }

    buildIndexMeta({ files, recordCounts, akuConfig }) {
        const fileInfo = {};
        for (const name of ALL_INDEX_FILES) {
            const content = files[name] ?? '';
            fileInfo[name] = {
                sha256: sha256(content),
                bytes: Buffer.byteLength(content),
            };
            if (JSONL_INDEX_FILES.includes(name)) {
                fileInfo[name].records = content.trim() ? content.trim().split(/\r?\n/).length : 0;
            }
        }
        return {
            schema: INDEX_SCHEMA_VERSION,
            generation_id: generationId(this.clock()),
            aku_schema: akuConfig.schema ?? 1,
            record_counts: recordCounts,
            files: fileInfo,
            source: {
                ku_root_version: akuConfig.ku_root_version ?? 0,
                built_from: 'kus',
                build_options_hash: sha256Object({
                    schema: INDEX_SCHEMA_VERSION,
                    fields: SEARCH_FIELDS,
                    bm25f: BM25F_DEFAULTS,
                }),
            },
            generated_at: this.clock().toISOString(),
        };
    }
}

export function buildKURecord(manifest) {
    return compactSearchRecord({
        search_id: `ku:${manifest.ku_id}`,
        record_type: RECORD_TYPES.ku,
        ku_id: manifest.ku_id,
        ku_type: manifest.ku_type,
        ku_status: manifest.status,
        status: manifest.status,
        title: manifest.ku_name,
        summary: manifest.summary,
        type: manifest.ku_type,
        path: `kus/${manifest.ku_id}`,
        tags: safeArray(manifest.tags),
        keywords: safeArray(manifest.keywords),
        reusable_findings: reusableFindingsText(manifest.reusable_findings),
        created_at: manifest.created_at,
        updated_at: manifest.updated_at,
        version: manifest.version,
        outcome_status: manifest.outcome_status ?? null,
        parent_ku_id: manifest.parent_ku_id ?? manifest.lineage?.parent_ku_id ?? null,
    });
}

export function buildDocumentRecord(document, manifest) {
    return compactSearchRecord({
        search_id: `document:${manifest.ku_id}:${document.document_id}`,
        record_type: RECORD_TYPES.document,
        ku_id: manifest.ku_id,
        ku_type: manifest.ku_type,
        ku_status: manifest.status,
        document_id: document.document_id,
        document_type: document.document_type,
        status: document.status ?? manifest.status,
        title: document.title,
        summary: document.summary,
        type: document.document_type,
        path: document.path ?? `kus/${manifest.ku_id}/documents/${document.document_id}`,
        tags: mergeArrays(manifest.tags, document.tags),
        keywords: mergeArrays(manifest.keywords, document.keywords),
        reusable_findings: reusableFindingsText(document.reusable_findings),
        created_at: document.created_at ?? manifest.created_at,
        updated_at: document.updated_at ?? document.created_at ?? manifest.updated_at,
    });
}

export function buildFileRecord(file, manifest) {
    return compactSearchRecord({
        search_id: `file:${manifest.ku_id}:${file.file_id}`,
        record_type: RECORD_TYPES.file,
        ku_id: manifest.ku_id,
        ku_type: manifest.ku_type,
        ku_status: manifest.status,
        file_id: file.file_id,
        file_type: file.file_type,
        role: file.role ?? null,
        status: file.status ?? manifest.status,
        title: file.title ?? file.path,
        summary: file.summary,
        type: file.file_type ?? file.role ?? 'file',
        path: file.path,
        tags: mergeArrays(manifest.tags, file.tags),
        keywords: mergeArrays(manifest.keywords, file.keywords),
        reusable_findings: [],
        hash: file.hash ?? null,
        size: file.size ?? null,
        mime_type: file.mime_type ?? null,
        mtime: file.mtime ?? null,
        created_at: file.created_at ?? manifest.created_at,
        updated_at: file.updated_at ?? file.created_at ?? manifest.updated_at,
    });
}

export function buildLinkRecord(link, manifest) {
    return compactSearchRecord({
        search_id: `link:${manifest.ku_id}:${link.link_id}`,
        record_type: RECORD_TYPES.link,
        ku_id: manifest.ku_id,
        source_ku_id: link.source_ku_id ?? manifest.ku_id,
        target_ku_id: link.target_ku_id,
        ku_type: manifest.ku_type,
        ku_status: manifest.status,
        link_id: link.link_id,
        relation: link.relation,
        status: link.status ?? manifest.status,
        title: link.title,
        summary: link.summary ?? link.reason,
        type: link.relation ?? 'link',
        path: `kus/${manifest.ku_id}/links/${link.link_id}`,
        tags: mergeArrays(manifest.tags, link.tags),
        keywords: mergeArrays(manifest.keywords, link.keywords, [link.relation, link.target_ku_id]),
        reusable_findings: [],
        created_at: link.created_at ?? manifest.created_at,
        updated_at: link.updated_at ?? link.created_at ?? manifest.updated_at,
    });
}

export function buildResultRecord(result, manifest) {
    return compactSearchRecord({
        search_id: `result:${manifest.ku_id}:${result.result_id}`,
        record_type: RECORD_TYPES.result,
        ku_id: manifest.ku_id,
        ku_type: manifest.ku_type,
        ku_status: manifest.status,
        result_id: result.result_id,
        result_type: result.result_type,
        status: result.status ?? manifest.status,
        outcome_status: result.outcome_status ?? null,
        title: result.title,
        summary: result.summary,
        type: result.result_type,
        path: `kus/${manifest.ku_id}/results/${result.result_id}`,
        tags: mergeArrays(manifest.tags, result.tags),
        keywords: mergeArrays(manifest.keywords, result.keywords),
        reusable_findings: reusableFindingsText(result.reusable_findings),
        created_at: result.created_at ?? manifest.created_at,
        updated_at: result.updated_at ?? result.created_at ?? manifest.updated_at,
    });
}

export function buildEventRecord(event, manifest) {
    return compactSearchRecord({
        search_id: `event:${manifest.ku_id}:${event.event_id}`,
        record_type: RECORD_TYPES.event,
        ku_id: manifest.ku_id,
        ku_type: manifest.ku_type,
        ku_status: manifest.status,
        event_id: event.event_id,
        event_type: event.event_type,
        status: event.status ?? manifest.status,
        title: event.title ?? event.event_type,
        summary: event.summary ?? event.reason,
        type: event.event_type,
        path: `kus/${manifest.ku_id}/events/${event.event_id}`,
        tags: mergeArrays(manifest.tags, event.tags),
        keywords: mergeArrays(manifest.keywords, event.keywords),
        reusable_findings: [],
        created_at: event.created_at ?? manifest.created_at,
        updated_at: event.updated_at ?? event.created_at ?? manifest.updated_at,
    });
}

function compactSearchRecord(record) {
    const compact = {};
    for (const [key, value] of Object.entries(record)) {
        if (value === undefined || value === null) {
            continue;
        }
        if (Array.isArray(value) && value.length === 0) {
            compact[key] = [];
            continue;
        }
        compact[key] = value;
    }
    return compact;
}

function safeArray(value) {
    if (!value) {
        return [];
    }
    return Array.isArray(value) ? value.map(String) : [String(value)];
}

function mergeArrays(...values) {
    return [...new Set(values.flatMap(safeArray).filter(Boolean))];
}

function sortRecords(records) {
    return [...records].sort((a, b) => String(a.search_id).localeCompare(String(b.search_id)));
}

function generationId(date) {
    const timestamp = date.toISOString()
        .replace(/[-:]/g, '')
        .replace(/\.\d{3}Z$/, '')
        .replace('T', '_')
        .toLowerCase();
    return `idx_${timestamp}_${randomBytes(4).toString('hex')}`;
}
