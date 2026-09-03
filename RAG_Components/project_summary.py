import json
import sys

from langchain_core.prompts import ChatPromptTemplate
from langchain_google_genai import ChatGoogleGenerativeAI
from dotenv import load_dotenv

load_dotenv()

# Keep this model consistent with the existing RAG pipeline.
llm = ChatGoogleGenerativeAI(
    model="gemini-3.7-flash",
    temperature=0.1,
)

prompt = ChatPromptTemplate.from_template(
    """
You are a senior software engineer creating a persistent project summary
for a code-understanding RAG system.

Your job is to understand the repository from the supplied structure and
source files, then produce a concise but information-dense summary that can
be reused as context for future questions.

================ REPOSITORY STRUCTURE ================

{repository_structure}

================ REPOSITORY FILES ================

{files}

================ INSTRUCTIONS ================

Create a project-level summary.

Focus on information that will remain useful across many future questions:

1. What the project does and its main purpose.
2. The overall architecture and major components.
3. Important backend/frontend/RAG components and their responsibilities.
4. Important data flow, especially how a user request moves through the system.
5. Important storage, retrieval, caching, authentication, and external-service
   integrations that are visible in the supplied code.
6. Important relationships/dependencies between files.
7. Important configuration or environment-variable expectations when visible.
8. Important implementation decisions and constraints.
9. Anything that is clearly incomplete, unusual, or potentially important for
   future development.

Do NOT:
- invent functionality that is not present in the supplied repository context;
- claim that a library/service is used unless the code shows it;
- include long code blocks;
- include every function or implementation detail;
- include secrets, tokens, or credentials.

The summary should be structured with short headings and concise bullet points.
Prefer concrete file names when they help explain architecture.

This summary is persistent context, so prioritize stable project knowledge over
temporary observations.

Return ONLY the summary text.

Summary:
"""
)

chain = prompt | llm


def generate_project_summary(repository_structure, files):
    """
    Generate a stable project-level summary from repository structure and files.

    Args:
        repository_structure: Text representation of the GitHub repository tree.
        files: List of dictionaries with:
            {"path": "...", "content": "..."}

    Returns:
        str: Generated project summary.
    """
    if not repository_structure:
        raise ValueError("repository_structure is required")

    if not isinstance(files, list):
        raise ValueError("files must be a list")

    file_context = []

    for file in files:
        if not isinstance(file, dict):
            continue

        path = file.get("path")
        content = file.get("content")

        if not path or not content:
            continue

        file_context.append(
            f"""
================ FILE ================

Path: {path}

{content}
"""
        )

    if not file_context:
        raise ValueError("No repository files were supplied")

    response = chain.invoke(
        {
            "repository_structure": repository_structure,
            "files": "\n".join(file_context),
        }
    )

    summary = response.content

    if isinstance(summary, list):
        summary = "\n".join(
            item.get("text", str(item))
            if isinstance(item, dict)
            else str(item)
            for item in summary
        )

    summary = str(summary).strip()

    if not summary:
        raise ValueError("LLM returned an empty project summary")

    return summary


def main():
    """
    Node.js sends JSON through stdin and expects JSON through stdout.
    """
    try:
        payload = json.load(sys.stdin)

        summary = generate_project_summary(
            repository_structure=payload.get("repository_structure", ""),
            files=payload.get("files", []),
        )

        print(
            json.dumps(
                {"summary": summary},
                ensure_ascii=False,
            )
        )

    except Exception as error:
        print(
            json.dumps(
                {"error": str(error)},
                ensure_ascii=False,
            )
        )
        sys.exit(1)


if __name__ == "__main__":
    main()
