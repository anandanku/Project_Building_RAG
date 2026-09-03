from chunker import chunker
from vector_store import store_chunks
from retriver import retrieve_chunks
from send_to_llm import retrieve_info


def ingest_file(code, github_id, repo_id, file_path):

    chunks = chunker(
        code=code,
        github_id=github_id,
        repo_id=repo_id,
        file_path=file_path
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
    top_k=5
):

    results = retrieve_chunks(
        query=query,
        github_id=github_id,
        repo_id=repo_id,
        top_k=top_k
    )

    relevant_files = []

    for match in results["matches"]:

        metadata = match["metadata"]

        relevant_files.append(
            f"""
================ FILE ================

File: {metadata.get("file_path", "Unknown")}
Language: {metadata.get("language", "Unknown")}
Chunk: {metadata.get("chunk_index", "Unknown")}

{metadata.get("content", "")}
"""
        )

    relevant_files = "\n".join(relevant_files)

    answer = retrieve_info(
        project_context=project_context,
        repository_structure=repository_structure,
        relevant_files=relevant_files,
        summarized_chat_history=summarized_chat_history,
        query=query
    )

    return answer