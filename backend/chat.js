import express from "express";
import dotenv from "dotenv";
import { createClient } from "redis";
import { spawn } from "child_process";

dotenv.config();

const router = express.Router();

/* =========================================================
   CONFIGURATION
========================================================= */

const GITHUB_API = "https://api.github.com";

const PYTHON_BIN =
    process.env.PYTHON_BIN || "python";

const RAG_COMPONENTS_PATH =
    process.env.RAG_COMPONENTS_PATH ||
    "../RAG_Components";

/*
    Project summary lives for 24 hours.

    24 * 60 * 60 = 86400 seconds
*/
const PROJECT_SUMMARY_TTL = 86400;


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

    const id =
        `${githubId}:${repoId}`;

    return {
        projectSummary:
            `project_summary:${id}`,

        chatSummary:
            `chat_summary:${id}`
    };
}


/* =========================================================
   AUTHENTICATION
========================================================= */

function requireAuth(req, res, next) {

    if (
        !req.isAuthenticated ||
        !req.isAuthenticated()
    ) {
        return res.status(401).json({
            error: "Authentication required"
        });
    }

    if (
        !req.user ||
        !req.user.githubId ||
        !req.user.accessToken
    ) {
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
    Accept:
        "application/vnd.github+json",

    "X-GitHub-Api-Version":
        "2022-11-28"
};


/*
    Make an authenticated GitHub API request.
*/
async function githubRequest(
    req,
    endpoint
) {

    const response = await fetch(
        `${GITHUB_API}${endpoint}`,
        {
            method: "GET",

            headers: {
                ...GITHUB_HEADERS,

                Authorization:
                    `Bearer ${req.user.accessToken}`
            }
        }
    );


    if (!response.ok) {

        let body = {};

        try {
            body =
                await response.json();
        } catch {
            body = {};
        }


        const error = new Error(
            body.message ||
            `GitHub request failed: ${response.status}`
        );

        error.status =
            response.status;

        throw error;
    }


    return response.json();
}


/*
    Resolve repoId to the actual GitHub repository.

    GitHub performs the access check using the
    authenticated user's token.
*/
async function getRepository(
    req,
    repoId
) {

    if (
        !/^\d+$/.test(
            String(repoId)
        )
    ) {

        const error = new Error(
            "Invalid repository ID"
        );

        error.status = 400;

        throw error;
    }


    return githubRequest(
        req,
        `/repositories/${repoId}`
    );
}


/*
    Get the complete recursive repository tree.
*/
async function getRepositoryTree(
    req,
    repository
) {

    const owner =
        repository.owner.login;

    const repo =
        repository.name;

    const branch =
        repository.default_branch;


    return githubRequest(
        req,
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(branch)}?recursive=1`
    );
}


/* =========================================================
   REPOSITORY STRUCTURE
========================================================= */

/*
    Convert GitHub's tree response into a
    simple text representation.

    Example:

    DIRECTORY: backend
    FILE: backend/index.js
    FILE: backend/auth.js
    DIRECTORY: RAG_Components
    FILE: RAG_Components/rag_index.py
*/
function createRepositoryStructure(
    treeResponse
) {

    if (
        !treeResponse ||
        !Array.isArray(
            treeResponse.tree
        )
    ) {
        return "";
    }


    return treeResponse.tree
        .map((item) => {

            const type =
                item.type === "tree"
                    ? "DIRECTORY"
                    : "FILE";

            return `${type}: ${item.path}`;

        })
        .join("\n");
}


/* =========================================================
   FILE FILTERING
========================================================= */

/*
    These are the file types we want to
    send to project_summary.py.

    We don't want to send things such as:

        node_modules
        .git
        build
        dist
        etc.
*/
const SUMMARY_FILE_EXTENSIONS =
    new Set([

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

        // Java / JVM
        ".java",
        ".kt",

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

        // Swift
        ".swift",

        // Dart
        ".dart",

        // Web
        ".html",
        ".htm",
        ".css",
        ".scss",
        ".sass",
        ".less",

        // Data / config
        ".json",
        ".yaml",
        ".yml",
        ".toml",

        // Shell
        ".sh",
        ".bash",

        // SQL
        ".sql",

        // Documentation
        ".md",
        ".txt",

        // XML
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


function shouldIncludeFile(
    filePath
) {

    const lowerPath =
        filePath.toLowerCase();


    /*
        Ignore generated/dependency directories.
    */
    for (
        const directory
        of IGNORED_DIRECTORIES
    ) {

        if (
            lowerPath.includes(directory)
        ) {
            return false;
        }
    }


    const lastDot =
        lowerPath.lastIndexOf(".");


    if (lastDot === -1) {
        return false;
    }


    const extension =
        lowerPath.substring(lastDot);


    return SUMMARY_FILE_EXTENSIONS.has(
        extension
    );
}


/* =========================================================
   GET FILE CONTENT
========================================================= */

/*
    GitHub tree gives us the SHA of each file.

    We use that SHA to retrieve the blob content.
*/
async function getFileContent(
    req,
    repository,
    fileSha
) {

    const owner =
        repository.owner.login;

    const repo =
        repository.name;


    const blob =
        await githubRequest(
            req,
            `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/blobs/${encodeURIComponent(fileSha)}`
        );


    if (
        blob.encoding === "base64"
    ) {

        return Buffer.from(
            blob.content,
            "base64"
        ).toString("utf-8");
    }


    return blob.content || "";
}


/* =========================================================
   GET ALL REPOSITORY FILES
========================================================= */

/*
    This is called only when we need to
    create/update project_summary.

    Returns:

    [
        {
            path: "backend/index.js",
            content: "..."
        },
        ...
    ]
*/
async function getRepositoryFiles(
    req,
    repository,
    treeResponse
) {

    const files = [];


    const tree =
        Array.isArray(
            treeResponse.tree
        )
            ? treeResponse.tree
            : [];


    const sourceFiles =
        tree.filter(
            (item) =>
                item.type === "blob" &&
                item.sha &&
                item.path &&
                shouldIncludeFile(
                    item.path
                )
        );


    console.log(
        `Fetching ${sourceFiles.length} repository files for project summary`
    );


    /*
        Fetch sequentially.

        This is slower than Promise.all(),
        but prevents sending a large number
        of simultaneous GitHub requests.
    */
    for (
        const file
        of sourceFiles
    ) {

        try {

            const content =
                await getFileContent(
                    req,
                    repository,
                    file.sha
                );


            /*
                Don't send empty files.
            */
            if (
                !content ||
                !content.trim()
            ) {
                continue;
            }


            files.push({

                path:
                    file.path,

                content:
                    content
            });


        } catch (error) {

            /*
                One unreadable file should not
                destroy project summary generation.
            */
            console.error(
                `Could not read ${file.path}:`,
                error.message
            );
        }
    }


    return files;
}


/* =========================================================
   PYTHON PROCESS
========================================================= */

/*
    Node.js calls the Python component.

    Data is sent as JSON through stdin.

    Python returns JSON through stdout.
*/
function callPython(
    component,
    data
) {

    return new Promise(
        (resolve, reject) => {

            const python =
                spawn(
                    PYTHON_BIN,
                    [component],
                    {
                        cwd:
                            RAG_COMPONENTS_PATH
                    }
                );


            let stdout = "";
            let stderr = "";


            python.stdout.on(
                "data",
                (chunk) => {

                    stdout +=
                        chunk.toString();
                }
            );


            python.stderr.on(
                "data",
                (chunk) => {

                    stderr +=
                        chunk.toString();
                }
            );


            python.on(
                "error",
                (error) => {

                    reject(error);
                }
            );


            python.on(
                "close",
                (exitCode) => {

                    if (
                        exitCode !== 0
                    ) {

                        return reject(
                            new Error(
                                stderr ||
                                `${component} exited with code ${exitCode}`
                            )
                        );
                    }


                    try {

                        const result =
                            JSON.parse(
                                stdout
                            );

                        resolve(result);

                    } catch (error) {

                        reject(
                            new Error(
                                `Invalid JSON returned by ${component}: ${stdout}`
                            )
                        );
                    }
                }
            );


            /*
                Send JSON input to Python.
            */
            python.stdin.write(
                JSON.stringify(data)
            );

            python.stdin.end();
        }
    );
}


/* =========================================================
   PROJECT SUMMARY
========================================================= */

/*
    Generate project summary using:

        repository structure
        +
        repository files
        +
        file contents
*/
async function generateProjectSummary({
    githubId,
    repoId,
    repositoryStructure,
    files
}) {

    console.log(
        `Generating project summary for ${githubId}:${repoId}`
    );


    const result =
        await callPython(
            "project_summary.py",
            {

                github_id:
                    githubId,

                repo_id:
                    String(repoId),

                repository_structure:
                    repositoryStructure,

                files:
                    files
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

/*
    Update chat summary after every question.

    We DO NOT send full chat history.

    We only send:

        previous summary
        current question
        current answer
*/
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


    const result =
        await callPython(
            "chat_summary.py",
            {

                github_id:
                    githubId,

                repo_id:
                    String(repoId),

                repository_structure:
                    repositoryStructure,

                previous_chat_summary:
                    previousSummary || "",

                current_query:
                    query,

                current_answer:
                    answer
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

/*
    Send the required context to the
    existing RAG orchestration.

    If chatSummary doesn't exist,
    an empty string is sent.
*/
async function askRAG({
    projectSummary,
    repositoryStructure,
    chatSummary,
    query,
    githubId,
    repoId,
    fileName
}) {

    const result =
        await callPython(
            "rag_index.py",
            {

                action:
                    "ask_question",

                project_context:
                    projectSummary,

                repository_structure:
                    repositoryStructure,

                summarized_chat_history:
                    chatSummary || "",

                query:
                    query,

                github_id:
                    githubId,

                repo_id:
                    String(repoId),

                file_name:
                    fileName
            }
        );


    if (
        !result ||
        typeof result.answer !== "string" ||
        !result.answer.trim()
    ) {

        throw new Error(
            "rag_index.py did not return a valid answer"
        );
    }


    return result.answer;
}


/* =========================================================
   POST /api/rag/chat
========================================================= */

router.post(
    "/chat",
    requireAuth,
    async (req, res) => {

        try {

            /* -----------------------------------------
               1. FRONTEND REQUEST
            ----------------------------------------- */

            const {
                repoId,
                fileName,
                query
            } = req.body;


            /* -----------------------------------------
               2. VALIDATE REQUEST
            ----------------------------------------- */

            if (!repoId) {

                return res.status(400).json({
                    error:
                        "repoId is required"
                });
            }


            if (
                !fileName ||
                typeof fileName !== "string"
            ) {

                return res.status(400).json({
                    error:
                        "fileName is required"
                });
            }


            if (
                !query ||
                typeof query !== "string" ||
                !query.trim()
            ) {

                return res.status(400).json({
                    error:
                        "query is required"
                });
            }


            /* -----------------------------------------
               3. CONNECT REDIS
            ----------------------------------------- */

            await connectRedis();


            /* -----------------------------------------
               4. USER
            ----------------------------------------- */

            const githubId =
                String(
                    req.user.githubId
                );


            /* -----------------------------------------
               5. RESOLVE REPOSITORY
            ----------------------------------------- */

            const repository =
                await getRepository(
                    req,
                    repoId
                );


            /* -----------------------------------------
               6. GET REPOSITORY TREE
            ----------------------------------------- */

            const treeResponse =
                await getRepositoryTree(
                    req,
                    repository
                );


            /* -----------------------------------------
               7. CREATE REPOSITORY STRUCTURE
            ----------------------------------------- */

            const repositoryStructure =
                createRepositoryStructure(
                    treeResponse
                );


            /* -----------------------------------------
               8. REDIS KEYS
            ----------------------------------------- */

            const keys =
                getRedisKeys(
                    githubId,
                    repoId
                );


            /* =================================================
               PROJECT SUMMARY
            ================================================= */

            /*
                Redis GET automatically returns null
                when the TTL has expired.
            */
            let projectSummary =
                await redis.get(
                    keys.projectSummary
                );


            /*
                If project summary doesn't exist:

                    1. Fetch repository files
                    2. Send structure + files to Python
                    3. Store summary for 24 hours
            */
            if (!projectSummary) {

                console.log(
                    `No valid project summary found for ${githubId}:${repoId}`
                );


                const repositoryFiles =
                    await getRepositoryFiles(
                        req,
                        repository,
                        treeResponse
                    );


                projectSummary =
                    await generateProjectSummary({

                        githubId,

                        repoId,

                        repositoryStructure,

                        files:
                            repositoryFiles
                    });


                /*
                    Store for exactly 24 hours.
                */
                await redis.set(
                    keys.projectSummary,
                    projectSummary,
                    {
                        EX:
                            PROJECT_SUMMARY_TTL
                    }
                );


                console.log(
                    `Project summary stored for 24 hours`
                );
            }


            /* =================================================
               CHAT SUMMARY
            ================================================= */

            /*
                Chat summary has NO TTL.

                If it exists:
                    use it.

                If it doesn't:
                    use empty string.

                We don't generate it before RAG.
            */
            const chatSummary =
                await redis.get(
                    keys.chatSummary
                );


            /* =================================================
               RAG QUERY
            ================================================= */

            /*
                fileName is additional context
                for the RAG layer.
            */
            const ragQuery = `
Selected file:
${fileName}

User question:
${query.trim()}
`;


            /* =================================================
               ASK RAG
            ================================================= */

            const answer =
                await askRAG({

                    projectSummary,

                    repositoryStructure,

                    chatSummary:
                        chatSummary || "",

                    query:
                        ragQuery,

                    githubId,

                    repoId,

                    fileName
                });


            /* =================================================
               UPDATE CHAT SUMMARY
            ================================================= */

            /*
                AFTER every successful answer:

                    previous summary
                         +
                    current question
                         +
                    current answer
                         ↓
                    chat_summary.py
                         ↓
                    new summary
            */

            const updatedChatSummary =
                await generateChatSummary({

                    githubId,

                    repoId,

                    repositoryStructure,

                    previousSummary:
                        chatSummary || "",

                    query:
                        query.trim(),

                    answer:
                        answer
                });


            /* =================================================
               SAVE CHAT SUMMARY
            ================================================= */

            /*
                No TTL.

                This summary remains until
                it is updated by the next query.
            */
            await redis.set(
                keys.chatSummary,
                updatedChatSummary
            );


            /* =================================================
               RESPONSE TO FRONTEND
            ================================================= */

            return res.json({
                answer
            });

        } catch (error) {

            console.error(
                "Chat request failed:",
                error
            );


            /* -----------------------------------------
               Known errors
            ----------------------------------------- */

            if (
                error.status === 400
            ) {

                return res.status(400).json({
                    error:
                        error.message
                });
            }


            if (
                error.status === 401
            ) {

                return res.status(401).json({
                    error:
                        "GitHub authentication expired"
                });
            }


            if (
                error.status === 403
            ) {

                return res.status(403).json({
                    error:
                        "GitHub repository access denied"
                });
            }


            if (
                error.status === 404
            ) {

                return res.status(404).json({
                    error:
                        "Repository not found"
                });
            }


            /* -----------------------------------------
               Unknown errors
            ----------------------------------------- */

            return res.status(500).json({
                error:
                    "Failed to process chat request"
            });
        }
    }
);


/* =========================================================
   EXPORT
========================================================= */

export default router;
