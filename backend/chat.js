import express from "express";
import dotenv from "dotenv";
import { createClient } from "redis";
import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const router = express.Router();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* =========================================================
   CONFIGURATION
========================================================= */

const GITHUB_API = "https://api.github.com";

const PYTHON_BIN =
    process.env.PYTHON_BIN || "python";

const RAG_COMPONENTS_PATH =
    process.env.RAG_COMPONENTS_PATH ||
    path.join(__dirname, "..", "RAG_Components");

/*
    All repository-related cached data lives for 24 hours.

    24 * 60 * 60 = 86400 seconds
*/
const CACHE_TTL = 86400;


/* =========================================================
   REDIS
========================================================= */

const redis = createClient({
    url: process.env.REDIS_URL
});

redis.on("error", (error) => {
    console.error("Redis error:", error);
});

let redisConnected = false;

async function connectRedis() {
    if (redisConnected) {
        return;
    }

    await redis.connect();
    redisConnected = true;
    console.log("Redis connected");
}


/* =========================================================
   REDIS KEYS
========================================================= */

function getRedisKeys(githubId, repoId) {
    const id = `${githubId}:${repoId}`;

    return {
        repoInfo: `repo_info:${id}`,
        projectSummary: `project_summary:${id}`,
        chatSummary: `chat_summary:${id}`
    };
}


/* =========================================================
   AUTHENTICATION
========================================================= */

function requireAuth(req, res, next) {
    if (!req.isAuthenticated || !req.isAuthenticated()) {
        return res.status(401).json({
            error: "Authentication required"
        });
    }

    if (!req.user || !req.user.githubId || !req.user.accessToken) {
        return res.status(401).json({
            error: "Invalid authentication session"
        });
    }

    next();
}


/* =========================================================
   GITHUB HELPERS
========================================================= */

const GITHUB_HEADERS = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28"
};

async function githubRequest(req, endpoint) {
    const response = await fetch(
        `${GITHUB_API}${endpoint}`,
        {
            method: "GET",
            headers: {
                ...GITHUB_HEADERS,
                Authorization: `Bearer ${req.user.accessToken}`
            }
        }
    );

    if (!response.ok) {
        let body = {};

        try {
            body = await response.json();
        } catch {
            body = {};
        }

        const error = new Error(
            body.message || `GitHub request failed: ${response.status}`
        );

        error.status = response.status;
        throw error;
    }

    return response.json();
}

async function getRepository(req, repoId) {
    if (!/^\d+$/.test(String(repoId))) {
        const error = new Error("Invalid repository ID");
        error.status = 400;
        throw error;
    }

    return githubRequest(req, `/repositories/${repoId}`);
}

async function getRepositoryTree(req, repository) {
    const owner = repository.owner.login;
    const repo = repository.name;
    const branch = repository.default_branch;

    return githubRequest(
        req,
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(branch)}?recursive=1`
    );
}


/* =========================================================
   REPOSITORY STRUCTURE
========================================================= */

function createRepositoryStructure(treeResponse) {
    if (!treeResponse || !Array.isArray(treeResponse.tree)) {
        return "";
    }

    return treeResponse.tree
        .map((item) => {
            const type = item.type === "tree" ? "DIRECTORY" : "FILE";
            return `${type}: ${item.path}`;
        })
        .join("\n");
}


/* =========================================================
   FILE FILTERING
========================================================= */

const SUMMARY_FILE_EXTENSIONS = new Set([
    ".js", ".jsx", ".mjs", ".cjs",
    ".ts", ".tsx",
    ".py",
    ".java", ".kt",
    ".c", ".h", ".cpp", ".hpp", ".cc", ".cxx",
    ".cs",
    ".go",
    ".rs",
    ".php",
    ".rb",
    ".swift",
    ".dart",
    ".html", ".htm", ".css", ".scss", ".sass", ".less",
    ".json", ".yaml", ".yml", ".toml",
    ".sh", ".bash",
    ".sql",
    ".md", ".txt",
    ".xml"
]);

const IGNORED_DIRECTORIES = [
    "node_modules/",
    ".git/",
    "dist/",
    "build/",
    "target/",
    "__pycache__/",
    ".next/",
    "coverage/",
    "vendor/"
];

function shouldIncludeFile(filePath) {
    const lowerPath = filePath.toLowerCase();

    for (const directory of IGNORED_DIRECTORIES) {
        if (lowerPath.includes(directory)) {
            return false;
        }
    }

    const lastDot = lowerPath.lastIndexOf(".");

    if (lastDot === -1) {
        return false;
    }

    const extension = lowerPath.substring(lastDot);

    return SUMMARY_FILE_EXTENSIONS.has(extension);
}


/* =========================================================
   GET FILE CONTENT
========================================================= */

async function getFileContent(req, repository, fileSha) {
    const owner = repository.owner.login;
    const repo = repository.name;

    const blob = await githubRequest(
        req,
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/blobs/${encodeURIComponent(fileSha)}`
    );

    if (blob.encoding === "base64") {
        return Buffer.from(blob.content, "base64").toString("utf-8");
    }

    return blob.content || "";
}


/* =========================================================
   GET ALL REPOSITORY FILES
========================================================= */

async function getRepositoryFiles(req, repository, treeResponse) {
    const files = [];

    const tree = Array.isArray(treeResponse.tree)
        ? treeResponse.tree
        : [];

    const sourceFiles = tree.filter(
        (item) =>
            item.type === "blob" &&
            item.sha &&
            item.path &&
            shouldIncludeFile(item.path)
    );

    console.log(
        `Fetching ${sourceFiles.length} repository files for project summary`
    );

    for (const file of sourceFiles) {
        try {
            const content = await getFileContent(
                req,
                repository,
                file.sha
            );

            if (!content || !content.trim()) {
                continue;
            }

            files.push({
                path: file.path,
                content: content
            });
        } catch (error) {
            console.error(
                `Could not read ${file.path}:`,
                error.message
            );
        }
    }

    return files;
}


/* =========================================================
   REPOSITORY CACHE
========================================================= */

async function getRepositoryInfo(req, repoId, keys) {
    const cachedRepositoryInfo = await redis.get(keys.repoInfo);

    if (cachedRepositoryInfo) {
        try {
            const repositoryInfo = JSON.parse(cachedRepositoryInfo);

            if (
                repositoryInfo &&
                repositoryInfo.repository &&
                repositoryInfo.treeResponse &&
                Array.isArray(repositoryInfo.treeResponse.tree)
            ) {
                console.log(
                    `Repository info loaded from Redis for ${keys.repoInfo}`
                );

                return repositoryInfo;
            }

            console.warn(
                `Invalid repository cache found for ${keys.repoInfo}. Refreshing from GitHub.`
            );
        } catch (error) {
            console.warn(
                `Could not parse repository cache for ${keys.repoInfo}. Refreshing from GitHub:`,
                error.message
            );
        }
    }

    console.log(
        `Repository info not found in Redis. Fetching from GitHub for ${repoId}`
    );

    const repository = await getRepository(req, repoId);

    const treeResponse = await getRepositoryTree(
        req,
        repository
    );

    const repositoryFiles = await getRepositoryFiles(
        req,
        repository,
        treeResponse
    );

    const repositoryInfo = {
        repository,
        treeResponse,
        files: repositoryFiles
    };

    await redis.set(
        keys.repoInfo,
        JSON.stringify(repositoryInfo),
        {
            EX: CACHE_TTL
        }
    );

    console.log(
        `Repository info stored in Redis for 24 hours`
    );

    return repositoryInfo;
}


/* =========================================================
   PYTHON PROCESS
========================================================= */

function callPython(component, data) {
    return new Promise((resolve, reject) => {
        const python = spawn(
            PYTHON_BIN,
            [component],
            {
                cwd: RAG_COMPONENTS_PATH
            }
        );

        let stdout = "";
        let stderr = "";

        python.stdout.on("data", (chunk) => {
            const output = chunk.toString();
            stdout += output;
            console.log(`[${component}] stdout:`, output.trim());
        });

        python.stderr.on("data", (chunk) => {
            const output = chunk.toString();
            stderr += output;
            console.error(`[${component}] stderr:`, output.trim());
        });

        python.on("error", (error) => {
            console.error(
                `[${component}] process error:`,
                error
            );
            reject(error);
        });

        python.on("close", (exitCode) => {
            console.log(
                `[${component}] process exited with code ${exitCode}`
            );

            if (exitCode !== 0) {
                let pythonError = null;

                try {
                    pythonError = JSON.parse(stdout)?.error;
                } catch {
                    // stdout may contain non-JSON output
                }

                return reject(
                    new Error(
                        pythonError ||
                        stderr.trim() ||
                        `${component} exited with code ${exitCode}`
                    )
                );
            }

            try {
                const result = JSON.parse(stdout);
                resolve(result);
            } catch (error) {
                console.error(
                    `[${component}] invalid JSON. Raw stdout:`,
                    stdout
                );

                reject(
                    new Error(
                        `Invalid JSON returned by ${component}: ${stdout}`
                    )
                );
            }
        });

        python.stdin.write(JSON.stringify(data));
        python.stdin.end();
    });
}


/* =========================================================
   PROJECT SUMMARY
========================================================= */

async function generateProjectSummary({
    githubId,
    repoId,
    repositoryStructure,
    files
}) {
    console.log(
        `Generating project summary for ${githubId}:${repoId}`
    );

    const result = await callPython(
        "project_summary.py",
        {
            github_id: githubId,
            repo_id: String(repoId),
            repository_structure: repositoryStructure,
            files: files
        }
    );

    if (
        !result ||
        typeof result.summary !== "string" ||
        !result.summary.trim()
    ) {
        throw new Error(
            "project_summary.py did not return a valid summary"
        );
    }

    return result.summary;
}


/* =========================================================
   CHAT SUMMARY
========================================================= */

async function generateChatSummary({
    githubId,
    repoId,
    repositoryStructure,
    previousSummary,
    query,
    answer
}) {
    console.log(
        `Updating chat summary for ${githubId}:${repoId}`
    );

    const result = await callPython(
        "chat_summary.py",
        {
            github_id: githubId,
            repo_id: String(repoId),
            repository_structure: repositoryStructure,
            previous_chat_summary: previousSummary || "",
            current_query: query,
            current_answer: answer
        }
    );

    if (
        !result ||
        typeof result.summary !== "string" ||
        !result.summary.trim()
    ) {
        throw new Error(
            "chat_summary.py did not return a valid summary"
        );
    }

    return result.summary;
}


/* =========================================================
   RAG
========================================================= */

async function askRAG({
    projectSummary,
    repositoryStructure,
    chatSummary,
    query,
    githubId,
    repoId,
    fileName
}) {
    const result = await callPython(
        "rag_index.py",
        {
            action: "ask_question",
            project_context: projectSummary,
            repository_structure: repositoryStructure,
            summarized_chat_history: chatSummary || "",
            query: query,
            github_id: githubId,
            repo_id: String(repoId),
            file_name: fileName
        }
    );

    let answer = result?.answer;

    if (Array.isArray(answer)) {
        answer = answer
            .filter(
                (item) =>
                    item &&
                    item.type === "text" &&
                    typeof item.text === "string"
            )
            .map((item) => item.text)
            .join("\n\n");
    }

    if (
        typeof answer !== "string" ||
        !answer.trim()
    ) {
        throw new Error(
            "rag_index.py did not return a valid answer"
        );
    }

    return answer;
}


/* =========================================================
   POST /api/rag/chat
========================================================= */

router.post(
    "/chat",
    requireAuth,
    async (req, res) => {
        try {
            const {
                repoId,
                fileName,
                query
            } = req.body;

            if (!repoId) {
                return res.status(400).json({
                    error: "repoId is required"
                });
            }

            if (!fileName || typeof fileName !== "string") {
                return res.status(400).json({
                    error: "fileName is required"
                });
            }

            if (
                !query ||
                typeof query !== "string" ||
                !query.trim()
            ) {
                return res.status(400).json({
                    error: "query is required"
                });
            }

            await connectRedis();

            const githubId = String(req.user.githubId);
            const keys = getRedisKeys(githubId, repoId);

            /*
                Repository information is the first cache layer.

                CACHE HIT:
                    Use repository + tree + files directly from Redis.

                CACHE MISS:
                    Fetch everything required from GitHub once, then cache
                    the complete repository information for 24 hours.
            */
            const repositoryInfo = await getRepositoryInfo(
                req,
                repoId,
                keys
            );

            const repository = repositoryInfo.repository;
            const treeResponse = repositoryInfo.treeResponse;
            const repositoryFiles = Array.isArray(repositoryInfo.files)
                ? repositoryInfo.files
                : [];

            const repositoryStructure = createRepositoryStructure(
                treeResponse
            );

            let projectSummary = await redis.get(
                keys.projectSummary
            );

            if (!projectSummary) {
                console.log(
                    `No valid project summary found for ${githubId}:${repoId}`
                );

                projectSummary = await generateProjectSummary({
                    githubId,
                    repoId,
                    repositoryStructure,
                    files: repositoryFiles
                });

                await redis.set(
                    keys.projectSummary,
                    projectSummary,
                    {
                        EX: CACHE_TTL
                    }
                );

                console.log(
                    `Project summary stored for 24 hours`
                );
            }

            const chatSummary = await redis.get(
                keys.chatSummary
            );

            const ragQuery = `
Selected file:
${fileName}

User question:
${query.trim()}
`;

            const answer = await askRAG({
                projectSummary,
                repositoryStructure,
                chatSummary: chatSummary || "",
                query: ragQuery,
                githubId,
                repoId,
                fileName
            });

            const updatedChatSummary =
                await generateChatSummary({
                    githubId,
                    repoId,
                    repositoryStructure,
                    previousSummary: chatSummary || "",
                    query: query.trim(),
                    answer: answer
                });

            await redis.set(
                keys.chatSummary,
                updatedChatSummary,
                {
                    EX: CACHE_TTL
                }
            );

            return res.json({
                answer
            });

        } catch (error) {
            console.error(
                "Chat request failed:",
                error
            );

            if (error.status === 400) {
                return res.status(400).json({
                    error: error.message
                });
            }

            if (error.status === 401) {
                return res.status(401).json({
                    error: "GitHub authentication expired"
                });
            }

            if (error.status === 403) {
                return res.status(403).json({
                    error: "GitHub repository access denied"
                });
            }

            if (error.status === 404) {
                return res.status(404).json({
                    error: "Repository not found"
                });
            }

            return res.status(500).json({
                error: "Failed to process chat request"
            });
        }
    }
);


/* =========================================================
   EXPORT
========================================================= */

export default router;
