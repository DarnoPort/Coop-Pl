"use strict";

const fs = require("node:fs");
const path = require("node:path");

function parsePluginManifest(manifestPath) {
    const source = fs.readFileSync(manifestPath, "utf8");
    const match = source.match(/^\s*(?:var|let|const)\s+\$plugins\s*=\s*([\s\S]*?)\s*;\s*$/);

    if (!match) {
        throw new Error(
            "Could not parse js/plugins.js. Expected the standard RPG Maker MZ '$plugins = [...];' format."
        );
    }

    let plugins;
    try {
        plugins = JSON.parse(match[1]);
    } catch (error) {
        throw new Error("js/plugins.js contains invalid plugin JSON: " + error.message);
    }

    if (!Array.isArray(plugins)) {
        throw new Error("js/plugins.js must assign an array to $plugins.");
    }

    return plugins;
}

function serializePluginManifest(manifestPath, plugins) {
    fs.writeFileSync(
        manifestPath,
        "var $plugins = " + JSON.stringify(plugins, null, 2) + ";\n",
        "utf8"
    );
}

function copyDirectoryContents(sourceDir, destinationDir) {
    fs.mkdirSync(destinationDir, { recursive: true });
    for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
        fs.cpSync(
            path.join(sourceDir, entry.name),
            path.join(destinationDir, entry.name),
            { recursive: true, force: true, errorOnExist: false }
        );
    }
}

function patchChromiumArgs(packagePath, role) {
    const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
    const oldArgs = typeof packageJson["chromium-args"] === "string"
        ? packageJson["chromium-args"]
        : "";

    // Remove every old profile argument so repeating this operation never creates
    // two conflicting --user-data-dir values. Preserve all unrelated Chromium args.
    const args = oldArgs
        .replace(/(?:^|\s)--user-data-dir(?:=|\s+)(?:"[^"]*"|'[^']*'|\S+)/g, " ")
        .replace(/\s+/g, " ")
        .trim();

    const profileArg = "--user-data-dir='.\\nwjs-profile-" + role.toLowerCase() + "'";
    packageJson["chromium-args"] = [args, profileArg].filter(Boolean).join(" ");
    fs.writeFileSync(packagePath, JSON.stringify(packageJson, null, 2) + "\n", "utf8");
}

function patchPluginManifest(manifestPath, options, role) {
    const plugins = parsePluginManifest(manifestPath);
    let plugin = plugins.find(item => item && item.name === "CoopPl_Core");

    if (!plugin) {
        plugin = {
            name: "CoopPl_Core",
            status: true,
            description: "Coop-Pl multiplayer and shared switches/variables",
            parameters: {}
        };
        plugins.push(plugin);
    }

    const parameters = plugin.parameters && typeof plugin.parameters === "object"
        ? plugin.parameters
        : {};

    plugin.status = true;
    plugin.parameters = {
        ...parameters,
        ServerUrl: options.serverUrl || parameters.ServerUrl || "ws://127.0.0.1:8080",
        RoomCode: options.roomCode || parameters.RoomCode || "TEST",
        PlayerName: role,
        AutoConnect: "true",
        SendIntervalFrames: parameters.SendIntervalFrames || "6",
        ReconnectDelayMs: parameters.ReconnectDelayMs || "3000",
        SyncSwitchesVariables: options.syncSwitchesVariables === false ? "false" : "true"
    };

    serializePluginManifest(manifestPath, plugins);
}

function isWithin(parentPath, childPath) {
    const relative = path.relative(parentPath, childPath);
    return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative));
}

function prepareTestBuilds(options) {
    if (!options || !options.sourcePath || !options.outputRoot) {
        throw new Error("Both sourcePath and outputRoot are required.");
    }

    const sourcePath = path.resolve(options.sourcePath);
    const outputRoot = path.resolve(options.outputRoot);
    const repoRoot = path.resolve(__dirname, "..");
    const pluginSourcePath = path.resolve(options.pluginSourcePath || path.join(repoRoot, "plugin", "CoopPl_Core.js"));

    for (const requiredPath of [
        path.join(sourcePath, "Game.exe"),
        path.join(sourcePath, "package.json"),
        path.join(sourcePath, "js", "plugins.js"),
        pluginSourcePath
    ]) {
        if (!fs.existsSync(requiredPath) || !fs.statSync(requiredPath).isFile()) {
            throw new Error("Required file not found: " + requiredPath);
        }
    }

    if (isWithin(sourcePath, outputRoot)) {
        throw new Error("OutputRoot must not be inside the source export folder.");
    }
    if (sourcePath === outputRoot) {
        throw new Error("SourcePath and OutputRoot must be different folders.");
    }

    const hostPath = path.join(outputRoot, "Host");
    const guestPath = path.join(outputRoot, "Guest");
    if (fs.existsSync(hostPath) || fs.existsSync(guestPath)) {
        throw new Error(
            "Host or Guest output already exists. Choose a fresh OutputRoot or remove only the previous generated test-build folders."
        );
    }

    // Parse before copying so a malformed export cannot leave a half-created pair.
    const sourcePackage = JSON.parse(fs.readFileSync(path.join(sourcePath, "package.json"), "utf8"));
    if (!sourcePackage || typeof sourcePackage !== "object" || Array.isArray(sourcePackage)) {
        throw new Error("package.json must contain a JSON object.");
    }
    parsePluginManifest(path.join(sourcePath, "js", "plugins.js"));

    const resolvedServerUrl = options.serverUrl || null;
    const resolvedRoomCode = options.roomCode || null;

    fs.mkdirSync(outputRoot, { recursive: true });
    for (const [role, targetPath] of [["Host", hostPath], ["Guest", guestPath]]) {
        copyDirectoryContents(sourcePath, targetPath);

        const pluginTargetPath = path.join(targetPath, "js", "plugins", "CoopPl_Core.js");
        fs.mkdirSync(path.dirname(pluginTargetPath), { recursive: true });
        fs.copyFileSync(pluginSourcePath, pluginTargetPath);

        patchPluginManifest(
            path.join(targetPath, "js", "plugins.js"),
            {
                serverUrl: resolvedServerUrl,
                roomCode: resolvedRoomCode,
                syncSwitchesVariables: options.syncSwitchesVariables
            },
            role
        );

        patchChromiumArgs(path.join(targetPath, "package.json"), role);
    }

    return { outputRoot, hostPath, guestPath };
}

function parseCliArguments(argv) {
    const values = {};
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--help" || arg === "-h") {
            values.help = true;
            continue;
        }
        if (!arg.startsWith("--")) {
            throw new Error("Unexpected argument: " + arg);
        }
        const key = arg.slice(2);
        if (!["source", "output", "server-url", "room-code"].includes(key)) {
            throw new Error("Unknown argument: " + arg);
        }
        if (i + 1 >= argv.length || argv[i + 1].startsWith("--")) {
            throw new Error("Missing value for " + arg);
        }
        values[key] = argv[++i];
    }
    return values;
}

function printHelp() {
    console.log([
        "Prepare two RPG Maker MZ test builds from one Windows deployment.",
        "",
        "Usage:",
        "  node tools/prepare-test-builds.js --source <export-folder> --output <new-output-folder>",
        "",
        "Optional:",
        "  --server-url <ws://host:8080>",
        "  --room-code <ROOM>",
        "",
        "The output folder will contain Host/Game.exe and Guest/Game.exe.",
        "Each build gets a unique NW.js profile and PlayerName, plus the current CoopPl_Core.js.",
        "The script refuses to overwrite existing Host/Guest output folders.",
        "Run this only on a test export, not on your original project or production release."
    ].join("\n"));
}

if (require.main === module) {
    try {
        const args = parseCliArguments(process.argv.slice(2));
        if (args.help) {
            printHelp();
        } else {
            const result = prepareTestBuilds({
                sourcePath: args.source,
                outputRoot: args.output,
                serverUrl: args["server-url"],
                roomCode: args["room-code"]
            });
            console.log("[Coop-Pl] Test builds prepared.");
            console.log("Host:  " + path.join(result.hostPath, "Game.exe"));
            console.log("Guest: " + path.join(result.guestPath, "Game.exe"));
            console.log("Each build has its own NW.js profile and PlayerName.");
        }
    } catch (error) {
        console.error("[Coop-Pl] " + error.message);
        process.exitCode = 1;
    }
}

module.exports = {
    parsePluginManifest,
    patchChromiumArgs,
    patchPluginManifest,
    prepareTestBuilds
};
