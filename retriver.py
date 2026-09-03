from embedding import generate_embedding
from pinecone_db import index


def retrieve_chunks(query, github_id, repo_id, top_k=5):

    # Convert user query into an embedding
    query_vector = generate_embedding(query)

    # Repository-specific namespace
    namespace = f"{github_id}_{repo_id}"

    # Search Pinecone
    results = index.query(
        namespace=namespace,
        vector=query_vector,
        top_k=top_k,
        include_metadata=True
    )

    return results