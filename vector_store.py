from embedding import generate_embedding
from pinecone_db import index


def store_chunks(chunks, github_id, repo_id):

    namespace = f"{github_id}_{repo_id}"

    vectors = []

    for chunk in chunks:

        vector = generate_embedding(
            chunk.page_content
        )

        metadata = chunk.metadata

        vector_id = (
            f"{namespace}_"
            f"{metadata['file_name']}_"
            f"{metadata['chunk_index']}"
        )

        vectors.append({
            "id": vector_id,
            "values": vector,
            "metadata": metadata,
            "content":chunk.page_content
        })

    index.upsert(
        vectors=vectors,
        namespace=namespace
    )