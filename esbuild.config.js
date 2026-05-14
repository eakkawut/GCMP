/* eslint-disable no-undef, @typescript-eslint/no-require-imports */
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');
const isWatch = process.argv.includes('--watch');
const isDev = process.argv.includes('--dev');


//#region Copy chat-lib related resource files
// postinstall.ts resource copy logic
const treeSitterGrammars = [
    'tree-sitter-c-sharp',
    'tree-sitter-cpp',
    'tree-sitter-go',
    'tree-sitter-javascript', // Also includes jsx support
    'tree-sitter-python',
    'tree-sitter-ruby',
    'tree-sitter-typescript',
    'tree-sitter-tsx',
    'tree-sitter-java',
    'tree-sitter-rust',
    'tree-sitter-php'
];

const REPO_ROOT = path.join(__dirname, '.');

async function fileExists(filePath) {
    try {
        await fs.promises.access(filePath, fs.constants.F_OK);
        return true;
    } catch {
        return false;
    }
}

async function platformDir() {
    try {
        // Find tokenizer file in @vscode/chat-lib
        const chatlibModulePath = require.resolve('@vscode/chat-lib');
        // chat-lib root directory is parent of dist/src
        const chatlibRoot = path.join(path.dirname(chatlibModulePath), '../..');

        // First try to find platform-specific path
        const platformPath = path.join(chatlibRoot, 'dist/src/_internal/platform');
        if (await fileExists(platformPath)) {
            return path.relative(REPO_ROOT, platformPath);
        }

        // Try to find chat-lib's direct dist directory
        const distPath = path.join(chatlibRoot, 'dist');
        if (await fileExists(distPath)) {
            return path.relative(REPO_ROOT, distPath);
        }

        console.log('Chat-lib directory not found, skipping tokenizer files');
        return null;
    } catch {
        console.log('Could not resolve @vscode/chat-lib, skipping tokenizer files');
        return null;
    }
}

function treeSitterWasmDir() {
    try {
        const modulePath = path.dirname(require.resolve('@vscode/tree-sitter-wasm'));
        return path.relative(REPO_ROOT, modulePath);
    } catch {
        console.warn('Could not resolve @vscode/tree-sitter-wasm, skipping tree-sitter files');
        return null;
    }
}

async function copyStaticAssets(srcpaths, dst) {
    await Promise.all(srcpaths.map(async srcpath => {
        const src = path.join(REPO_ROOT, srcpath);
        const dest = path.join(REPO_ROOT, dst, path.basename(srcpath));
        try {
            await fs.promises.mkdir(path.dirname(dest), { recursive: true });
            await fs.promises.copyFile(src, dest);
            // Only output target file path relative to project root
            const relativeDest = path.relative(REPO_ROOT, dest);
            console.log(`Copied: ${relativeDest}`);
        } catch {
            console.warn(`Failed to copy ${srcpath}`);
        }
    }));
}

async function copyBuildAssets() {
    console.log('Copying build assets...');
    const platform = await platformDir();
    const wasm = treeSitterWasmDir();

    const filesToCopy = [];

    // Process tokenizer files
    if (platform) {
        const vendoredTiktokenFiles = [
            `${platform}/tokenizer/node/cl100k_base.tiktoken`,
            `${platform}/tokenizer/node/o200k_base.tiktoken`
        ].filter(file => fs.existsSync(path.join(REPO_ROOT, file)));

        filesToCopy.push(...vendoredTiktokenFiles);
    }

    // Process tree-sitter files
    if (wasm) {
        const treeSitterFiles = [
            ...treeSitterGrammars.map(grammar => `${wasm}/${grammar}.wasm`),
            `${wasm}/tree-sitter.wasm`
        ].filter(file => fs.existsSync(path.join(REPO_ROOT, file)));

        filesToCopy.push(...treeSitterFiles);
    }

    if (filesToCopy.length === 0) {
        console.log('No build assets found to copy');
        return;
    }

    await copyStaticAssets(filesToCopy, 'dist');
}
//#endregion

// Custom plugin to handle ?raw imports (inline resources, no minify)
const rawPlugin = {
    name: 'raw-import',
    setup(build) {
        build.onResolve({ filter: /\?raw$/ }, (args) => {
            return {
                path: args.path.replace(/\?raw$/, ''),
                namespace: 'raw-file',
                pluginData: {
                    resolveDir: args.resolveDir
                }
            };
        });
        build.onLoad({ filter: /.*/, namespace: 'raw-file' }, async (args) => {
            const filePath = path.join(args.pluginData.resolveDir, args.path);
            const contents = await fs.promises.readFile(filePath, 'utf8');
            return {
                contents: `export default ${JSON.stringify(contents)};`,
                loader: 'js'
            };
        });
    }
};


// ========================================================================
// Common build options
// ========================================================================
const commonOptions = {
    bundle: true,
    external: ['vscode'],
    format: 'cjs',
    platform: 'node',
    sourcemap: isDev,
    minify: !isDev,
    // Use mainFields to prefer ESM module format
    // This resolves jsonc-parser UMD module relative path issue
    mainFields: ['module', 'main'],
    // Ensure correct module resolution (.ts preferred over .tsx)
    resolveExtensions: ['.ts', '.tsx', '.js', '.mjs', '.json'],
    // Add custom plugins
    plugins: [rawPlugin],
    // Log level
    logLevel: 'info'
};

// ========================================================================
// Main extension build options
// - Does not include heavy @vscode/chat-lib dependencies
// - Uses lightweight InlineCompletionShim for lazy loading
// ========================================================================
/** @type {import('esbuild').BuildOptions} */
const extensionBuildOptions = {
    ...commonOptions,
    entryPoints: ['./src/extension.ts'],
    outfile: 'dist/extension.js',
    // Exclude copilot.bundle module and @vscode/chat-lib to avoid duplicate bundling
    // Note: ui/usagesView/index.ts will be bundled into extension.js (backend logic)
    // Only ui/usagesView/app.ts will be independently compiled to usagesView.js (frontend logic)
    external: [...commonOptions.external, './copilot.bundle', '@vscode/chat-lib']
};

// ========================================================================
// Copilot module build options
// - Includes @vscode/chat-lib and related heavy dependencies
// - Lazy loaded on first completion trigger
// ========================================================================
/** @type {import('esbuild').BuildOptions} */
const copilotBuildOptions = {
    ...commonOptions,
    entryPoints: ['./src/copilot/copilot.bundle.ts'],
    outfile: 'dist/copilot.bundle.js',
    // Only exclude vscode itself, keep @vscode/chat-lib and its dependencies to ensure bundling
    external: ['vscode']
};

// ========================================================================
// UI WebView build options
// ========================================================================
/**
 * Build UI WebView compilation config
 * Scan all folders in ui directory containing app.ts, generate corresponding build options
 * @returns {import('esbuild').BuildOptions[]} Build configuration array
 */
function buildUiConfigs() {
    const uiDir = path.join(REPO_ROOT, 'src/ui');
    const configs = [];

    // Custom plugin to handle CSS inline (process .less files)
    const inlineLessPlugin = {
        name: 'inline-less',
        setup(build) {
            // Process all .less files (auto inline)
            build.onResolve({ filter: /\.less$/ }, (args) => {
                return {
                    path: args.path,
                    namespace: 'inline-less',
                    pluginData: {
                        resolveDir: args.resolveDir
                    }
                };
            });

            // Process .less files
            build.onLoad({ filter: /.*/, namespace: 'inline-less' }, async (args) => {
                const filePath = path.join(args.pluginData.resolveDir, args.path);
                const less = require('less');
                const lessContent = await fs.promises.readFile(filePath, 'utf8');
                const result = await less.render(lessContent, {
                    filename: filePath,
                    paths: [path.dirname(filePath)], // Search paths for @import
                    javascriptEnabled: true,
                    compress: !isDev // Compress CSS in production mode
                });

                // Return a module exporting CSS string and auto inject into page
                return {
                    contents: `
                    const css = ${JSON.stringify(result.css)};
                    if (typeof document !== 'undefined') {
                        const style = document.createElement('style');
                        style.textContent = css;
                        document.head.appendChild(style);
                    }
                    export default {};
                `,
                    loader: 'js'
                };
            });
        }
    };

    // UI build options (browser target)
    const uiBuildOptions = {
        bundle: true,
        format: 'iife',
        platform: 'browser',
        sourcemap: isDev,
        minify: !isDev,
        treeShaking: true,
        resolveExtensions: ['.ts', '.js', '.mjs', '.json'],
        logLevel: 'info',
        plugins: [inlineLessPlugin],
        tsconfig: './tsconfig.ui.json',
        define: {
            'process.env.NODE_ENV': isDev ? '"development"' : '"production"'
        }
    };

    function scan(dir) {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                const appTsPath = path.join(fullPath, 'app.ts');
                if (fs.existsSync(appTsPath)) {
                    const folderName = path.basename(fullPath);
                    configs.push({
                        ...uiBuildOptions,
                        entryPoints: [appTsPath],
                        outfile: `dist/ui/${folderName}.js`
                    });
                }
                // Recursively scan subdirectories
                scan(fullPath);
            }
        }
    }

    scan(uiDir);
    return configs;
}


// ========================================================================
// Build function
// ========================================================================
async function build() {
    try {
        // Base build configuration
        const baseConfigs = [
            extensionBuildOptions,
            copilotBuildOptions
        ];

        // Build UI WebView compilation config
        const uiConfigs = buildUiConfigs();

        if (isWatch) {
            // Watch mode
            console.log('Starting watch mode...');

            const contexts = [];

            // Add base configuration
            for (const config of baseConfigs) {
                const ctx = await esbuild.context(config);
                contexts.push(ctx);
                await ctx.watch();
            }

            // Add UI configuration
            for (const config of uiConfigs) {
                const ctx = await esbuild.context(config);
                contexts.push(ctx);
                await ctx.watch();
                console.log(`Watching: ${config.outfile}`);
            }

            console.log(`Watching for changes in ${contexts.length} bundles...`);
            await Promise.all(contexts.map(ctx => ctx.watch()));
        } else {
            // Clean dist directory before build
            console.log('Cleaning dist directory...');
            if (fs.existsSync('dist')) {
                await fs.promises.rm('dist', { recursive: true, force: true });
                console.log('Dist directory cleaned.');
            } else {
                console.log('No dist directory to clean.');
            }

            // Parallel build all configurations
            console.log(`Building ${baseConfigs.length + uiConfigs.length} bundles...`);
            const startTime = Date.now();

            const allConfigs = [
                esbuild.build(extensionBuildOptions),
                esbuild.build(copilotBuildOptions),
                ...uiConfigs.map(c => esbuild.build(c))
            ];

            await Promise.all(allConfigs);

            const buildTime = Date.now() - startTime;
            console.log(`Build completed successfully in ${buildTime}ms.`);

            // Output build artifact list
            console.log('Built bundles:');
            console.log('  - dist/extension.js');
            console.log('  - dist/copilot.bundle.js');
            uiConfigs.forEach(c => {
                console.log(`  - ${c.outfile}`);
            });

            // Copy resource files after build completion
            await copyBuildAssets();

            console.log('Asset copying completed.');
        }
    } catch (error) {
        console.error('Build failed:', error);
        process.exit(1);
    }
}

build();
