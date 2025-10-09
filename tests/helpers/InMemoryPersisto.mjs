/**
 * InMemoryPersisto - A simplified in-memory implementation of Persisto for testing
 * 
 * This implementation provides only CRUD operations without disk storage,
 * making it ideal for unit tests.
 */

export class InMemoryPersisto {
    constructor() {
        this.objects = new Map(); // objectId -> object data
        this.types = new Map(); // typeName -> Set of objectIds
        this.counters = new Map(); // typeName -> next number
        this.systemLogger = {
            smartLog: async () => {} // Mock logger
        };
    }

    /**
     * Configure types for the database
     * Creates dynamic CRUD methods for each type
     */
    configureTypes(config) {
        for (let typeName in config) {
            if (!this.types.has(typeName)) {
                this.types.set(typeName, new Set());
            }
            
            // Add dynamic CRUD methods
            this._addCRUDMethods(typeName);
        }
    }

    /**
     * Add dynamic CRUD methods for a type
     * Creates: create<Type>, get<Type>, update<Type>, delete<Type>, has<Type>
     */
    _addCRUDMethods(typeName) {
        const upCase = (str) => str.charAt(0).toUpperCase() + str.slice(1);
        
        // create<Type>
        this[`create${upCase(typeName)}`] = async (initialValues = {}) => {
            return await this._createObject(typeName, initialValues);
        };
        
        // get<Type>
        this[`get${upCase(typeName)}`] = async (objectId) => {
            return await this._getObject(typeName, objectId);
        };
        
        // update<Type>
        this[`update${upCase(typeName)}`] = async (objectId, values) => {
            return await this._updateObject(typeName, objectId, values);
        };
        
        // delete<Type>
        this[`delete${upCase(typeName)}`] = async (objectId) => {
            return await this._deleteObject(typeName, objectId);
        };
        
        // has<Type>
        this[`has${upCase(typeName)}`] = async (objectId) => {
            return await this._hasObject(typeName, objectId);
        };
    }

    /**
     * Create a new object
     */
    async _createObject(typeName, initialValues) {
        const id = await this._nextObjectId(typeName);
        const obj = { id, ...initialValues };
        
        this.objects.set(id, obj);
        this.types.get(typeName).add(id);
        
        await this.systemLogger.smartLog('CREATE_OBJECT', { typeName, id });
        
        return obj;
    }

    /**
     * Get an object by ID
     */
    async _getObject(typeName, objectId) {
        if (objectId === undefined) {
            throw new Error(`Object IDs must be defined. Cannot get object of type ${typeName} with undefined ID`);
        }
        
        if (!this.objects.has(objectId)) {
            throw new Error(`Object of type ${typeName} with ID ${objectId} not found`);
        }
        
        const obj = this.objects.get(objectId);
        const prefix = typeName.slice(0, 6).toUpperCase();
        
        if (!objectId.startsWith(prefix)) {
            throw new Error(`Object ID ${objectId} does not start with expected prefix ${prefix}`);
        }
        
        return obj;
    }

    /**
     * Update an object
     */
    async _updateObject(typeName, objectId, values) {
        const obj = await this._getObject(typeName, objectId);
        
        // Update object properties
        for (let key in values) {
            if (key !== 'id') {
                obj[key] = values[key];
            }
        }
        
        this.objects.set(obj.id, obj);
        
        await this.systemLogger.smartLog('UPDATE', { typeName, objectId });
        
        return obj;
    }

    /**
     * Delete an object
     */
    async _deleteObject(typeName, objectId) {
        const obj = await this._getObject(typeName, objectId);
        
        // Remove from objects
        this.objects.delete(obj.id);
        this.types.get(typeName).delete(obj.id);
        
        await this.systemLogger.smartLog('DELETE', { typeName, objectId });
    }

    /**
     * Check if object exists
     */
    async _hasObject(typeName, objectId) {
        if (objectId === undefined) {
            throw new Error(`Object IDs must be defined. Cannot check object of type ${typeName} with undefined ID`);
        }
        
        return this.objects.has(objectId);
    }

    /**
     * Generate next object ID
     * Format: <PREFIX>_<BASE36_NUMBER>
     * Example: USER_00000001
     */
    async _nextObjectId(typeName) {
        const counter = this.counters.get(typeName) || 0;
        this.counters.set(typeName, counter + 1);
        
        const prefix = typeName.slice(0, 6).toUpperCase();
        const base36 = counter.toString(36).toUpperCase().padStart(8, '0');
        return `${prefix}_${base36}`;
    }

    /**
     * Get next number for a type (for compatibility)
     */
    async getNextNumber(typeName) {
        return this.counters.get(typeName) || 0;
    }

    /**
     * Utility methods for compatibility with tests
     */
    async shutDown() {
        // No-op for in-memory implementation
        return true;
    }

    async forceSave() {
        // No-op for in-memory implementation
        return true;
    }

    async getLogicalTimestamp() {
        return Date.now();
    }

    async getUserLogs(userId) {
        // Mock implementation
        return [];
    }
}

/**
 * Factory function to create a new InMemoryPersisto instance
 */
export async function createInMemoryPersisto() {
    return new InMemoryPersisto();
}

export async function initialisePersisto(storageStrategy, logger) {
    // If called without arguments or with null/undefined, create in-memory instance
    if (!storageStrategy) {
        return new InMemoryPersisto();
    }
    // Otherwise, could delegate to real implementation
    throw new Error('Storage strategy not supported in InMemoryPersisto');
}
