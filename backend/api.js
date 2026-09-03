import express from "express";
import { createClient } from "redis";
import dotenv from "dotenv";
import { spawn } from "child_process";

dotenv.config();

const router = express.Router();

/* ============================================================
   CONFIGURATION
   ============================================================ */

const PYTHON_BIN = process.env.PYTHON_BIN || "python";

const RAG_COMPONENTS_PATH =
  process.env.RAG_COMPONENTS_PATH ||
  "../RAG_Components";


/* ============================================================
   REDIS CONNECTION
   ============================================================ */

const redis = createClient({
  url: process.env.REDIS_URL,
});

redis.on("error", (error) => {
  console.error("Redis Error:", error);
});

async function connectRedis() {
  if (!redis.isOpen) {
    await redis.connect();
    console.log("Redis Connected");
  }
}

connectRedis().catch((error) => {
  console.error("Redis Connection Error:", error);
});


/* ============================================================
   REDIS KEYS
   ============================================================ */

function projectSummaryKey(githubId, repoId) {
  return `project_summary:${githubId}:${repoId}`;
}

function chatSummaryKey(githubId, repoId) {
  return `chat_summary:${githubId}:${repoId}`;
}

function chatHistoryKey(githubId, repoId) {
  return `chat_history:${githubId}:${repoId}`;
}

function indexingLockKey(githubId, repoId) {
  return `indexing_lock:${githubId}:${repoId}`;
}


/* ============================================================
   AUTHENTICATION MIDDLEWARE
   ============================================================ */

function requireAuth(req, res, next) {

  if (!req.isAuthenticated || !req.isAuthenticated()) {
    return res.status(401).json({
      error: "Unauthorized",
      message: "GitHub authentication required.",
    });
  }

  if (!req.user?.githubId) {
    return res.status(401).json({
      error: "Invalid session",
      message: "GitHub user information is missing.",
    });
  }

  if (!req.user?.accessToken) {
    return res.status(401).json({
      error: "Invalid session",
      message: "GitHub access token is missing.",
    });
  }

  next();
}


/* ============================================================
   GITHUB API HELPER
   ============================================================ */

async function githubRequest(accessToken, endpoint) {

  const response = await fetch(
    `https://api.github.com${endpoint}`,
    {
      method: "GET",

      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${accessToken}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    }
  );

  const data = await response.json();

  if (!response.ok) {

    const error = new Error(
      data?.message ||
      "GitHub API request failed."
    );

    error.status = response.status;

    throw error;
  }

  return data;
}


/* ============================================================
   RESOLVE REPOSITORY
   ============================================================ */

/*
   Frontend sends only:

       repoId

   We resolve the repository using the authenticated
   GitHub access token.

   This prevents users from supplying arbitrary
   owner/repository combinations.
*/

async function resolveRepository(req, repoId) {

  if (!repoId) {

    const error = new Error(
      "Repository ID is required."
    );

    error.status = 400;

    throw error;
  }

  if (!/^\d+$/.test(String(repoId))) {

    const error = new Error(
      "Invalid repository ID."
    );

    error.status = 400;

    throw error;
  }

  return await githubRequest(
    req.user.accessToken,
    `/repositories/${repoId}`
  );
}


/* ============================================================
   GET REPOSITORY TREE
   ============================================================ */

async function getRepositoryTree(
  req,
  repository
) {

  const branch =
    repository.default_branch || "main";

  return await githubRequest(
    req.user.accessToken,

    `/repos/${repository.full_name}/git/trees/${encodeURIComponent(
      branch
    )}?recursive=1`
  );
}


/* ============================================================
   TREE → TEXT
   ============================================================ */

function treeToText(tree) {

  if (!tree?.tree) {
    return "";
  }

  return tree.tree
    .map((item) => {

      if (item.type === "tree") {
        return `[DIR]  ${item.path}`;
      }

      return `[FILE] ${item.path}`;

    })
    .join("\n");
}


/* ============================================================
   PYTHON RUNNER
   ============================================================ */

/*
   We already have Python RAG components.

   Instead of creating another RAG implementation in Node,
   Node invokes the existing Python functions.

   This allows us to use:

       rag_index.py
           ↓
       ingest_file()
           ↓
       ask_question()

   directly.
*/

function runPython(code, payload) {

  return new Promise((resolve, reject) => {

    const python = spawn(
      PYTHON_BIN,
      ["-c", code],
      {
        cwd: RAG_COMPONENTS_PATH,
        env: process.env,
      }
    );

    let stdout = "";
    let stderr = "";

    python.stdout.on(
      "data",
      (data) => {
        stdout += data.toString();
      }
    );

    python.stderr.on(
      "data",
      (data) => {
        stderr += data.toString();
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

        if (exitCode !== 0) {

          return reject(
            new Error(
              `Python process failed.\n${stderr}`
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
              `Invalid JSON returned by Python.\n${stdout}`
            )
          );
        }
      }
    );

    python.stdin.write(
      JSON.stringify(payload)
    );

    python.stdin.end();
  });
}


/* ============================================================
   CHECK PINECONE INDEXING STATUS
   ============================================================ */

/*
   Your vector_store.py uses:

       namespace = f"{github_id}_{repo_id}"

   Therefore we check that exact namespace.

   We use Pinecone's namespace statistics rather than
   maintaining a second "embedding exists" database.
*/

async function isRepositoryIndexed(
  githubId,
  repoId
) {

  const result = await runPython(
    `
import sys
import json

from pinecone_db import index

payload = json.load(sys.stdin)

github_id = payload["githubId"]
repo_id = payload["repoId"]

namespace = f"{github_id}_{repo_id}"

stats = index.describe_index_stats()

namespaces = stats.get("namespaces", {})

namespace_info = namespaces.get(
    namespace,
    {}
)

vector_count = namespace_info.get(
    "vector_count",
    0
)

print(json.dumps({
    "indexed": vector_count > 0,
    "vectorCount": vector_count,
    "namespace": namespace
}))
`,
    {
      githubId,
      repoId: String(repoId),
    }
  );

  return result;
}


/* ============================================================
   FILE TYPES THAT SHOULD BE EMBEDDED
   ============================================================ */

/*
   Do not try to embed images, videos, binaries, etc.

   This list can be expanded later.
*/

const EMBEDDABLE_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".ts",
  ".tsx",

  ".py",

  ".java",
  ".c",
  ".h",
  ".cpp",
  ".hpp",
  ".cc",
  ".cxx",

  ".go",
  ".rs",
  ".php",
  ".rb",

  ".html",
  ".css",
  ".scss",
  ".sass",

  ".json",
  ".yaml",
  ".yml",
  ".xml",

  ".md",
  ".txt",

  ".sql",

  ".sh",
  ".bash",

  ".env.example",
  ".gitignore",
]);


/* ============================================================
   SHOULD EMBED FILE?
   ============================================================ */

function shouldEmbedFile(filePath) {

  const lowerPath =
    filePath.toLowerCase();

  /*
     Ignore common generated/dependency folders.
  */

  const ignoredDirectories = [
    "node_modules/",
    ".git/",
    "dist/",
    "build/",
    "__pycache__/",
    ".venv/",
    "venv/",
    "coverage/",
    ".next/",
    "target/",
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

  const lastDot =
    lowerPath.lastIndexOf(".");

  if (lastDot === -1) {
    return false;
  }

  const extension =
    lowerPath.substring(lastDot);

  return EMBEDDABLE_EXTENSIONS.has(
    extension
  );
}


/* ============================================================
   GET FILE CONTENT FROM GITHUB
   ============================================================ */

async function getGitHubFile(
  req,
  repository,
  filePath
) {

  /*
     Encode every path segment separately.

     Example:

         backend/auth.js

     becomes:

         backend/auth.js

     while special characters are safely encoded.
  */

  const encodedPath =
    filePath
      .split("/")
      .map(
        (segment) =>
          encodeURIComponent(segment)
      )
      .join("/");

  return await githubRequest(
    req.user.accessToken,

    `/repos/${repository.full_name}/contents/${encodedPath}`
  );
}


/* ============================================================
   GET FILE CONTENT AS UTF-8
   ============================================================ */

async function getFileContent(
  req,
  repository,
  filePath
) {

  const file =
    await getGitHubFile(
      req,
      repository,
      filePath
    );

  if (Array.isArray(file)) {

    const error = new Error(
      "Requested path is a directory."
    );

    error.status = 400;

    throw error;
  }

  if (!file.content) {
    return "";
  }

  if (
    file.encoding === "base64"
  ) {

    return Buffer.from(
      file.content.replace(/\n/g, ""),
      "base64"
    ).toString("utf-8");
  }

  return file.content;
}


/* ============================================================
   INGEST ONE FILE
   ============================================================ */

/*
   Calls the EXISTING:

       rag_index.py
           ingest_file()

   which internally does:

       chunker()
           ↓
       store_chunks()
           ↓
       embedding()
           ↓
       Pinecone
*/

async function ingestFile(
  code,
  githubId,
  repoId,
  filePath
) {

  return await runPython(
    `
import sys
import json

from rag_index import ingest_file

payload = json.load(sys.stdin)

ingest_file(
    code=payload["code"],
    github_id=payload["githubId"],
    repo_id=payload["repoId"],
    file_path=payload["filePath"]
)

print(json.dumps({
    "success": True,
    "filePath": payload["filePath"]
}))
`,
    {
      code,
      githubId,
      repoId: String(repoId),
      filePath,
    }
  );
}


/* ============================================================
   INDEX ENTIRE REPOSITORY
   ============================================================ */

async function indexRepository(
  req,
  repository,
  tree
) {

  const githubId =
    String(req.user.githubId);

  const repoId =
    String(repository.id);

  /*
     Prevent multiple simultaneous requests from
     indexing the same repository.
  */

  const lockKey =
    indexingLockKey(
      githubId,
      repoId
    );

  const lockAcquired =
    await redis.set(
      lockKey,
      "1",
      {
        NX: true,
        EX: 600,
      }
    );

  /*
     Another request is currently indexing.

     Wait until that process finishes.
  */

  if (!lockAcquired) {

    console.log(
      `Repository ${repoId} is already being indexed.`
    );

    for (
      let attempt = 0;
      attempt < 120;
      attempt++
    ) {

      await new Promise(
        (resolve) =>
          setTimeout(resolve, 1000)
      );

      const currentStatus =
        await isRepositoryIndexed(
          githubId,
          repoId
        );

      if (
        currentStatus.indexed
      ) {
        return currentStatus;
      }
    }

    throw new Error(
      "Repository indexing timeout."
    );
  }

  try {

    /*
       Check again after acquiring the lock.

       Another request might have finished indexing
       before we acquired it.
    */

    const currentStatus =
      await isRepositoryIndexed(
        githubId,
        repoId
      );

    if (currentStatus.indexed) {
      return currentStatus;
    }

    const files =
      (tree.tree || [])
        .filter(
          (item) =>
            item.type === "blob"
        )
        .filter(
          (item) =>
            shouldEmbedFile(item.path)
        );

    console.log(
      `Indexing ${files.length} files for ${repository.full_name}`
    );

    let indexedFiles = 0;

    /*
       Process sequentially.

       This avoids hammering GitHub and the embedding API
       with a huge amount of parallel work.
    */

    for (
      const file
      of files
    ) {

      try {

        console.log(
          `Embedding: ${file.path}`
        );

        const code =
          await getFileContent(
            req,
            repository,
            file.path
          );

        /*
           Skip empty files.
        */

        if (
          !code ||
          !code.trim()
        ) {
          continue;
        }

        await ingestFile(
          code,
          githubId,
          repoId,
          file.path
        );

        indexedFiles++;

      } catch (error) {

        /*
           One unsupported/problematic file should not
           destroy the entire repository indexing process.
        */

        console.error(
          `Failed to index ${file.path}:`,
          error.message
        );
      }
    }

    /*
       Verify Pinecone actually contains vectors.
    */

    const finalStatus =
      await isRepositoryIndexed(
        githubId,
        repoId
      );

    if (
      !finalStatus.indexed
    ) {

      throw new Error(
        "Repository indexing completed but no embeddings were found in Pinecone."
      );
    }

    return {
      ...finalStatus,
      indexedFiles,
      totalFiles: files.length,
    };

  } finally {

    await redis.del(lockKey);
  }
}


/* ============================================================
   GET /api/repositories
   ============================================================ */

router.get(
  "/repositories",
  requireAuth,

  async (req, res) => {

    try {

      const repositories = [];

      let page = 1;

      while (true) {

        const pageData =
          await githubRequest(
            req.user.accessToken,

            `/user/repos?per_page=100&page=${page}&sort=updated`
          );

        if (
          !Array.isArray(pageData)
        ) {
          break;
        }

        repositories.push(
          ...pageData
        );

        if (
          pageData.length < 100
        ) {
          break;
        }

        page++;
      }

      const result =
        repositories.map(
          (repo) => ({
            id: repo.id,
            name: repo.name,
            full_name: repo.full_name,
            private: repo.private,
            default_branch:
              repo.default_branch,
          })
        );

      return res.status(200).json(
        result
      );

    } catch (error) {

      console.error(
        "GET /api/repositories:",
        error
      );

      return res
        .status(error.status || 500)
        .json({
          error:
            "Failed to fetch repositories.",
          message:
            error.message,
        });
    }
  }
);


/* ============================================================
   GET /api/repositories/:repoId/tree
   ============================================================ */

router.get(
  "/repositories/:repoId/tree",
  requireAuth,

  async (req, res) => {

    try {

      const {
        repoId
      } = req.params;

      const repository =
        await resolveRepository(
          req,
          repoId
        );

      const tree =
        await getRepositoryTree(
          req,
          repository
        );

      return res.status(200).json(
        tree
      );

    } catch (error) {

      console.error(
        "GET /api/repositories/:repoId/tree:",
        error
      );

      return res
        .status(error.status || 500)
        .json({
          error:
            "Failed to fetch repository tree.",
          message:
            error.message,
        });
    }
  }
);


/* ============================================================
   GET /api/repositories/:repoId/file?path=...
   ============================================================ */

router.get(
  "/repositories/:repoId/file",
  requireAuth,

  async (req, res) => {

    try {

      const {
        repoId
      } = req.params;

      const {
        path: filePath
      } = req.query;

      if (!filePath) {

        return res.status(400).json({
          error:
            "File path is required.",
        });
      }

      const repository =
        await resolveRepository(
          req,
          repoId
        );

      const content =
        await getFileContent(
          req,
          repository,
          filePath
        );

      return res.status(200).json({
        path: filePath,
        content,
        encoding: "utf-8",
      });

    } catch (error) {

      console.error(
        "GET /api/repositories/:repoId/file:",
        error
      );

      return res
        .status(error.status || 500)
        .json({
          error:
            "Failed to fetch file.",
          message:
            error.message,
        });
    }
  }
);


/* ============================================================
   POST /api/rag/chat
   ============================================================ */

router.post(
  "/rag/chat",
  requireAuth,

  async (req, res) => {

    try {

      const {
        repoId,
        fileName,
        query,
      } = req.body;

      /* --------------------------------------------------------
         VALIDATION
         -------------------------------------------------------- */

      if (!repoId) {

        return res.status(400).json({
          error:
            "repoId is required.",
        });
      }

      if (
        !query ||
        !query.trim()
      ) {

        return res.status(400).json({
          error:
            "query is required.",
        });
      }


      /* --------------------------------------------------------
         RESOLVE REPOSITORY
         -------------------------------------------------------- */

      const repository =
        await resolveRepository(
          req,
          repoId
        );


      /* --------------------------------------------------------
         GET REPOSITORY TREE
         -------------------------------------------------------- */

      const tree =
        await getRepositoryTree(
          req,
          repository
        );

      const repositoryStructure =
        treeToText(tree);


      /* --------------------------------------------------------
         CHECK EMBEDDINGS
         -------------------------------------------------------- */

      const githubId =
        String(req.user.githubId);

      const embeddingStatus =
        await isRepositoryIndexed(
          githubId,
          repoId
        );


      /* --------------------------------------------------------
         INDEX IF REQUIRED
         -------------------------------------------------------- */

      let indexingStatus =
        embeddingStatus;

      if (
        !embeddingStatus.indexed
      ) {

        console.log(
          `No embeddings found for ${repository.full_name}. Starting indexing...`
        );

        indexingStatus =
          await indexRepository(
            req,
            repository,
            tree
          );

      } else {

        console.log(
          `Embeddings already exist for ${repository.full_name}. Skipping indexing.`
        );
      }


      /* --------------------------------------------------------
         GET EXISTING SUMMARIES FROM REDIS
         -------------------------------------------------------- */

      /*
         The summary generators are NOT implemented yet.

         Therefore we only read whatever may already exist.

         Later:

             projectsummary.py
             chatsummary.py

         will populate/update these values.
      */

      const [
        projectSummary,
        chatSummary,
      ] = await Promise.all([
        redis.get(
          projectSummaryKey(
            githubId,
            repoId
          )
        ),

        redis.get(
          chatSummaryKey(
            githubId,
            repoId
          )
        ),
      ]);


      /* --------------------------------------------------------
         CURRENT CHAT HISTORY
         -------------------------------------------------------- */

      const historyKey =
        chatHistoryKey(
          githubId,
          repoId
        );

      const chatHistory =
        await redis.lRange(
          historyKey,
          0,
          -1
        );


      /* --------------------------------------------------------
         EXECUTE EXISTING RAG PIPELINE
         -------------------------------------------------------- */

      /*
         Existing rag_index.py expects:

             project_context
             repository_structure
             summarized_chat_history
             query
             github_id
             repo_id

         See your existing ask_question() implementation.
      */

      const ragResult =
        await runPython(
          `
import sys
import json

from rag_index import ask_question

payload = json.load(sys.stdin)

answer = ask_question(
    project_context=payload["projectContext"],
    repository_structure=payload["repositoryStructure"],
    summarized_chat_history=payload["chatSummary"],
    query=payload["query"],
    github_id=payload["githubId"],
    repo_id=payload["repoId"]
)

print(json.dumps({
    "answer": answer
}))
`,
          {
            projectContext:
              projectSummary || "",

            repositoryStructure,

            chatSummary:
              chatSummary || "",

            query:
              query.trim(),

            githubId,

            repoId:
              String(repoId),
          }
        );


      const answer =
        ragResult.answer || "";


      /* --------------------------------------------------------
         STORE CONVERSATION IN REDIS
         -------------------------------------------------------- */

      const conversation =
        JSON.stringify({
          question:
            query.trim(),

          answer,

          fileName:
            fileName || null,

          timestamp:
            new Date().toISOString(),
        });

      await redis.rPush(
        historyKey,
        conversation
      );


      /* --------------------------------------------------------
         SUMMARY UPDATE HOOK
         -------------------------------------------------------- */

      /*
         DO NOT GENERATE SUMMARIES HERE YET.

         We will add:

             projectsummary.py
             chatsummary.py

         later.

         At that point this section becomes:

             1. current query executed
             2. answer generated
             3. Q&A stored in Redis
             4. project summary updated
             5. chat summary updated
      */


      /* --------------------------------------------------------
         RESPONSE
         -------------------------------------------------------- */

      return res.status(200).json({
        answer,
      });

    } catch (error) {

      console.error(
        "POST /api/rag/chat:",
        error
      );

      return res
        .status(error.status || 500)
        .json({
          error:
            "RAG request failed.",
          message:
            error.message,
        });
    }
  }
);


/* ============================================================
   EXPORT
   ============================================================ */

export default router;
