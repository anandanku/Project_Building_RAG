from chunker import chunker
from vector_store import store_chunks
from retriver import retrieve_chunks
from send_to_llm import retrieve_info


def ingest_file(code, github_id, repo_id, file_path):
    chunks = chunker(
        code=code,
        github_id=github_id,
        repo_id=repo_id,
        file_name=file_path
    )

    store_chunks(
        chunks=chunks,
        github_id=github_id,
        repo_id=repo_id
    )


def ask_question(
    project_context,
    repository_structure,
    summarized_chat_history,
    query,
    github_id,
    repo_id,
    top_k=2
):
    results = retrieve_chunks(
        query=query,
        github_id=github_id,
        repo_id=repo_id,
        top_k=top_k
    )

    relevant_files = []

    for match in results.get("matches", []):
        metadata = match.get("metadata", {})
        content = metadata.get("content", "")

        relevant_files.append(
            f"""
================ FILE ================

File: {metadata.get("file_path", metadata.get("file_name", "Unknown"))}
Language: {metadata.get("language", "Unknown")}
Chunk: {metadata.get("chunk_index", "Unknown")}

{content}
"""
        )

    relevant_files = "\n".join(relevant_files)

    return retrieve_info(
        project_context=project_context,
        repository_structure=repository_structure,
        relevant_files=relevant_files,
        summarized_chat_history=summarized_chat_history,
        query=query
    )


def main():
    import json
    import sys

    try:
        payload = json.load(sys.stdin)

        if payload.get("action") != "ask_question":
            raise ValueError("Unsupported action")

        answer = ask_question(
            project_context=payload.get("project_context", ""),
            repository_structure=payload.get("repository_structure", ""),
            summarized_chat_history=payload.get("summarized_chat_history", ""),
            query=payload.get("query", ""),
            github_id=payload["github_id"],
            repo_id=payload["repo_id"],
            top_k=payload.get("top_k", 5)
        )

        print(json.dumps({"answer": answer}, ensure_ascii=False))

    except Exception as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False))
        sys.exit(1)


if __name__ == "__main__":
    main()
