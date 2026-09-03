import express from "express";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";

dotenv.config();

const router = express.Router();

/* =========================================================
   PATHS
========================================================= */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const RAG_COMPONENTS_PATH = path.join(
    __dirname,
    "..",
    "RAG_Components"
);

const PYTHON_BIN = process.env.PYTHON_BIN || "python";

/* =========================================================
   GITHUB CONFIG
========================================================= */

const GITHUB_API = "https://api.github.com";

const GITHUB_HEADERS = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
};

/* =========================================================
   AUTH MIDDLEWARE
========================================================= */

function requireAuth(req, res, next) {

    if (!req.isAuthenticated || !req.isAuthenticated()) {
        return res.status(401).json({
            error: "Authentication required"
        });
    }

    if (!req.user || !req.user.accessToken) {
        return res.status(401).json({
            error: "GitHub authentication token not available"
        });
    }

    next();
}

/* =========================================================
   GITHUB REQUEST HELPER
========================================================= */

async function githubRequest(req, endpoint) {

    const response = await fetch(
        `${GITHUB_API}${endpoint}`,
        {
            method: "GET",

            headers: {
                ...GITHUB_HEADERS,
                Authorization: `Bearer ${req.user.accessToken}`,
            },
        }
    );

    if (!response.ok) {

        let errorBody = {};

        try {
            errorBody = await response.json();
        } catch {
            errorBody = {};
        }

        const error = new Error(
            errorBody.message ||
            `GitHub API request failed with ${response.status}`
        );

        error.status = response.status;

        throw error;
    }

    return response.json();
}

/* =========================================================
   ERROR HANDLER FOR GITHUB
========================================================= */

function handleGithubError(error, res) {

    if (error.status === 401) {
        return res.status(401).json({
            error: "GitHub authentication expired"
        });
    }

    if (error.status === 403) {
        return res.status(403).json({
            error: "GitHub API access denied"
        });
    }

    if (error.status === 404) {
        return res.status(404).json({
            error: "Repository or resource not found"
        });
    }

    console.error("GitHub API error:", error);

    return res.status(500).json({
        error: "GitHub API request failed"
    });
}

/* =========================================================
   RESOLVE REPOSITORY
========================================================= */

/*
    repoId comes from frontend.

    We use:

        GET /repositories/:id

    GitHub will only return the repository if the authenticated
    token has access to it.

    This prevents a user from simply passing another repository
    ID and accessing it through our backend.
*/

async function resolveRepository(req, repoId) {

    if (!/^\d+$/.test(String(repoId))) {

        const error = new Error(
            "Invalid repository ID"
        );

        error.status = 400;

        throw error;
    }

    const repository = await githubRequest(
        req,
        `/repositories/${repoId}`
    );

    return repository;
}

/* =========================================================
   GET REPOSITORIES
========================================================= */

/*
    GET /api/repositories

    Returns repositories accessible to authenticated user.
*/

router.get(
    "/repositories",
    requireAuth,
    async (req, res) => {

        try {

            const repositories = [];

            let page = 1;

            while (true) {

                const repos = await githubRequest(
                    req,
                    `/user/repos?per_page=100&page=${page}&sort=updated`
                );

                if (!Array.isArray(repos) || repos.length === 0) {
                    break;
                }

                repositories.push(...repos);

                if (repos.length < 100) {
                    break;
                }

                page++;
            }

            const result = repositories.map(repo => ({
                id: repo.id,
                name: repo.name,

                // Additional fields are allowed by the API contract.
                fullName: repo.full_name,
                private: repo.private,
                defaultBranch: repo.default_branch,
            }));

            return res.json(result);

        } catch (error) {

            return handleGithubError(
                error,
                res
            );
        }
    }
);

/* =========================================================
   GET REPOSITORY TREE
========================================================= */

/*
    GET /api/repositories/:repoId/tree

    Flow:

        frontend
            ↓
        repoId
            ↓
        resolve GitHub repository
            ↓
        get recursive GitHub tree
            ↓
        check Pinecone
            ↓
        if not indexed
            ↓
        embed repository
            ↓
        return tree
*/

router.get(
    "/repositories/:repoId/tree",
    requireAuth,
    async (req, res) => {

        try {

            const { repoId } = req.params;

            const repository =
                await resolveRepository(
                    req,
                    repoId
                );

            const owner = repository.owner.login;
            const repo = repository.name;

            const branch =
                repository.default_branch;

            /*
                First get the GitHub tree.
            */

            const treeResponse =
                await githubRequest(
                    req,
                    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(branch)}?recursive=1`
                );

            /*
                Check whether this repository already
                has vectors in Pinecone.
            */

            const indexed =
                await isRepositoryIndexed(
                    req.user.githubId,
                    repoId
                );

            /*
                If repository isn't indexed,
                index it now.
            */

            if (!indexed) {

                console.log(
                    `Repository ${repoId} is not indexed. Starting indexing...`
                );

                await indexRepository({
                    req,
                    repository,
                    tree: treeResponse.tree,
                });

                console.log(
                    `Repository ${repoId} indexing completed.`
                );
            } else {

                console.log(
                    `Repository ${repoId} already indexed.`
                );
            }

            /*
                Return the original GitHub tree
                to frontend.
            */

            return res.json(treeResponse);

        } catch (error) {

            console.error(
                "Repository tree error:",
                error
            );

            if (
                error.message ===
                "Invalid repository ID"
            ) {
                return res.status(400).json({
                    error: error.message
                });
            }

            return handleGithubError(
                error,
                res
            );
        }
    }
);

/* =========================================================
   GET FILE CONTENT
========================================================= */

/*
    GET /api/repositories/:repoId/file?path=backend/auth.js

    Frontend only sends:

        repoId
        path

    GitHub token stays on backend.
*/

router.get(
    "/repositories/:repoId/file",
    requireAuth,
    async (req, res) => {

        try {

            const { repoId } = req.params;
            const { path: filePath } = req.query;

            if (!filePath) {

                return res.status(400).json({
                    error: "File path is required"
                });
            }

            const repository =
                await resolveRepository(
                    req,
                    repoId
                );

            const owner = repository.owner.login;
            const repo = repository.name;

            /*
                GitHub Contents API
            */

            const file = await githubRequest(
                req,
                `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodePath(filePath)}?ref=${encodeURIComponent(repository.default_branch)}`
            );

            /*
                Directories should not be returned as file content.
            */

            if (Array.isArray(file)) {

                return res.status(400).json({
                    error: "Requested path is a directory"
                });
            }

            /*
                GitHub normally returns base64 content.
            */

            if (
                file.encoding === "base64" &&
                file.content
            ) {

                const content =
                    Buffer.from(
                        file.content.replace(/\n/g, ""),
                        "base64"
                    ).toString("utf-8");

                return res.json({
                    path: file.path,
                    content,
                    encoding: "utf-8"
                });
            }

            /*
                Fallback.
            */

            return res.json({
                path: file.path,
                content: file.content || "",
                encoding: file.encoding || "utf-8"
            });

        } catch (error) {

            console.error(
                "File content error:",
                error
            );

            if (
                error.message ===
                "Invalid repository ID"
            ) {
                return res.status(400).json({
                    error: error.message
                });
            }

            return handleGithubError(
                error,
                res
            );
        }
    }
);

/* =========================================================
   ENCODE GITHUB FILE PATH
========================================================= */

function encodePath(filePath) {

    return filePath
        .split("/")
        .map(part => encodeURIComponent(part))
        .join("/");
}

/* =========================================================
   PYTHON RUNNER
========================================================= */

/*
    Node.js
        ↓
    Python
        ↓
    RAG_Components/rag_index.py

    JSON is sent through stdin.
*/

function runPython(code, input) {

    return new Promise(
        (resolve, reject) => {

            const python =
                spawn(
                    PYTHON_BIN,
                    ["-c", code],
                    {
                        cwd: RAG_COMPONENTS_PATH,
                    }
                );

            let stdout = "";
            let stderr = "";

            python.stdout.on(
                "data",
                data => {
                    stdout += data.toString();
                }
            );

            python.stderr.on(
                "data",
                data => {
                    stderr += data.toString();
                }
            );

            python.on(
                "error",
                error => {
                    reject(error);
                }
            );

            python.on(
                "close",
                exitCode => {

                    if (exitCode !== 0) {

                        return reject(
                            new Error(
                                stderr ||
                                `Python process exited with code ${exitCode}`
                            )
                        );
                    }

                    try {

                        const result =
                            JSON.parse(stdout);

                        resolve(result);

                    } catch (error) {

                        reject(
                            new Error(
                                `Invalid Python JSON output: ${stdout}`
                            )
                        );
                    }
                }
            );

            python.stdin.write(
                JSON.stringify(input)
            );

            python.stdin.end();
        }
    );
}

/* =========================================================
   CHECK PINECONE INDEX
========================================================= */

/*
    Namespace format:

        githubId_repoId

    Example:

        123456_987654
*/

async function isRepositoryIndexed(
    githubId,
    repoId
) {

    const namespace =
        `${githubId}_${repoId}`;

    const pythonCode = `
import json
from pinecone_db import index

try:
    stats = index.describe_index_stats()

    namespaces = stats.get("namespaces", {})
    namespace_stats = namespaces.get("${namespace}", {})

    vector_count = namespace_stats.get(
        "vector_count",
        0
    )

    print(json.dumps({
        "indexed": vector_count > 0,
        "vector_count": vector_count
    }))

except Exception as e:

    print(json.dumps({
        "indexed": False,
        "vector_count": 0,
        "error": str(e)
    }))
`;

    const result =
        await runPython(
            pythonCode,
            {}
        );

    if (result.error) {

        console.error(
            "Pinecone check error:",
            result.error
        );

        throw new Error(
            "Unable to check repository embedding status"
        );
    }

    return result.indexed === true;
}

/* =========================================================
   EMBEDDABLE FILE TYPES
========================================================= */

const EMBEDDABLE_EXTENSIONS = new Set([

    // JavaScript
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",

    // TypeScript
    ".ts",
    ".tsx",

    // Python
    ".py",

    // Java
    ".java",

    // C / C++
    ".c",
    ".h",
    ".cpp",
    ".hpp",
    ".cc",
    ".cxx",

    // C#
    ".cs",

    // Go
    ".go",

    // Rust
    ".rs",

    // PHP
    ".php",

    // Ruby
    ".rb",

    // Kotlin
    ".kt",

    // Swift
    ".swift",

    // Dart
    ".dart",

    // HTML / CSS
    ".html",
    ".htm",
    ".css",
    ".scss",
    ".sass",
    ".less",

    // JSON / YAML / config
    ".json",
    ".yaml",
    ".yml",
    ".toml",

    // Shell
    ".sh",
    ".bash",

    // SQL
    ".sql",

    // Markdown / text
    ".md",
    ".txt",

    // XML
    ".xml"
]);

/* =========================================================
   SHOULD EMBED FILE
========================================================= */

function shouldEmbedFile(filePath) {

    const lowerPath =
        filePath.toLowerCase();

    /*
        Ignore common generated/dependency directories.
    */

    const ignoredDirectories = [
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

    for (
        const directory
        of ignoredDirectories
    ) {

        if (
            lowerPath.includes(directory)
        ) {
            return false;
        }
    }

    const extension =
        path.extname(lowerPath);

    return EMBEDDABLE_EXTENSIONS.has(
        extension
    );
}

/* =========================================================
   GET GITHUB BLOB CONTENT
========================================================= */

async function getBlobContent(
    req,
    owner,
    repo,
    sha
) {

    const blob =
        await githubRequest(
            req,
            `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/blobs/${encodeURIComponent(sha)}`
        );

    if (
        blob.encoding !== "base64"
    ) {

        return blob.content || "";
    }

    return Buffer.from(
        blob.content,
        "base64"
    ).toString("utf-8");
}

/* =========================================================
   INGEST ONE FILE
========================================================= */

async function ingestFile({
    code,
    githubId,
    repoId,
    filePath
}) {

    const pythonCode = `
import json
import sys

from rag_index import ingest_file

data = json.loads(
    sys.stdin.read()
)

ingest_file(
    code=data["code"],
    github_id=data["githubId"],
    repo_id=data["repoId"],
    file_path=data["filePath"]
)

print(json.dumps({
    "success": True
}))
`;

    return runPython(
        pythonCode,
        {
            code,
            githubId,
            repoId: String(repoId),
            filePath
        }
    );
}

/* =========================================================
   INDEX ENTIRE REPOSITORY
========================================================= */

async function indexRepository({
    req,
    repository,
    tree
}) {

    const githubId =
        String(req.user.githubId);

    const repoId =
        String(repository.id);

    const owner =
        repository.owner.login;

    const repo =
        repository.name;

    /*
        Only GitHub blobs are files.
    */

    const files =
        tree.filter(
            item =>
                item.type === "blob" &&
                item.sha &&
                item.path &&
                shouldEmbedFile(item.path)
        );

    console.log(
        `Found ${files.length} embeddable files in ${repository.full_name}`
    );

    let processed = 0;

    for (
        const file
        of files
    ) {

        try {

            console.log(
                `Embedding ${file.path}`
            );

            const code =
                await getBlobContent(
                    req,
                    owner,
                    repo,
                    file.sha
                );

            /*
                Skip obviously empty files.
            */

            if (!code || !code.trim()) {
                continue;
            }

            await ingestFile({
                code,
                githubId,
                repoId,
                filePath: file.path
            });

            processed++;

        } catch (error) {

            /*
                Don't allow one problematic/binary
                file to destroy the entire indexing process.
            */

            console.error(
                `Failed to embed ${file.path}:`,
                error.message
            );
        }
    }

    console.log(
        `Indexed ${processed}/${files.length} files for ${repository.full_name}`
    );

    return {
        filesFound: files.length,
        filesProcessed: processed
    };
}

/* =========================================================
   EXPORT ROUTER
========================================================= */

export default router;
