/**
 * Pizza Coding Agent 统一 Bash 工具
 * 
 * 只暴露一个 bash tool，内置 read/edit/write 通过命令路由调用原生实现
 * 
 * 使用方式:
 *   bash "read src/main.py 1 50"     // 读取文件（offset=1, limit=50）
 *   bash "read src/main.py 51"       // 继续读取（offset=51）
 *   bash "edit src/main.py --old 'old' --new 'new'"   // 编辑
 *   bash "edit src/main.py --edits '[{\"oldText\":\"...\",\"newText\":\"...\"}]'"
 *   bash "write src/new.py --content 'hello world'"   // 写入
 *   bash "ls -la"                     // 原生 bash
 */

import { randomBytes } from "node:crypto";
import { createWriteStream, existsSync, constants } from "node:fs";
import { access as fsAccess, mkdir as fsMkdir, readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { spawn } from "child_process";
import { Type } from "typebox";
import { truncateTail } from "./truncate.js";
import { detectLineEnding, generateDiffString, normalizeToLF, restoreLineEndings, stripBom } from "./edit-diff.js";
import { withFileMutationQueue } from "./file-mutation-queue.js";
import { getShellConfig, getShellEnv, killProcessTree, trackDetachedChildPid, untrackDetachedChildPid } from "../../utils/shell.js";
import { waitForChildProcess } from "../../utils/child-process.js";

const DEFAULT_MAX_BYTES = 50 * 1024; // 50KB
const DEFAULT_MAX_LINES = 2000;

// ============================================================================
// 内置命令路由
// ============================================================================

type BuiltinCommand = "read" | "edit" | "write";

const BUILTIN_COMMANDS: Set<string> = new Set(["read", "edit", "write"]);

function parseCommand(command: string): { builtin: BuiltinCommand | null; args: string[] } {
    const trimmed = command.trim();
    const parts = trimmed.split(/\s+/);
    const first = parts[0]?.toLowerCase();
    
    if (BUILTIN_COMMANDS.has(first)) {
        return { builtin: first as BuiltinCommand, args: parts.slice(1) };
    }
    
    return { builtin: null, args: parts };
}

// ============================================================================
// 路径解析
// ============================================================================

function resolveToCwd(filePath: string, cwd: string): string {
    if (filePath.startsWith("~/")) {
        return join(process.env.HOME || tmpdir(), filePath.slice(1));
    }
    if (filePath.startsWith("@")) {
        filePath = filePath.slice(1);
    }
    if (filePath.startsWith("/")) {
        return filePath;
    }
    return resolvePath(cwd, filePath);
}

// ============================================================================
// 内置 read
// ============================================================================

async function builtinRead(args: string[], cwd: string) {
    let path: string | undefined;
    let offset: number | undefined;
    let limit: number | undefined;
    
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "-o" || arg === "--offset") {
            offset = parseInt(args[++i], 10);
        } else if (arg === "-l" || arg === "--limit") {
            limit = parseInt(args[++i], 10);
        } else if (!path) {
            path = arg;
        } else if (offset === undefined) {
            offset = parseInt(arg, 10);
        } else if (limit === undefined) {
            limit = parseInt(arg, 10);
        }
    }
    
    if (!path) throw new Error("read: missing file path");
    
    const absolutePath = resolveToCwd(path, cwd);
    await fsAccess(absolutePath, constants.R_OK);
    
    const buffer = await fsReadFile(absolutePath);
    const textContent = buffer.toString("utf-8");
    const allLines = textContent.split("\n");
    const totalFileLines = allLines.length;
    
    const startLine = offset ? Math.max(0, offset - 1) : 0;
    if (startLine >= allLines.length) {
        throw new Error(`Offset ${offset} is beyond end of file (${allLines.length} lines)`);
    }
    
    let selectedContent: string;
    let userLimitedLines: number | undefined;
    
    if (limit !== undefined) {
        const endLine = Math.min(startLine + limit, allLines.length);
        selectedContent = allLines.slice(startLine, endLine).join("\n");
        userLimitedLines = endLine - startLine;
    } else {
        selectedContent = allLines.slice(startLine).join("\n");
    }
    
    // 简单的 head 截断
    const lines = selectedContent.split("\n");
    let outputLines = lines;
    let truncated = false;
    let truncation: any;
    
    if (lines.length > DEFAULT_MAX_LINES) {
        outputLines = lines.slice(0, DEFAULT_MAX_LINES);
        truncated = true;
    }
    
    const totalBytes = Buffer.byteLength(outputLines.join("\n"), "utf-8");
    if (totalBytes > DEFAULT_MAX_BYTES) {
        // 按字节截断
        let bytes = 0;
        const result: string[] = [];
        for (const line of outputLines) {
            const lineBytes = Buffer.byteLength(line, "utf-8") + 1;
            if (bytes + lineBytes > DEFAULT_MAX_BYTES) break;
            result.push(line);
            bytes += lineBytes;
        }
        outputLines = result;
        truncated = true;
    }
    
    const startLineDisplay = startLine + 1;
    let outputText = outputLines.join("\n");
    
    if (truncated) {
        const endLineDisplay = startLineDisplay + outputLines.length - 1;
        const nextOffset = startLineDisplay + outputLines.length;
        outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use read ${path} ${nextOffset} to continue.]`;
    } else if (userLimitedLines !== undefined && startLine + userLimitedLines < allLines.length) {
        const remaining = allLines.length - (startLine + userLimitedLines);
        const nextOffset = startLine + userLimitedLines + 1;
        outputText += `\n\n[${remaining} more lines. Use read ${path} ${nextOffset} to continue.]`;
    }
    
    return { content: [{ type: "text", text: outputText }] };
}

// ============================================================================
// 内置 write
// ============================================================================

async function builtinWrite(args: string[], cwd: string) {
    let path: string | undefined;
    let content: string | undefined;
    
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "-p" || arg === "--path") {
            path = args[++i];
        } else if (arg === "-c" || arg === "--content") {
            content = args[++i];
        } else if (!path) {
            path = arg;
        } else if (!content) {
            content = arg;
        }
    }
    
    if (!path) throw new Error("write: missing file path");
    if (content === undefined) throw new Error("write: missing content");
    
    const absolutePath = resolveToCwd(path, cwd);
    const dir = dirname(absolutePath);
    
    await fsMkdir(dir, { recursive: true });
    await fsWriteFile(absolutePath, content, "utf-8");
    
    return { content: [{ type: "text", text: `Successfully wrote ${content.length} bytes to ${path}` }] };
}

// ============================================================================
// 内置 edit
// ============================================================================

interface EditArg {
    oldText: string;
    newText: string;
}

async function builtinEdit(args: string[], cwd: string) {
    let path: string | undefined;
    let edits: EditArg[] = [];
    let legacyOld: string | undefined;
    let legacyNew: string | undefined;
    
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "-p" || arg === "--path") {
            path = args[++i];
        } else if (arg === "-e" || arg === "--edits") {
            try {
                edits = JSON.parse(args[++i]);
            } catch {
                throw new Error(`edit: invalid JSON in --edits`);
            }
        } else if (arg === "-o" || arg === "--old") {
            legacyOld = args[++i];
        } else if (arg === "-n" || arg === "--new") {
            legacyNew = args[++i];
        } else if (!path) {
            path = arg;
        }
    }
    
    if (legacyOld && legacyNew) {
        edits = [{ oldText: legacyOld, newText: legacyNew }];
    }
    
    if (!path) throw new Error("edit: missing file path");
    if (edits.length === 0) throw new Error("edit: missing --edits or --old/--new");
    
    const absolutePath = resolveToCwd(path, cwd);
    
    return withFileMutationQueue(absolutePath, async () => {
        await fsAccess(absolutePath, constants.R_OK);
        
        const buffer = await fsReadFile(absolutePath);
        const rawContent = buffer.toString("utf-8");
        const { bom, text: content } = stripBom(rawContent);
        const originalEnding = detectLineEnding(content);
        const normalizedContent = normalizeToLF(content);
        
        let newContent = normalizedContent;
        
        for (const edit of edits) {
            const normOld = normalizeToLF(edit.oldText);
            const normNew = normalizeToLF(edit.newText);
            
            const index = newContent.indexOf(normOld);
            if (index === -1) {
                throw new Error(`edit: could not find: ${JSON.stringify(edit.oldText.slice(0, 30))}...`);
            }
            
            const nextIndex = newContent.indexOf(normOld, index + 1);
            if (nextIndex !== -1) {
                throw new Error(`edit: text appears multiple times: ${JSON.stringify(edit.oldText.slice(0, 30))}...`);
            }
            
            newContent = newContent.slice(0, index) + normNew + newContent.slice(index + normOld.length);
        }
        
        if (newContent === normalizedContent) {
            throw new Error("edit: no changes made");
        }
        
        const finalContent = bom + restoreLineEndings(newContent, originalEnding);
        await fsWriteFile(absolutePath, finalContent);
        
        const diff = generateDiffString(normalizedContent, newContent);
        
        return {
            content: [{ type: "text", text: `Successfully replaced ${edits.length} block(s) in ${path}.` }],
            details: { diff: diff.diff },
        };
    });
}

// ============================================================================
// Bash 工具主体
// ============================================================================

function getTempFilePath(): string {
    const id = randomBytes(8).toString("hex");
    return join(tmpdir(), `pi-bash-${id}.log`);
}

export const unifiedBashSchema = Type.Object({
    command: Type.String({ 
        description: `Command to execute. Built-in: read <path> [offset] [limit], edit <path> --old <old> --new <new>, write <path> --content <content>. Others execute as bash.`
    }),
    timeout: Type.Optional(Type.Number()),
});

export function createUnifiedBashToolDefinition(cwd: string, options?: { shellPath?: string }) {
    const shellPath = options?.shellPath;
    
    return {
        name: "bash",
        label: "bash",
        description: `Execute commands. Built-in: read <path> [offset] [limit] - read file, edit <path> --old <old> --new <new> - edit file, write <path> --content <content> - write file. Other commands run as native bash.`,
        promptSnippet: "Execute bash commands and file operations (read, edit, write)",
        parameters: unifiedBashSchema,
        
        async execute(
            _toolCallId: string,
            { command, timeout }: { command: string; timeout?: number },
            signal: AbortSignal | undefined,
            onUpdate: any
        ) {
            const { builtin, args } = parseCommand(command);
            
            // 内置命令
            if (builtin === "read") {
                const result = await builtinRead(args, cwd);
                if (onUpdate) onUpdate(result);
                return result;
            }
            
            if (builtin === "write") {
                const result = await builtinWrite(args, cwd);
                if (onUpdate) onUpdate(result);
                return result;
            }
            
            if (builtin === "edit") {
                try {
                    const result = await builtinEdit(args, cwd);
                    if (onUpdate) onUpdate(result);
                    return result;
                } catch (err) {
                    throw err instanceof Error ? err : new Error(String(err));
                }
            }
            
            // 原生 bash
            return new Promise((resolve, reject) => {
                const { shell, args: shellArgs } = getShellConfig(shellPath);
                
                if (!existsSync(cwd)) {
                    reject(new Error(`Directory not found: ${cwd}`));
                    return;
                }
                
                const child = spawn(shell, [...shellArgs, command], {
                    cwd,
                    detached: true,
                    env: getShellEnv(),
                    stdio: ["ignore", "pipe", "pipe"],
                });
                
                if (child.pid) trackDetachedChildPid(child.pid);
                
                let timedOut = false;
                let timeoutHandle: NodeJS.Timeout | undefined;
                
                if (timeout && timeout > 0) {
                    timeoutHandle = setTimeout(() => {
                        timedOut = true;
                        if (child.pid) killProcessTree(child.pid);
                    }, timeout * 1000);
                }
                
                const chunks: Buffer[] = [];
                
                const handleData = (data: Buffer) => {
                    chunks.push(data);
                    if (onUpdate) {
                        const text = truncateTail(Buffer.concat(chunks).toString("utf-8")).content || "";
                        onUpdate({ content: [{ type: "text", text }] });
                    }
                };
                
                const onAbort = () => { if (child.pid) killProcessTree(child.pid); };
                if (signal) {
                    if (signal.aborted) onAbort();
                    else signal.addEventListener("abort", onAbort, { once: true });
                }
                
                child.stdout?.on("data", handleData);
                child.stderr?.on("data", handleData);
                
                waitForChildProcess(child)
                    .then((code) => {
                        if (child.pid) untrackDetachedChildPid(child.pid);
                        if (timeoutHandle) clearTimeout(timeoutHandle);
                        if (signal) signal.removeEventListener("abort", onAbort);
                        
                        const output = truncateTail(Buffer.concat(chunks).toString("utf-8"));
                        let text = output.content || "(no output)";
                        
                        if (code !== 0 && code !== null) {
                            text += `\n\nCommand exited with code ${code}`;
                            reject(new Error(text));
                        } else {
                            resolve({ content: [{ type: "text", text }] });
                        }
                    })
                    .catch((err) => {
                        if (child.pid) untrackDetachedChildPid(child.pid);
                        if (timeoutHandle) clearTimeout(timeoutHandle);
                        if (signal) signal.removeEventListener("abort", onAbort);
                        reject(err);
                    });
            });
        },
    };
}

export function createUnifiedBashTool(cwd: string, options?: { shellPath?: string }) {
    return createUnifiedBashToolDefinition(cwd, options);
}
