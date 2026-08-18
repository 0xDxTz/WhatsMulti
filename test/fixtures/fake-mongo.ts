import type { MongoDatabase } from '../../src/adapters/mongo/index.js';

/**
 * An in-memory stand-in for a MongoDB database.
 *
 * It implements the operators the adapters use -- `$in`, `$lt`, `$gte`, `$regex`,
 * `$set`, upsert, unordered bulkWrite -- with MongoDB's own semantics, including the
 * duplicate-key error that makes an upsert the atomic gate the lock relies on.
 *
 * Set MONGO_URL to run the same suites against a real server.
 */
interface Doc {
    _id: string;
    [field: string]: unknown;
}

type Filter = Record<string, unknown>;

function matches(doc: Doc, filter: Filter): boolean {
    return Object.entries(filter).every(([field, condition]) => {
        const value = doc[field];

        if (typeof condition !== 'object' || condition === null) return value === condition;

        return Object.entries(condition as Record<string, unknown>).every(([operator, operand]) => {
            switch (operator) {
                case '$in':
                    return Array.isArray(operand) && operand.includes(value);
                case '$lt':
                    return typeof value === 'number' && typeof operand === 'number' && value < operand;
                case '$gte':
                    return typeof value === 'number' && typeof operand === 'number' && value >= operand;
                case '$regex':
                    return typeof value === 'string' && new RegExp(String(operand)).test(value);
                default:
                    throw new Error(`FakeMongo does not implement ${operator}`);
            }
        });
    });
}

/** The `_id` an upsert inserts, taken from the filter's equality condition. */
function upsertId(filter: Filter): string | undefined {
    const id = filter['_id'];
    return typeof id === 'string' ? id : undefined;
}

class DuplicateKeyError extends Error {
    readonly code = 11000;

    constructor(id: string) {
        super(`E11000 duplicate key error collection: _id_ dup key: { _id: "${id}" }`);
    }
}

class FakeCollection {
    readonly docs = new Map<string, Doc>();
    readonly indexes: object[] = [];

    findOne(filter: Filter): Promise<Doc | null> {
        for (const doc of this.docs.values()) if (matches(doc, filter)) return Promise.resolve({ ...doc });
        return Promise.resolve(null);
    }

    find(filter: Filter): { toArray: () => Promise<Doc[]> } {
        const found = [...this.docs.values()].filter((doc) => matches(doc, filter)).map((doc) => ({ ...doc }));
        return { toArray: () => Promise.resolve(found) };
    }

    insertOne(doc: Doc): Promise<unknown> {
        if (this.docs.has(doc._id)) return Promise.reject(new DuplicateKeyError(doc._id));
        this.docs.set(doc._id, { ...doc });
        return Promise.resolve({ insertedId: doc._id });
    }

    updateOne(
        filter: Filter,
        update: { $set?: Record<string, unknown> },
        options?: { upsert?: boolean }
    ): Promise<unknown> {
        const set = update.$set ?? {};

        for (const doc of this.docs.values()) {
            if (!matches(doc, filter)) continue;
            Object.assign(doc, set);
            return Promise.resolve({ matchedCount: 1, modifiedCount: 1 });
        }

        if (options?.upsert !== true) return Promise.resolve({ matchedCount: 0, modifiedCount: 0 });

        const id = upsertId(filter);
        if (id === undefined) return Promise.reject(new Error('FakeMongo cannot infer an _id for this upsert'));
        if (this.docs.has(id)) return Promise.reject(new DuplicateKeyError(id));

        this.docs.set(id, { _id: id, ...set });
        return Promise.resolve({ matchedCount: 0, upsertedId: id });
    }

    deleteOne(filter: Filter): Promise<unknown> {
        for (const [id, doc] of this.docs) {
            if (matches(doc, filter)) {
                this.docs.delete(id);
                return Promise.resolve({ deletedCount: 1 });
            }
        }
        return Promise.resolve({ deletedCount: 0 });
    }

    deleteMany(filter: Filter): Promise<unknown> {
        let deleted = 0;
        for (const [id, doc] of [...this.docs]) {
            if (matches(doc, filter)) {
                this.docs.delete(id);
                deleted += 1;
            }
        }
        return Promise.resolve({ deletedCount: deleted });
    }

    async bulkWrite(operations: object[]): Promise<unknown> {
        for (const operation of operations) {
            const write = (operation as { updateOne?: { filter: Filter; update: object; upsert?: boolean } }).updateOne;
            if (write === undefined) throw new Error('FakeMongo only implements updateOne in bulkWrite');
            await this.updateOne(write.filter, write.update, { upsert: write.upsert ?? false });
        }
        return { ok: 1 };
    }

    createIndex(spec: object): Promise<unknown> {
        this.indexes.push(spec);
        return Promise.resolve('ok');
    }
}

export class FakeMongo implements MongoDatabase {
    readonly collections = new Map<string, FakeCollection>();

    collection(name: string): unknown {
        let existing = this.collections.get(name);
        if (existing === undefined) {
            existing = new FakeCollection();
            this.collections.set(name, existing);
        }
        return existing;
    }
}
