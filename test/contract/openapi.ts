import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Ajv2020 } from 'ajv/dist/2020.js';
import { parse } from 'yaml';

/**
 * The contract harness: spec/openapi.yaml, loaded once and used to validate real
 * responses from the real server.
 *
 * Ajv rather than a hand-written checker. A validator we wrote ourselves would be
 * exactly as strict as our understanding of the schemas, which is the understanding
 * the tests are supposed to be checking.
 */
const DOC_ID = 'https://whatsmulti.test/openapi.json';

export const document = parse(readFileSync(join(process.cwd(), 'spec', 'openapi.yaml'), 'utf8')) as OpenApiDocument;

interface Ref {
    readonly $ref?: string;
}

interface MediaType {
    readonly schema?: unknown;
}

interface ResponseObject extends Ref {
    readonly content?: Record<string, MediaType>;
}

interface Operation {
    readonly operationId?: string;
    readonly security?: unknown[];
    readonly responses: Record<string, ResponseObject>;
}

export interface OpenApiDocument {
    readonly paths: Record<string, Record<string, Operation>>;
    readonly components: {
        readonly responses: Record<string, ResponseObject>;
        readonly schemas: Record<string, unknown>;
    };
}

// `strict: false` because an OpenAPI document is not itself a JSON Schema: `paths`,
// `openapi` and friends are unknown keywords at the root. The subschemas we compile
// out of it are ordinary 2020-12 schemas.
const ajv = new Ajv2020({ strict: false, allErrors: true });
// OpenAPI's own formats. Registered rather than ignored: `int64` is how the document
// says "unix milliseconds, not a float", and an ignored format checks nothing.
ajv.addFormat('int64', { type: 'number', validate: (value: number) => Number.isInteger(value) });
ajv.addFormat('int32', { type: 'number', validate: (value: number) => Number.isInteger(value) });
ajv.addFormat('binary', true);
ajv.addSchema(document, DOC_ID);

const escape = (segment: string): string => segment.replace(/~/g, '~0').replace(/\//g, '~1');

const walk = (pointer: string): unknown =>
    pointer
        .split('/')
        .slice(1)
        .reduce<unknown>(
            (node, segment) =>
                (node as Record<string, unknown> | undefined)?.[segment.replace(/~1/g, '/').replace(/~0/g, '~')],
            document
        );

/**
 * The JSON pointer to the schema for one response, following a `$ref` to a shared
 * response object. Pointers rather than resolved objects: a fragment lifted out of
 * the document could not resolve the `$ref`s inside it.
 */
export function schemaPointer(
    path: string,
    method: string,
    status: number | 'default',
    mediaType = 'application/json'
): string | null {
    const base = `#/paths/${escape(path)}/${method}/responses/${escape(String(status))}`;
    let node = walk(base) as ResponseObject | undefined;
    let pointer = base;

    if (node === undefined) return null;

    if (typeof node.$ref === 'string') {
        pointer = node.$ref;
        node = walk(pointer) as ResponseObject | undefined;
    }

    if (node?.content?.[mediaType]?.schema === undefined) return null;
    return `${pointer}/content/${escape(mediaType)}/schema`;
}

const validators = new Map<string, ReturnType<typeof ajv.compile>>();

function validatorFor(pointer: string): ReturnType<typeof ajv.compile> {
    let validate = validators.get(pointer);
    if (validate === undefined) {
        validate = ajv.compile({ $ref: `${DOC_ID}${pointer}` });
        validators.set(pointer, validate);
    }
    return validate;
}

export interface ContractResult {
    readonly ok: boolean;
    readonly pointer: string | null;
    readonly errors: string;
}

/**
 * Validates one response body against the contract.
 *
 * A status the operation does not list falls to the `default` response, which every
 * operation carries -- that is the promise that any failure still arrives as the
 * Error shape.
 */
export function checkResponse(
    path: string,
    method: string,
    status: number,
    body: unknown,
    mediaType = 'application/json'
): ContractResult {
    // A status the operation lists is checked against that entry, even when the entry
    // carries no body -- 204 says "no content", and falling through to `default` would
    // demand an Error body for a success.
    const documented = responsesOf(path, method)[String(status)] !== undefined;
    const pointer = documented
        ? schemaPointer(path, method, status, mediaType)
        : schemaPointer(path, method, 'default', mediaType);

    if (pointer === null) {
        return {
            ok: body === undefined || body === null,
            pointer: null,
            errors: `${status} is documented without a body, but one was sent`,
        };
    }

    const validate = validatorFor(pointer);
    const ok = validate(body) as boolean;
    return { ok, pointer, errors: ajv.errorsText(validate.errors, { dataVar: 'body' }) };
}

/** Every operation in the document, as `[path, method, operationId]`. */
export function operations(): [string, string, string][] {
    return Object.entries(document.paths).flatMap(([path, item]) =>
        Object.entries(item)
            .filter(([method]) => method !== 'parameters')
            .map(([method, operation]): [string, string, string] => [path, method, operation.operationId ?? ''])
    );
}

/** Whether an operation inherits the document-level bearer requirement. */
export function isSecured(path: string, method: string): boolean {
    return document.paths[path]?.[method]?.security === undefined;
}

/** The responses map for one operation, straight from the document. */
export function responsesOf(path: string, method: string): Record<string, unknown> {
    return document.paths[path]?.[method]?.responses ?? {};
}
