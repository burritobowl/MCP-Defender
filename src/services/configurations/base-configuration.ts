import { ServerConfig, MCPConfig, ProtectedServerConfig, MCPDefenderEnvVar, MCP_DEFENDER_CONSTANTS } from './types';
import * as path from 'path';
import * as fs from 'node:fs/promises';
import { createLogger } from '../../utils/logger';
import { recentlyModifiedByUs } from './service';

// Create a logger for base configuration
const logger = createLogger('BaseConfiguration');

/**
 * Base class for MCP configuration handling
 * Provides common functionality for all configuration implementations
 * 
 * Protection approach:
 * 1. First unprotect the configuration to create a clean normalized state
 * 2. Then re-protect everything in a consistent manner
 * 
 * This two-step approach simplifies the process and avoids complex conditional logic.
 */
export abstract class BaseMCPConfiguration {
    protected proxyPort: number = 28173;
    protected cliPath: string;

    // App metadata
    protected appName: string;
    protected appDisplayName: string;
    protected appIconPath?: string;

    // Logger instance
    protected logger = createLogger('BaseMCPConfiguration');

    // Whether the app requires a restart for configuration changes to take effect
    protected requiresRestart: boolean = false;

    /**
     * Create a new configuration handler
     * @param appName Application name (used for internal identification)
     * @param displayName Human-readable display name for the application
     * @param cliPath Path to the CLI script
     * @param iconPath Optional path to the app's icon
     * @param requiresRestart Whether the app requires restart for config changes
     */
    constructor(
        appName: string,
        displayName: string,
        cliPath: string,
        iconPath?: string,
        requiresRestart: boolean = false
    ) {
        this.appName = appName;
        this.appDisplayName = displayName || appName;
        this.cliPath = cliPath;
        this.appIconPath = iconPath;
        this.requiresRestart = requiresRestart;
    }

    /**
     * Get the application name
     */
    getAppName(): string {
        return this.appName;
    }

    /**
     * Get the display name for the application
     */
    getAppDisplayName(): string {
        return this.appDisplayName;
    }

    /**
     * Get the icon path for the application
     */
    getAppIconPath(): string | undefined {
        return this.appIconPath;
    }

    /**
     * Check if the application requires a restart for configuration changes to take effect
     */
    requiresRestartForChanges(): boolean {
        return this.requiresRestart;
    }

    /**
     * Get the configuration file path
     * This must be implemented by derived classes
     */
    abstract getConfigPath(): string;

    /**
     * Set a custom configuration path
     * This is an optional method that can be implemented by derived classes
     * @param configPath The new configuration path
     */
    setConfigPath(configPath: string): void {
        // Base implementation does nothing
        // Derived classes should override this if they support custom paths
        this.logger.warn(`setConfigPath called on a configuration class that doesn't support it`);
    }

    /**
     * Read the configuration from a file
     * @param filePath Path to the configuration file
     * @returns The parsed configuration
     */
    async readConfig(filePath: string): Promise<any> {
        try {
            const content = await fs.readFile(filePath, 'utf-8');
            return JSON.parse(content);
        } catch (error: any) {
            // Check if the error is specifically because the file doesn't exist
            if (error.code === 'ENOENT') {
                // Create a custom error type for file not found
                const notFoundError = new Error(`Configuration file not found: ${filePath}`);
                (notFoundError as any).code = 'CONFIG_NOT_FOUND';
                (notFoundError as any).originalError = error;
                throw notFoundError;
            }
            // For other errors, throw a generic error
            throw new Error(`Failed to read config from ${filePath}: ${error.message}`);
        }
    }

    /**
     * Write configuration to a file
     * @param filePath Path to the configuration file
     * @param config Configuration to write
     */
    async writeConfig(filePath: string, config: any): Promise<void> {
        const dirPath = path.dirname(filePath);

        try {
            // Ensure directory exists
            await fs.mkdir(dirPath, { recursive: true });
            await fs.writeFile(filePath, JSON.stringify(config, null, 2), 'utf-8');

            // Mark this file as recently modified by us to prevent watcher from reprocessing
            recentlyModifiedByUs.add(filePath);
            logger.debug(`Marked file as modified by us: ${filePath}`);

            // Set a timeout to remove from the set after a delay
            setTimeout(() => {
                recentlyModifiedByUs.delete(filePath);
                logger.debug(`Removed file from modified tracker: ${filePath}`);
            }, 2000); // 2 seconds should be enough for watchers to trigger and be ignored
        } catch (error) {
            throw new Error(`Failed to write config to ${filePath}: ${error.message}`);
        }
    }

    /**
     * Get the backup (unprotected) configuration file path
     * @returns The absolute path to the backup configuration file
     */
    getUnprotectedConfigPath(): string {
        const configPath = this.getConfigPath();
        const dir = path.dirname(configPath);
        const fileName = path.basename(configPath, '.json');
        return path.join(dir, `${fileName}.unprotected.json`);
    }

    /**
     * Extract actual MCP configuration from application-specific format
     * @param appConfig Application configuration object
     * @returns Standard MCP configuration
     */
    abstract extractMCPConfig(appConfig: any): MCPConfig;

    /**
     * Merge MCP configuration back into application-specific format
     * @param appConfig Application configuration object
     * @param mcpConfig MCP configuration to merge
     * @returns Updated application configuration
     */
    abstract mergeMCPConfig(appConfig: any, mcpConfig: MCPConfig): any;

    /**
     * Analyze a configuration to find protected and unprotected servers
     * @param config Configuration to analyze
     * @returns List of tracked server configurations
     */
    analyzeConfig(config: MCPConfig): ProtectedServerConfig[] {
        const result: ProtectedServerConfig[] = [];

        // If no servers, return empty array
        if (!config.mcpServers || Object.keys(config.mcpServers).length === 0) {
            return result;
        }

        // Check each server
        for (const [configKey, server] of Object.entries(config.mcpServers)) {
            let isProtected = false;

            // Determine the actual server name (removing protection indicator if present)
            let actualServerName = configKey;

            // If this server is protected, get the original server name from env variable
            if (server.env?.[MCPDefenderEnvVar.ServerName]) {
                actualServerName = server.env[MCPDefenderEnvVar.ServerName];
                isProtected = true;
            } else {
                // Check if this is a protected server by looking at configuration
                if ('url' in server) {
                    // SSE server
                    try {
                        const url = new URL(server.url);
                        if (
                            url.hostname === 'localhost' &&
                            url.port === this.proxyPort.toString() &&
                            server.env?.[MCPDefenderEnvVar.OriginalUrl]
                        ) {
                            isProtected = true;
                        }
                    } catch (error) {
                        // Invalid URL, not protected
                    }
                } else if ('command' in server) {
                    // STDIO server
                    const command = server.command;
                    const args = server.args;

                    // Check if using our CLI proxy
                    isProtected =
                        command === 'node' &&
                        args.length > 0 &&
                        args[0].includes('cli.js') &&
                        args[0].includes(this.cliPath);
                }

                // If not already determined to be protected, but has protection indicator in name,
                // extract the original name
                if (!isProtected && configKey.includes(MCP_DEFENDER_CONSTANTS.PROTECTION_INDICATOR)) {
                    actualServerName = configKey.replace(MCP_DEFENDER_CONSTANTS.PROTECTION_INDICATOR, '');
                }
            }

            result.push({
                serverName: actualServerName, // Use the actual server name for routing
                config: server,
                isProtected,
                tools: [] // Initialize with empty array of tools
            });
        }

        return result;
    }

    /**
     * Generate a proxied version of the MCP configuration
     * @param config The original MCP configuration
     * @param appName Optional application name for context
     * @param enableSSEProxying Whether to proxy SSE transports (default: true for backwards compatibility)
     * @returns The proxied MCP configuration
     */
    protectConfig(config: MCPConfig, appName?: string, enableSSEProxying: boolean = true): MCPConfig {
        // Create a deep copy to avoid modifying the original
        const proxiedConfig: MCPConfig = JSON.parse(JSON.stringify(config));
        const serverCount = Object.keys(proxiedConfig.mcpServers || {}).length;

        // Use the app name from the configuration path if not provided
        const effectiveAppName = appName || path.basename(this.getConfigPath(), '.json');
        logger.debug(`Protecting ${serverCount} servers for app: ${effectiveAppName}, SSE proxying: ${enableSSEProxying}`);

        // We need to track renamed servers to update the object after iteration
        const renamedServers: Array<{ oldKey: string, newKey: string, server: any }> = [];

        // Process each server configuration
        for (const [key, server] of Object.entries(proxiedConfig.mcpServers)) {
            // Determine the new server name with protection indicator
            const newKey = key.includes('🔒') ? key : `${key}${MCP_DEFENDER_CONSTANTS.PROTECTION_INDICATOR}`;

            // Track if we need to rename this server
            if (newKey !== key) {
                renamedServers.push({ oldKey: key, newKey, server });
            }

            // Handle SSE servers
            if ('url' in server) {
                if (enableSSEProxying) {
                    // Store original URL
                    const originalUrl = server.url;
                    logger.debug(`Protecting SSE server: ${key}, original URL: ${originalUrl}`);

                    // Update to use our proxy endpoint - include app name in path
                    // Use original key (not new key) for the URL path to maintain consistency
                    server.url = `http://localhost:${this.proxyPort}/${effectiveAppName}/${key}/sse`;

                    // Add metadata - store the original server name
                    server.env = {
                        ...server.env || {},
                        [MCPDefenderEnvVar.OriginalUrl]: originalUrl,
                        [MCPDefenderEnvVar.AppName]: effectiveAppName,
                        [MCPDefenderEnvVar.ServerName]: key // Store original name for internal use
                    };
                } else {
                    logger.debug(`Skipping SSE server protection (disabled): ${key}, URL: ${server.url}`);
                    // Leave SSE server unchanged when proxying is disabled
                }
            }

            // Handle STDIO servers (always protected regardless of SSE setting)
            if ('command' in server) {
                // Store original command and args (handle undefined args)
                const originalCommand = server.command;
                const originalArgs = server.args ? [...server.args] : [];
                logger.debug(`Protecting STDIO server: ${key}, original command: ${originalCommand}, original args: ${originalArgs.length}`);

                // Add metadata - store the original server name
                const newEnv = {
                    ...server.env || {},
                    [MCPDefenderEnvVar.OriginalCommand]: originalCommand,
                    [MCPDefenderEnvVar.OriginalArgs]: JSON.stringify(originalArgs),
                    [MCPDefenderEnvVar.AppName]: effectiveAppName,
                    [MCPDefenderEnvVar.ServerName]: key // Store original name for internal use
                };

                // Update to use our CLI
                server.command = 'node';
                server.args = [
                    this.cliPath,
                    originalCommand,
                    ...originalArgs
                ];
                server.env = newEnv;
            }
        }

        // Apply server renames after iteration to avoid modifying object during iteration
        for (const { oldKey, newKey, server } of renamedServers) {
            // Remove old key
            delete proxiedConfig.mcpServers[oldKey];
            // Add with new key
            proxiedConfig.mcpServers[newKey] = server;
            logger.debug(`Renamed server from "${oldKey}" to "${newKey}"`);
        }

        return proxiedConfig;
    }

    /**
     * Restore the original unprotected configuration
     */
    async restoreUnprotectedConfig(): Promise<{
        success: boolean,
        message: string,
        servers?: ProtectedServerConfig[],
        isNotFound?: boolean
    }> {
        try {
            const configPath = this.getConfigPath();
            const unprotectedPath = this.getUnprotectedConfigPath();

            logger.info(`Attempting to restore unprotected config from ${unprotectedPath} to ${configPath}`);

            // Check if the original config path exists
            try {
                await fs.stat(configPath);
            } catch (error: any) {
                logger.error(`Original config path does not exist: ${configPath}`, error);
                if (error.code === 'ENOENT') {
                    return {
                        success: false,
                        message: `Configuration file not found - application may not be installed`,
                        isNotFound: true
                    };
                }
                return {
                    success: false,
                    message: `Original configuration file does not exist: ${configPath}`
                };
            }

            // Check if backup exists using fs.stat instead of fs.access for better error info
            try {
                const stats = await fs.stat(unprotectedPath);
                if (!stats.isFile()) {
                    return {
                        success: false,
                        message: `Unprotected configuration backup exists but is not a file: ${unprotectedPath}`
                    };
                }

                logger.info(`Found unprotected backup file at ${unprotectedPath}`);
            } catch (error) {
                logger.error(`No unprotected backup file found at ${unprotectedPath}:`, error);
                return {
                    success: false,
                    message: `No unprotected configuration backup found at ${unprotectedPath}`
                };
            }

            // Read the unprotected config
            logger.info(`Reading unprotected config from ${unprotectedPath}`);
            let unprotectedConfig;
            try {
                unprotectedConfig = await this.readConfig(unprotectedPath);
            } catch (error) {
                logger.error(`Failed to read unprotected config: ${unprotectedPath}`, error);
                return {
                    success: false,
                    message: `Failed to read unprotected configuration: ${error.message}`
                };
            }

            // Write it back to the main config
            logger.info(`Writing unprotected config to ${configPath}`);
            try {
                await this.writeConfig(configPath, unprotectedConfig);
            } catch (error) {
                logger.error(`Failed to write config to ${configPath}`, error);
                return {
                    success: false,
                    message: `Failed to write unprotected configuration to main file: ${error.message}`
                };
            }

            // Extract and analyze
            const mcpConfig = this.extractMCPConfig(unprotectedConfig);
            const servers = this.analyzeConfig(mcpConfig);
            logger.info(`Analyzed ${servers.length} servers in the restored configuration`);

            // Delete the unprotected backup file since we don't need it anymore
            try {
                logger.info(`Deleting unprotected backup file at ${unprotectedPath}`);
                await fs.unlink(unprotectedPath);
                logger.info(`Successfully deleted ${unprotectedPath}`);
            } catch (deleteError) {
                logger.error(`Failed to delete unprotected backup file at ${unprotectedPath}:`, deleteError);
                // Continue with the restoration process even if deletion fails
            }

            return {
                success: true,
                message: "Successfully restored unprotected configuration",
                servers
            };
        } catch (error) {
            logger.error('Error in restoreUnprotectedConfig:', error);
            return {
                success: false,
                message: `Error restoring unprotected config: ${error.message}`
            };
        }
    }

    /**
     * Process a configuration file for protection
     * Reads, unprotects, protects, and writes back the configuration
     * @param appName Optional application name for context
     * @param enableSSEProxying Whether to proxy SSE transports (default: true for backwards compatibility)
     */
    async processConfigFile(appName?: string, enableSSEProxying: boolean = true): Promise<{
        success: boolean,
        message: string,
        servers?: ProtectedServerConfig[],
        isNotFound?: boolean
    }> {
        try {
            const configPath = this.getConfigPath();
            logger.info(`Processing config file: ${configPath} for app: ${appName || 'unknown'}, SSE proxying: ${enableSSEProxying}`);

            // Read current config
            const appConfig = await this.readConfig(configPath);

            // Extract MCP portion
            const mcpConfig = this.extractMCPConfig(appConfig);

            // Analyze current state for logging purposes
            const initialServers = this.analyzeConfig(mcpConfig);
            const protectedCount = initialServers.filter(s => s.isProtected).length;
            logger.info(`Initial state: ${initialServers.length} servers, ${protectedCount} already protected`);

            // Save a backup of the unprotected config if we don't already have one
            const unprotectedPath = this.getUnprotectedConfigPath();
            try {
                await fs.stat(unprotectedPath);
                logger.debug(`Unprotected backup already exists at ${unprotectedPath}`);
                // If we get here, backup exists - no need to create one
            } catch (error) {
                // No backup exists, create one now of the current state
                logger.info(`Creating unprotected backup at ${unprotectedPath}`);
                await this.backupConfig(appConfig);
            }

            // Step 1: Unprotect the config
            logger.debug(`Unprotecting configuration`);
            const unprotectedMcpConfig = this.unprotectConfig(mcpConfig);

            // Step 1.5: Inject secure tools server if setting is enabled
            logger.debug(`Checking for secure tools server injection`);
            const configWithSecureTools = this.injectSecureToolsServer(unprotectedMcpConfig);

            // Step 2: Protect the config (clean slate approach)
            logger.debug(`Re-protecting configuration`);
            const protectedMcpConfig = this.protectConfig(configWithSecureTools, appName, enableSSEProxying);

            // Step 3: Merge back into app-specific format
            const updatedAppConfig = this.mergeMCPConfig(appConfig, protectedMcpConfig);

            // Step 4: Write the updated config
            logger.info(`Writing protected config to ${configPath}`);
            await this.writeConfig(configPath, updatedAppConfig);

            // Analyze to confirm protection
            const updatedMcpConfig = this.extractMCPConfig(updatedAppConfig);
            const updatedServers = this.analyzeConfig(updatedMcpConfig);
            const newProtectedCount = updatedServers.filter(s => s.isProtected).length;
            logger.info(`Final state: ${updatedServers.length} servers, ${newProtectedCount} protected`);

            // Generate appropriate success message
            let message;
            if (initialServers.length === 0) {
                message = `No servers found in configuration`;
                return {
                    success: false,
                    message,
                    servers: updatedServers
                };
            } else if (newProtectedCount === 0) {
                message = `Failed to protect any servers`;
                return {
                    success: false,
                    message,
                    servers: updatedServers
                };
            } else if (newProtectedCount < updatedServers.length) {
                message = `Protected ${newProtectedCount} of ${updatedServers.length} servers`;
            } else {
                message = `Protected ${updatedServers.length} servers successfully`;
            }

            return {
                success: true,
                message,
                servers: updatedServers
            };
        } catch (error: any) {
            // Check if this is a file not found error
            if (error.code === 'CONFIG_NOT_FOUND') {
                logger.info(`Configuration file not found: ${error.message}`);
                return {
                    success: false,
                    message: 'Configuration file not found - application may not be installed',
                    isNotFound: true
                };
            }

            logger.error(`Error processing config: ${error.message}`, error);
            return {
                success: false,
                message: `Error processing config: ${error.message}`
            };
        }
    }

    /**
     * Save a backup of the unprotected configuration
     * @param config Original configuration
     */
    async backupConfig(config: any): Promise<void> {
        const unprotectedPath = this.getUnprotectedConfigPath();
        await this.writeConfig(unprotectedPath, config);
    }

    /**
     * Reverse protection on a configuration, restoring original settings
     * @param config Configuration to unprotect
     * @returns Unprotected configuration
     */
    unprotectConfig(config: MCPConfig): MCPConfig {
        // Create a deep copy to avoid modifying the original
        const unprotectedConfig: MCPConfig = JSON.parse(JSON.stringify(config));
        const serverCount = Object.keys(unprotectedConfig.mcpServers || {}).length;
        logger.debug(`Unprotecting ${serverCount} servers`);

        // Remove MCP Defender Secure Tools server if it exists
        // This server should only be present when MCP Defender is running
        // Check for both old name (mcp-defender-secure-tools) and new name (secure-tools)
        const oldSecureToolsServerName = 'mcp-defender-secure-tools';
        const newSecureToolsServerName = 'secure-tools';

        if (unprotectedConfig.mcpServers && unprotectedConfig.mcpServers[oldSecureToolsServerName]) {
            delete unprotectedConfig.mcpServers[oldSecureToolsServerName];
            logger.debug('Removed MCP Defender Secure Tools server (old name) from unprotected configuration');
        }

        if (unprotectedConfig.mcpServers && unprotectedConfig.mcpServers[newSecureToolsServerName]) {
            delete unprotectedConfig.mcpServers[newSecureToolsServerName];
            logger.debug('Removed MCP Defender Secure Tools server (new name) from unprotected configuration');
        }

        // Track servers that need to be renamed (remove protection indicator)
        const renamedServers: Array<{ oldKey: string, newKey: string, server: any }> = [];

        // Process each server configuration
        for (const [key, server] of Object.entries(unprotectedConfig.mcpServers)) {
            // Remove protection indicator from server name if present
            if (key.includes(MCP_DEFENDER_CONSTANTS.PROTECTION_INDICATOR)) {
                const originalKey = key.replace(MCP_DEFENDER_CONSTANTS.PROTECTION_INDICATOR, '');
                renamedServers.push({ oldKey: key, newKey: originalKey, server });
                logger.debug(`Will restore server name from "${key}" to "${originalKey}"`);
            }
            // Handle SSE servers (URL-based)
            if ('url' in server && server.env?.[MCPDefenderEnvVar.OriginalUrl]) {
                logger.debug(`Unprotecting SSE server: ${key}`);
                // Restore the original URL
                server.url = server.env[MCPDefenderEnvVar.OriginalUrl];

                // Create a new env object without our metadata
                const newEnv = { ...server.env };
                delete newEnv[MCPDefenderEnvVar.OriginalUrl];
                delete newEnv[MCPDefenderEnvVar.AppName];
                delete newEnv[MCPDefenderEnvVar.ServerName];

                // Only keep env if it has other properties
                if (Object.keys(newEnv).length > 0) {
                    server.env = newEnv;
                } else {
                    delete server.env;
                }
            }

            // Handle STDIO servers (command-based)
            if ('command' in server &&
                server.command === 'node' &&
                server.args?.length > 0 &&
                server.args[0].includes(this.cliPath)) {

                logger.debug(`Unprotecting STDIO server: ${key}`);
                // Restore original command and args if available
                if (server.env?.[MCPDefenderEnvVar.OriginalCommand]) {
                    server.command = server.env[MCPDefenderEnvVar.OriginalCommand];

                    try {
                        // Parse the original args if they were stored as JSON
                        if (server.env[MCPDefenderEnvVar.OriginalArgs]) {
                            server.args = JSON.parse(server.env[MCPDefenderEnvVar.OriginalArgs]);
                        } else {
                            // If no args were stored, use empty array
                            server.args = [];
                        }
                    } catch (error) {
                        // If parsing fails, use empty array
                        logger.error(`Failed to parse original args for server ${key}`, error);
                        server.args = [];
                    }

                    // Create a new env object without our metadata
                    const newEnv = { ...server.env };
                    delete newEnv[MCPDefenderEnvVar.OriginalCommand];
                    delete newEnv[MCPDefenderEnvVar.OriginalArgs];
                    delete newEnv[MCPDefenderEnvVar.AppName];
                    delete newEnv[MCPDefenderEnvVar.ServerName];

                    // Only keep env if it has other properties
                    if (Object.keys(newEnv).length > 0) {
                        server.env = newEnv;
                    } else {
                        delete server.env;
                    }
                }
            }
        }

        // Apply server renames after processing to restore original names
        for (const { oldKey, newKey, server } of renamedServers) {
            // Remove old key with protection indicator
            delete unprotectedConfig.mcpServers[oldKey];
            // Add with original key name
            unprotectedConfig.mcpServers[newKey] = server;
            logger.debug(`Restored server name from "${oldKey}" to "${newKey}"`);
        }

        return unprotectedConfig;
    }

    /**
     * Inject or remove MCP Defender Secure Tools server based on the setting
     * @param config MCP configuration to modify
     * @returns Modified configuration with secure tools server added or removed based on setting
     */
    injectSecureToolsServer(config: MCPConfig): MCPConfig {
        // Get settings from service manager to check if secure tools should be enabled
        try {
            // Access the service manager through the global process object to avoid bundling issues
            const serviceManagerInstance = (global as any).__SERVICE_MANAGER_INSTANCE__;
            if (!serviceManagerInstance) {
                this.logger.warn('ServiceManager not available for secure tools injection');
                return config;
            }

            const settings = serviceManagerInstance.settingsService.getSettings();

            // Create a copy of the config to avoid modifying the original
            const modifiedConfig: MCPConfig = JSON.parse(JSON.stringify(config));

            // Ensure mcpServers object exists
            if (!modifiedConfig.mcpServers) {
                modifiedConfig.mcpServers = {};
            }

            // Define server names to check for (both old and new naming)
            const oldSecureToolsServerName = 'mcp-defender-secure-tools';
            const newSecureToolsServerName = 'secure-tools';

            if (!settings.useMCPDefenderSecureTools) {
                // Setting is disabled, remove secure tools server if it exists
                this.logger.debug('MCP Defender Secure Tools setting is disabled - removing server if present');

                let removedAny = false;

                // Remove old name if it exists
                if (modifiedConfig.mcpServers[oldSecureToolsServerName]) {
                    delete modifiedConfig.mcpServers[oldSecureToolsServerName];
                    this.logger.info('Removed MCP Defender Secure Tools server (old name) from configuration');
                    removedAny = true;
                }

                // Remove new name if it exists
                if (modifiedConfig.mcpServers[newSecureToolsServerName]) {
                    delete modifiedConfig.mcpServers[newSecureToolsServerName];
                    this.logger.info('Removed MCP Defender Secure Tools server (new name) from configuration');
                    removedAny = true;
                }

                if (!removedAny) {
                    this.logger.debug('No MCP Defender Secure Tools server found to remove');
                }

                return modifiedConfig;
            }

            // Setting is enabled, add secure tools server if it doesn't exist
            this.logger.info('Injecting MCP Defender Secure Tools server into configuration');

            // Add the secure tools server if it doesn't already exist
            if (!modifiedConfig.mcpServers[newSecureToolsServerName]) {
                // Use the published npm package via npx
                modifiedConfig.mcpServers[newSecureToolsServerName] = {
                    command: 'npx',
                    args: ['-y', '@mcp-defender/mcp-defender-secure-tools'],
                    env: {}
                };

                this.logger.info('Added MCP Defender Secure Tools server to configuration using published package');
            } else {
                this.logger.debug('MCP Defender Secure Tools server already exists in configuration');
            }

            return modifiedConfig;
        } catch (error) {
            this.logger.error('Failed to inject/remove secure tools server:', error);
            return config; // Return original config on error
        }
    }
} 