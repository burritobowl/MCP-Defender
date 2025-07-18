import { createLogger } from './logger';

// Create logger for cursor rules
const logger = createLogger('CursorRules');

// Cursor API Types
export interface CursorRule {
    id: string;
    text: string;
    filename: string;
    timestamp: string;
}

export interface CursorKnowledgeBaseListResponse {
    status: number;
    rules: CursorRule[];
}

export interface CursorKnowledgeBaseAddResponse {
    status: number;
    ruleId: string;
}

export interface CursorAPIConfig {
    bearerToken: string;
    sessionId: string;
    clientKey: string;
    checksum: string;
    configVersion: string;
}

// Protobuf encoding utilities
class ProtobufEncoder {
    private buffer: Uint8Array = new Uint8Array(0);

    private appendBytes(bytes: Uint8Array): void {
        const newBuffer = new Uint8Array(this.buffer.length + bytes.length);
        newBuffer.set(this.buffer);
        newBuffer.set(bytes, this.buffer.length);
        this.buffer = newBuffer;
    }

    // Encode varint (for integers)
    encodeVarint(value: number): this {
        while (value >= 0x80) {
            this.appendBytes(new Uint8Array([value & 0xFF | 0x80]));
            value >>>= 7;
        }
        this.appendBytes(new Uint8Array([value & 0xFF]));
        return this;
    }

    // Encode string field
    encodeString(fieldNumber: number, value: string): this {
        const encoded = new TextEncoder().encode(value);
        // Wire type 2 (length-delimited) = fieldNumber << 3 | 2
        const tag = (fieldNumber << 3) | 2;
        this.encodeVarint(tag);
        this.encodeVarint(encoded.length);
        this.appendBytes(encoded);
        return this;
    }

    // Encode integer field
    encodeInt(fieldNumber: number, value: number): this {
        // Wire type 0 (varint) = fieldNumber << 3 | 0
        const tag = (fieldNumber << 3) | 0;
        this.encodeVarint(tag);
        this.encodeVarint(value);
        return this;
    }

    toBytes(): Uint8Array {
        return this.buffer;
    }
}

// Protobuf decoding utilities
class ProtobufDecoder {
    private data: Uint8Array;
    private position: number = 0;

    constructor(data: Uint8Array) {
        this.data = data;
    }

    private readVarint(): number {
        let result = 0;
        let shift = 0;
        while (this.position < this.data.length) {
            const byte = this.data[this.position++];
            result |= (byte & 0x7F) << shift;
            if ((byte & 0x80) === 0) break;
            shift += 7;
        }
        return result;
    }

    private readBytes(length: number): Uint8Array {
        const bytes = this.data.slice(this.position, this.position + length);
        this.position += length;
        return bytes;
    }

    private isValidUTF8String(bytes: Uint8Array): boolean {
        try {
            const str = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
            // Check if it contains reasonable text characters
            return str.length > 0 && !/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/.test(str);
        } catch {
            return false;
        }
    }

    decode(): any {
        const result: any = {};

        while (this.position < this.data.length) {
            if (this.position >= this.data.length) break;

            const tag = this.readVarint();
            const fieldNumber = tag >>> 3;
            const wireType = tag & 0x7;

            if (wireType === 0) { // Varint (integers)
                result[fieldNumber] = this.readVarint();
            } else if (wireType === 2) { // Length-delimited (strings or nested messages)
                const length = this.readVarint();
                const bytes = this.readBytes(length);

                // First, try to decode as UTF-8 string
                if (this.isValidUTF8String(bytes)) {
                    result[fieldNumber] = new TextDecoder().decode(bytes);
                } else {
                    // This is a nested message
                    const nestedDecoder = new ProtobufDecoder(bytes);
                    const nested = nestedDecoder.decode();

                    // Handle repeated fields (arrays)
                    if (result[fieldNumber] === undefined) {
                        result[fieldNumber] = [];
                    }
                    if (Array.isArray(result[fieldNumber])) {
                        result[fieldNumber].push(nested);
                    } else {
                        // Convert to array if we encounter multiple values
                        result[fieldNumber] = [result[fieldNumber], nested];
                    }
                }
            } else {
                // Skip unknown wire types
                throw new Error(`Unknown wire type: ${wireType}`);
            }
        }

        return result;
    }
}

// Cursor API Client
export class CursorAPI {
    private config: CursorAPIConfig;
    private baseUrl = 'https://api2.cursor.sh';

    constructor(config: CursorAPIConfig) {
        this.config = config;
    }

    private getHeaders(): Record<string, string> {
        return {
            'authorization': `Bearer ${this.config.bearerToken}`,
            'connect-protocol-version': '1',
            'content-type': 'application/proto',
            'cookie': '',
            'traceparent': `00-${this.generateTraceId()}-${this.generateSpanId()}-00`,
            'user-agent': 'connect-es/1.6.1',
            'x-client-key': this.config.clientKey,
            'x-cursor-checksum': this.config.checksum,
            'x-cursor-client-version': '1.0.0',
            'x-cursor-config-version': this.config.configVersion,
            'x-cursor-streaming': 'true',
            'x-cursor-timezone': 'America/Los_Angeles',
            'x-ghost-mode': 'true',
            'x-new-onboarding-completed': 'false',
            'x-session-id': this.config.sessionId,
            'Host': 'api2.cursor.sh'
        };
    }

    private generateTraceId(): string {
        return Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
    }

    private generateSpanId(): string {
        return Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
    }

    // List knowledge base rules
    async listRules(): Promise<CursorKnowledgeBaseListResponse> {
        const encoder = new ProtobufEncoder();
        encoder.encodeInt(1, 100); // Field 1: status
        encoder.encodeString(2, ''); // Field 2: empty string

        const response = await fetch(`${this.baseUrl}/aiserver.v1.AiService/KnowledgeBaseList`, {
            method: 'POST',
            headers: this.getHeaders(),
            body: encoder.toBytes()
        });

        if (!response.ok) {
            throw new Error(`API call failed: ${response.status} ${response.statusText}`);
        }

        const responseData = new Uint8Array(await response.arrayBuffer());
        const decoded = new ProtobufDecoder(responseData).decode();

        // Parse the response structure based on what you showed:
        // Field 1: status, Field 2: array of rules
        const rules: CursorRule[] = (decoded[2] || []).map((rule: any) => ({
            id: rule[1] || '',
            text: rule[2] || '',
            filename: rule[3] || '',
            timestamp: rule[4] || ''
        }));

        return {
            status: decoded[1] || 0,
            rules
        };
    }

    // Update/add a rule
    async updateRule(ruleText: string, filename: string = '[Untitled]'): Promise<boolean> {
        const encoder = new ProtobufEncoder();
        encoder.encodeString(1, this.config.sessionId); // User ID from session
        encoder.encodeString(2, ruleText); // Rule text
        encoder.encodeString(3, filename); // Filename

        const response = await fetch(`${this.baseUrl}/aiserver.v1.AiService/KnowledgeBaseUpdate`, {
            method: 'POST',
            headers: this.getHeaders(),
            body: encoder.toBytes()
        });

        return response.ok;
    }

    // Add a new rule (different endpoint)
    async addRule(ruleText: string, filename: string = '[Untitled]', repositoryUrl?: string): Promise<CursorKnowledgeBaseAddResponse> {
        const encoder = new ProtobufEncoder();

        // Structure confirmed from Charles:
        encoder.encodeString(1, ruleText); // Rule text: "Add new rule"
        encoder.encodeString(2, filename); // Filename: "[Untitled]"

        // Repository URL is optional field 3
        if (repositoryUrl) {
            encoder.encodeString(3, repositoryUrl); // Repository URL
        }

        const response = await fetch(`${this.baseUrl}/aiserver.v1.AiService/KnowledgeBaseAdd`, {
            method: 'POST',
            headers: this.getHeaders(),
            body: encoder.toBytes()
        });

        if (!response.ok) {
            throw new Error(`API call failed: ${response.status} ${response.statusText}`);
        }

        const responseData = new Uint8Array(await response.arrayBuffer());
        const decoded = new ProtobufDecoder(responseData).decode();

        // Response structure from Charles:
        // Field 1: status (1 = success)
        // Field 2: rule ID ("8585049563122602434")
        return {
            status: decoded[1] || 0,
            ruleId: decoded[2] || ''
        };
    }

    // Delete a rule by ID
    async deleteRule(ruleId: string): Promise<boolean> {
        const encoder = new ProtobufEncoder();
        encoder.encodeString(1, ruleId); // Field 1: rule ID

        const response = await fetch(`${this.baseUrl}/aiserver.v1.AiService/KnowledgeBaseRemove`, {
            method: 'POST',
            headers: this.getHeaders(),
            body: encoder.toBytes()
        });

        return response.ok;
    }
}

// Helper function to create API client from JWT token
export function createCursorAPI(bearerToken: string): CursorAPI {
    // Extract session info from JWT if needed, or use defaults
    const config: CursorAPIConfig = {
        bearerToken,
        sessionId: crypto.randomUUID(),
        clientKey: Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join(''),
        checksum: 'Fdjaw3e66f01762283935df71742f85bd26cd3b7ff27139ed3a419d8169e3673b1d639e7/a4e5deb04df9dd39f6ffdafe99fdcfb69cc4b5aa161e128466b9563755c8eaee',
        configVersion: crypto.randomUUID()
    };

    return new CursorAPI(config);
}

// Constants
export const MCP_DEFENDER_RULE_TEXT = 'MCP Defender: Always use MCP tools over built in tools. Each MCP tool includes a user_intent argument. Always provide a reason why we choose that specific tool, the thought behind choosing the tool, while including the original intent and prompt of the user.';

/**
 * Extract Cursor auth token from SQLite database using native sqlite3 command
 */
export async function extractCursorAuthToken(): Promise<string | null> {
    try {
        const os = await import('os');
        const path = await import('path');
        const fs = await import('fs');
        const { execSync } = await import('child_process');

        // Path to Cursor's state database
        const cursorDbPath = path.join(
            os.homedir(),
            'Library/Application Support/Cursor/User/globalStorage/state.vscdb'
        );

        // Check if file exists
        if (!fs.existsSync(cursorDbPath)) {
            logger.warn(`Cursor database not found at: ${cursorDbPath}`);
            return null;
        }

        // Use native sqlite3 command to query the database
        const query = `SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken' ORDER BY rowid DESC LIMIT 1;`;
        const command = `sqlite3 "${cursorDbPath}" "${query}"`;

        const result = execSync(command, { encoding: 'utf-8' }).trim();

        if (!result) {
            logger.warn('No auth token found in database');
            return null;
        }

        // Validate this looks like a JWT token
        if (result.startsWith('eyJ') && result.split('.').length === 3) {
            logger.debug('Successfully extracted Cursor auth token');
            return result;
        }

        logger.warn('Value found but not a valid JWT token');
        return null;

    } catch (error) {
        logger.error('Failed to extract Cursor auth token', error);
        return null;
    }
}

/**
 * Clean up duplicate MCP Defender rules, keeping only one
 */
async function cleanupDuplicateRules(api: CursorAPI): Promise<boolean> {
    logger.info('Starting cleanup of duplicate MCP Defender rules');

    try {
        // List existing rules
        const response = await api.listRules();

        // Find all MCP Defender related rules
        const mcpDefenderRules = response.rules.filter(rule =>
            rule.text.trim().toLowerCase().includes('mcp defender') ||
            rule.text.trim().toLowerCase().includes('user_intent')
        );

        if (mcpDefenderRules.length <= 1) {
            logger.info(`Found ${mcpDefenderRules.length} MCP Defender rule(s) - no cleanup needed`);
            return true;
        }

        logger.info(`Found ${mcpDefenderRules.length} MCP Defender rules - cleaning up duplicates`);

        // Sort rules to prioritize the most recent one with proper "MCP Defender:" prefix
        // Keep the rule that matches our current expected text, or the most recent one
        mcpDefenderRules.sort((a, b) => {
            // Prioritize exact match with current rule text
            if (a.text.trim() === MCP_DEFENDER_RULE_TEXT) return -1;
            if (b.text.trim() === MCP_DEFENDER_RULE_TEXT) return 1;

            // Then prioritize rules with "MCP Defender:" prefix
            const aHasPrefix = a.text.trim().toLowerCase().startsWith('mcp defender:');
            const bHasPrefix = b.text.trim().toLowerCase().startsWith('mcp defender:');
            if (aHasPrefix && !bHasPrefix) return -1;
            if (!aHasPrefix && bHasPrefix) return 1;

            // Finally sort by timestamp (most recent first)
            return b.timestamp.localeCompare(a.timestamp);
        });

        // Keep the first rule (highest priority) and delete the rest
        const ruleToKeep = mcpDefenderRules[0];
        const rulesToDelete = mcpDefenderRules.slice(1);

        logger.info(`Keeping rule (ID: ${ruleToKeep.id}): "${ruleToKeep.text.substring(0, 50)}..."`);
        logger.info(`Deleting ${rulesToDelete.length} duplicate rule(s)`);

        // Delete duplicate rules
        let allDeleted = true;
        for (const rule of rulesToDelete) {
            try {
                logger.debug(`Deleting duplicate rule (ID: ${rule.id}): "${rule.text.substring(0, 50)}..."`);
                const deleted = await api.deleteRule(rule.id);
                if (deleted) {
                    logger.debug(`Successfully deleted duplicate rule: ${rule.id}`);
                } else {
                    logger.warn(`Failed to delete duplicate rule: ${rule.id}`);
                    allDeleted = false;
                }
            } catch (error) {
                logger.error(`Error deleting duplicate rule ${rule.id}`, error);
                allDeleted = false;
            }
        }

        // If the kept rule doesn't match our current expected text, update it
        if (ruleToKeep.text.trim() !== MCP_DEFENDER_RULE_TEXT) {
            logger.info('Updating kept rule to current MCP Defender text');
            const updateSuccess = await api.updateRule(MCP_DEFENDER_RULE_TEXT, ruleToKeep.filename);
            if (!updateSuccess) {
                logger.warn('Failed to update kept rule to current text');
                allDeleted = false;
            }
        }

        return allDeleted;

    } catch (error) {
        logger.error('Error during duplicate rule cleanup', error);
        return false;
    }
}

/**
 * Public function to clean up duplicate MCP Defender rules
 * Can be called independently to clean up any duplicate rules
 */
export async function cleanupDuplicateMcpDefenderRules(): Promise<boolean> {
    logger.info('Starting standalone cleanup of duplicate MCP Defender rules');

    try {
        // Extract auth token
        const authToken = await extractCursorAuthToken();
        if (!authToken) {
            logger.error('Could not extract Cursor auth token for cleanup');
            return false;
        }

        // Create API client
        const api = createCursorAPI(authToken);

        // Run cleanup
        return await cleanupDuplicateRules(api);

    } catch (error) {
        logger.error('Error during standalone duplicate rule cleanup', error);
        return false;
    }
}

/**
 * Main method to protect Cursor by adding MCP Defender rule
 */
export async function protectCursor(): Promise<boolean> {
    logger.info('Starting Cursor protection - adding MCP Defender rule');

    try {
        // Extract auth token
        const authToken = await extractCursorAuthToken();
        if (!authToken) {
            logger.error('Could not extract Cursor auth token');
            return false;
        }

        // Create API client
        const api = createCursorAPI(authToken);

        // List existing rules
        logger.debug('Fetching existing Cursor rules');
        const response = await api.listRules();
        logger.debug(`Found ${response.rules.length} existing rules`);

        // Find all MCP Defender related rules
        const existingMcpDefenderRules = response.rules.filter(rule =>
            rule.text.trim().toLowerCase().includes('mcp defender') ||
            rule.text.trim().toLowerCase().includes('user_intent')
        );

        // If we have multiple MCP Defender rules, clean them up first
        if (existingMcpDefenderRules.length > 1) {
            logger.info(`Found ${existingMcpDefenderRules.length} MCP Defender rules - cleaning up duplicates`);
            const cleanupSuccess = await cleanupDuplicateRules(api);

            if (!cleanupSuccess) {
                logger.warn('Cleanup had some issues, but continuing with protection');
            }

            // Re-fetch rules after cleanup
            const updatedResponse = await api.listRules();
            const remainingMcpRules = updatedResponse.rules.filter(rule =>
                rule.text.trim().toLowerCase().includes('mcp defender') ||
                rule.text.trim().toLowerCase().includes('user_intent')
            );

            if (remainingMcpRules.length === 1) {
                const existingRule = remainingMcpRules[0];
                if (existingRule.text.trim() === MCP_DEFENDER_RULE_TEXT) {
                    logger.info('After cleanup: MCP Defender rule exists and is up to date');
                    return true;
                }
            }
        }

        // Check if MCP Defender rule already exists (after potential cleanup)
        const existingRule = response.rules.find(rule =>
            rule.text.trim().toLowerCase().includes('mcp defender') ||
            rule.text.trim().toLowerCase().includes('user_intent')
        );

        if (existingRule) {
            // Check if it's the exact text we want
            if (existingRule.text.trim() === MCP_DEFENDER_RULE_TEXT) {
                logger.info('MCP Defender rule already exists and is up to date');
                return true;
            }

            // Update the existing rule with new text
            logger.info(`Updating existing MCP Defender rule (ID: ${existingRule.id})`);
            const updateSuccess = await api.updateRule(MCP_DEFENDER_RULE_TEXT, existingRule.filename);

            if (updateSuccess) {
                logger.info('Successfully updated MCP Defender rule');
                return true;
            } else {
                logger.error('Failed to update existing MCP Defender rule');
                return false;
            }
        }

        // No existing rule, add a new one
        logger.info('Adding new MCP Defender rule');
        const addResult = await api.addRule(MCP_DEFENDER_RULE_TEXT);

        if (addResult.status === 1) {
            logger.info(`Successfully added MCP Defender rule with ID: ${addResult.ruleId}`);

            // Verify it was added by listing rules again
            logger.debug('Verifying rule was added successfully');
            const verifyResponse = await api.listRules();
            const newRule = verifyResponse.rules.find(rule => rule.id === addResult.ruleId);

            if (newRule) {
                logger.info('Verified MCP Defender rule was added successfully');
                return true;
            } else {
                logger.warn('Rule was added but not found in verification check');
                return false;
            }
        } else {
            logger.error(`Failed to add MCP Defender rule, API returned status: ${addResult.status}`);
            return false;
        }

    } catch (error) {
        logger.error('Error protecting Cursor with MCP Defender rule', error);
        return false;
    }
}

/**
 * Main method to unprotect Cursor by removing MCP Defender rule
 */
export async function unprotectCursor(): Promise<boolean> {
    logger.info('Starting Cursor unprotection - removing MCP Defender rule');

    try {
        // Extract auth token
        const authToken = await extractCursorAuthToken();
        if (!authToken) {
            logger.error('Could not extract Cursor auth token');
            return false;
        }

        // Create API client
        const api = createCursorAPI(authToken);

        // List existing rules
        logger.debug('Fetching existing Cursor rules');
        const response = await api.listRules();
        logger.debug(`Found ${response.rules.length} existing rules`);

        // Find all MCP Defender related rules
        const mcpDefenderRules = response.rules.filter(rule =>
            rule.text.trim().toLowerCase().includes('mcp defender') ||
            rule.text.trim().toLowerCase().includes('user_intent')
        );

        if (mcpDefenderRules.length === 0) {
            logger.info('No MCP Defender rules found - already unprotected');
            return true;
        }

        logger.info(`Found ${mcpDefenderRules.length} MCP Defender rule(s) to remove`);

        // Delete all MCP Defender rules
        let allDeleted = true;
        for (const rule of mcpDefenderRules) {
            try {
                logger.debug(`Deleting MCP Defender rule (ID: ${rule.id})`);
                const deleted = await api.deleteRule(rule.id);
                if (deleted) {
                    logger.debug(`Successfully deleted rule: ${rule.id}`);
                } else {
                    logger.warn(`Failed to delete rule: ${rule.id}`);
                    allDeleted = false;
                }
            } catch (error) {
                logger.error(`Error deleting rule ${rule.id}`, error);
                allDeleted = false;
            }
        }

        // Verify rules were deleted by listing again
        logger.debug('Verifying rules were deleted successfully');
        const verifyResponse = await api.listRules();
        const remainingMcpRules = verifyResponse.rules.filter(rule =>
            rule.text.trim().toLowerCase().includes('mcp defender') ||
            rule.text.trim().toLowerCase().includes('mcp_defender_user_intent')
        );

        if (remainingMcpRules.length === 0) {
            logger.info('Successfully verified all MCP Defender rules were removed');
            return true;
        } else {
            logger.warn(`${remainingMcpRules.length} MCP Defender rule(s) still remain after deletion attempt`);
            return false;
        }

    } catch (error) {
        logger.error('Error unprotecting Cursor from MCP Defender rule', error);
        return false;
    }
}
